use super::{
    bytes_to_os,
    process::{execute, mac_git_path},
    trim_line, GitError, Repo, Result, OUTPUT_LIMIT,
};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};

// Use installed programs from macOS package locations. Nothing in a repository
// should be able to supply the executable that will receive the passphrase.
const PINENTRY: &[&str] = &[
    "/opt/homebrew/bin/pinentry-mac",
    "/usr/local/bin/pinentry-mac",
    "/usr/local/MacGPG2/libexec/pinentry-mac.app/Contents/MacOS/pinentry-mac",
    "/opt/local/bin/pinentry-mac",
];
const GPG_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/MacGPG2/bin",
    "/opt/local/bin",
];

fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
}

fn signer_path(repo: &Repo) -> Result<PathBuf> {
    // Git reads both names as the same OpenPGP option in configuration order.
    let mut config = repo.command();
    config.args([
        "config",
        "--null",
        "--get-regexp",
        r"^gpg\.(program|openpgp\.program|format)$",
    ]);
    let output = execute(config, &[1], None)?;
    if output.truncated {
        return Err("tooMuchData".into());
    }
    let mut format = &b"openpgp"[..];
    let mut program = &b"gpg"[..];
    for record in output.bytes.split(|&b| b == 0) {
        let mut fields = record.splitn(2, |&b| b == b'\n');
        match (fields.next(), fields.next()) {
            (Some(b"gpg.format"), Some(value)) => format = value,
            (Some(b"gpg.program" | b"gpg.openpgp.program"), Some(value)) => program = value,
            _ => {}
        }
    }
    if format != b"openpgp" {
        return Err("macGpgconfMissing".into());
    }
    let program = PathBuf::from(bytes_to_os(program)?);
    if program.as_os_str().as_encoded_bytes().contains(&b'/') {
        return Ok(repo.root().join(program));
    }
    // Git prepends its exec directory to the PATH supplied by Diffinch.
    let exec_dir = repo.text(["--exec-path"])?;
    std::iter::once(PathBuf::from(exec_dir))
        .chain(env::split_paths(&mac_git_path()))
        .map(|dir| repo.root().join(dir).join(&program))
        .find(|path| executable(path))
        .ok_or("macGpgconfMissing".into())
}

fn matching_gpgconf(signer: &Path, known_dirs: &[&str]) -> Option<PathBuf> {
    let signer = signer.canonicalize().ok()?;
    let sibling = signer.with_file_name("gpgconf").canonicalize().ok()?;
    for dir in known_dirs.iter().map(Path::new) {
        let gpgconf = dir.join("gpgconf");
        if executable(&gpgconf)
            && gpgconf.canonicalize().is_ok_and(|path| path == sibling)
            && ["gpg", "gpg2"].iter().any(|name| {
                dir.join(name)
                    .canonicalize()
                    .is_ok_and(|path| path == signer)
            })
        {
            return Some(gpgconf);
        }
    }
    None
}

pub(super) fn configure(repo: &Repo) -> Result<()> {
    let gpgconf = matching_gpgconf(&signer_path(repo)?, GPG_BIN_DIRS).ok_or("macGpgconfMissing")?;
    let pinentry = PINENTRY
        .iter()
        .find(|path| executable(Path::new(path)))
        .ok_or("macPinentryMissing")?;
    configure_agent(&gpgconf, pinentry, repo.root())
}

fn configure_agent(gpgconf: &Path, pinentry: &str, signing_dir: &Path) -> Result<()> {
    let mut locate = Command::new(gpgconf);
    // GnuPG resolves a relative GNUPGHOME in the signer's working directory.
    locate
        .current_dir(signing_dir)
        .args(["--list-dirs", "homedir"]);
    let output = execute(locate, &[], None)?;
    let home = bytes_to_os(trim_line(&output.bytes))?;
    let home = Path::new(&home);
    if output.truncated || !home.is_absolute() || !home.is_dir() {
        return Err("macGpgHomeMissing".into());
    }
    set_pinentry(&home.join("gpg-agent.conf"), pinentry)
        .map_err(|err| GitError::new("macPinentryWriteFailed", err))?;

    let mut reload = Command::new(gpgconf);
    reload
        .current_dir("/")
        .arg("--homedir")
        .arg(home)
        .args(["--reload", "gpg-agent"]);
    execute(reload, &[], None).map_err(|error| {
        if error.key == "transferCancelled" {
            error
        } else {
            "macPinentryReloadFailed".into()
        }
    })?;
    Ok(())
}

fn set_pinentry(config: &Path, pinentry: &str) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(config)?;
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    write_pinentry(file, pinentry)
}

fn write_pinentry(mut file: File, pinentry: &str) -> io::Result<()> {
    file.try_lock()?;
    let result = append_pinentry(&mut file, pinentry);
    // A concurrently forked child can briefly hold the same open file description
    // after our descriptor closes. Release the lock before another setup retries.
    result.and(file.unlock())
}

fn append_pinentry(file: &mut File, pinentry: &str) -> io::Result<()> {
    // Only the last setting matters. A setting outside this window can safely
    // be restated at EOF without loading an arbitrarily large config.
    let offset = file.metadata()?.len().saturating_sub(OUTPUT_LIMIT as u64);
    file.seek(SeekFrom::Start(offset))?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    let setting = format!("pinentry-program {pinentry}");
    // GnuPG uses the last setting. Append an override so comments, permissions
    // and existing settings survive. A retry after a failed reload is idempotent.
    let mut lines = contents.split(|&byte| byte == b'\n');
    if offset > 0 {
        lines.next(); // The first line may be incomplete.
    }
    let last = lines
        .map(<[u8]>::trim_ascii)
        .rfind(|line| line.split(|b| b.is_ascii_whitespace()).next() == Some(b"pinentry-program"));
    if last != Some(setting.as_bytes()) {
        let separator = if contents.is_empty() || contents.ends_with(b"\n") {
            ""
        } else {
            "\n"
        };
        file.write_all(format!("{separator}{setting}\n").as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{tests::repo, Action};
    use super::*;

    #[test]
    fn matches_gpgconf_to_the_configured_signer_across_installations() {
        let (temp, repo) = repo();
        let install = |name: &str| {
            let dir = temp.path().join(name);
            fs::create_dir(&dir).unwrap();
            for tool in ["gpg", "gpgconf"] {
                let path = dir.join(tool);
                fs::write(&path, "#!/bin/sh\nexit 1\n").unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            }
            dir
        };
        let first = install("first");
        let second = install("second installation");
        let known = [first.to_str().unwrap(), second.to_str().unwrap()];
        repo.run([
            "config",
            "gpg.openpgp.program",
            first.join("gpg").to_str().unwrap(),
        ])
        .unwrap();
        repo.run(["config", "gpg.format", "openpgp"]).unwrap();
        repo.run([
            "config",
            "gpg.program",
            second.join("gpg").to_str().unwrap(),
        ])
        .unwrap();
        let signer = signer_path(&repo).unwrap();
        assert_eq!(
            matching_gpgconf(&signer, &known),
            Some(second.join("gpgconf"))
        );

        // A wrapper may select its own home directory. There is no safe inference
        // from that wrapper to one of the installed agents.
        let wrapper = install("wrapper").join("gpg");
        repo.run(["config", "gpg.program", wrapper.to_str().unwrap()])
            .unwrap();
        assert!(matching_gpgconf(&signer_path(&repo).unwrap(), &known).is_none());

        fs::remove_file(second.join("gpgconf")).unwrap();
        assert!(matching_gpgconf(&signer, &known).is_none());
    }

    #[test]
    fn configures_an_existing_agent_without_losing_settings_or_duplicating_the_override() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("gpg-agent.conf");
        let original =
            "# pinentry-program example\npinentry-program /old/pinentry-tty\ndefault-cache-ttl 600";
        fs::write(&config, original).unwrap();
        for _ in 0..2 {
            set_pinentry(&config, "/test/pinentry-mac").unwrap();
        }
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{original}\npinentry-program /test/pinentry-mac\n")
        );
    }

    #[test]
    fn releases_the_config_lock_even_while_another_descriptor_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("gpg-agent.conf");
        let file = File::create_new(&config).unwrap();
        let _inherited = file.try_clone().unwrap();
        write_pinentry(file, "/test/pinentry-mac").unwrap();
        set_pinentry(&config, "/test/pinentry-mac").unwrap();
    }

    #[test]
    fn preserves_large_configs_and_only_appends_the_override_once() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("gpg-agent.conf");
        let mut bytes = vec![b' '; OUTPUT_LIMIT + 1];
        fs::write(&config, &bytes).unwrap();
        for _ in 0..2 {
            set_pinentry(&config, "/test/pinentry-mac").unwrap();
        }
        bytes.extend_from_slice(b"\npinentry-program /test/pinentry-mac\n");
        assert_eq!(fs::read(config).unwrap(), bytes);
    }

    #[test]
    fn creates_a_private_agent_config_and_leaves_symlinked_configs_to_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("gpg-agent.conf");
        set_pinentry(&config, "/test/pinentry-mac").unwrap();
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o077,
            0
        );
        let link = dir.path().join("linked.conf");
        std::os::unix::fs::symlink(&config, &link).unwrap();
        assert!(set_pinentry(&link, "/different/pinentry").is_err());
        assert_eq!(
            fs::read_to_string(config).unwrap(),
            "pinentry-program /test/pinentry-mac\n"
        );
    }

    #[test]
    fn signs_with_a_locked_key_after_configuring_and_reloading_the_agent() {
        if Command::new("gpg")
            .arg("--version")
            .output()
            .is_err_and(|err| err.kind() == io::ErrorKind::NotFound)
        {
            eprintln!("Skipping protected-key signing check because GnuPG is unavailable");
            return;
        }
        let (dir, repo) = repo();
        let git_dir = repo.git_dir().unwrap();
        let home = git_dir.join("gnupg");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let script = |name: &str, body: &str| {
            let path = git_dir.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let gpg = script("signer", r#"exec gpg --homedir "${0%/*}/gnupg" "$@""#);
        let gpgconf = script(
            "agent-config",
            r#"export GNUPGHOME=.git/gnupg; exec gpgconf "$@""#,
        );
        // Assuan replies stand in for the unavailable terminal and a user typing
        // the disposable key's passphrase in the replacement pinentry dialog.
        let pinentry = |name: &str, answer: &str| {
            script(
                name,
                &format!(
                    r#"echo OK
while IFS= read -r command; do
    case "$command" in
        GETPIN) printf '%s\n' '{answer}';;
        BYE) echo OK; exit;;
        *) echo OK;;
    esac
done"#
                ),
            )
        };
        let failed = pinentry(
            "tty-pinentry",
            "ERR 83918950 Inappropriate ioctl for device",
        );
        let ready = pinentry("test-pinentry", "D disposable-passphrase\nOK");
        fs::write(
            home.join("gpg-agent.conf"),
            format!("pinentry-program {}\n", failed.display()),
        )
        .unwrap();
        let identity = "Diffinch Test <diffinch@example.invalid>";
        let mut generate = Command::new(&gpg);
        generate.args([
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--passphrase-fd",
            "0",
            "--quick-generate-key",
            identity,
            "ed25519",
            "sign",
            "1d",
        ]);
        execute(generate, &[], Some(b"disposable-passphrase\n")).unwrap();
        let mut reload = Command::new(&gpgconf);
        reload
            .current_dir(repo.root())
            .args(["--reload", "gpg-agent"]);
        execute(reload, &[], None).unwrap();

        repo.run(["config", "gpg.format", "openpgp"]).unwrap();
        repo.run(["config", "user.signingkey", identity]).unwrap();
        repo.run(["config", "gpg.openpgp.program", gpg.to_str().unwrap()])
            .unwrap();
        fs::write(dir.path().join("notes.txt"), "signed\n").unwrap();
        repo.action(Action::StageAll).unwrap();
        let commit = || Action::Commit {
            summary: "Protected signing key".into(),
            description: String::new(),
            sign: true,
            amend: None,
        };
        let error = repo.action(commit()).unwrap_err();
        // Older Git only reports that signing failed. The same agent setup
        // still has to produce a verifiable signature on the next attempt.
        assert!(
            error.key == "gpgNeedsPinentry"
                || error.detail.as_deref()
                    == Some(
                        "error: gpg failed to sign the data\nfatal: failed to write commit object"
                    ),
            "{error:?}"
        );
        configure_agent(&gpgconf, ready.to_str().unwrap(), repo.root()).unwrap();
        repo.action(commit()).unwrap();
        repo.run(["verify-commit", "HEAD"]).unwrap();
        let mut stop = Command::new(&gpgconf);
        stop.current_dir(repo.root()).args(["--kill", "all"]);
        execute(stop, &[], None).unwrap();
    }
}
