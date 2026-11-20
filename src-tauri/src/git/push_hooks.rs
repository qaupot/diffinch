use super::{bytes_to_os, process::execute, trim_line, GitError, Repo, Result};
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::{Builder, TempDir};

// A pinned transport uses a private remote without tracking refspecs. Give
// hooks the configured name and their ordinary Git config. Keep Git in charge
// of negotiation, stdin, hook ordering and vetoing the push.
const FORWARD_HOOK: &str = r#"#!/bin/sh
command_file=
if test "$1" = "$DIFFINCH_PUSH_ALIAS/configured"; then
    command_file=$2
    shift 2
fi
if test -f "$DIFFINCH_PARENT_CONFIG_FILE"; then
    saved=$(cat "$DIFFINCH_PARENT_CONFIG_FILE" && printf .) || exit 1
    export GIT_CONFIG_PARAMETERS="${saved%.}"
else
    unset GIT_CONFIG_PARAMETERS
fi
if test "$1" = "$DIFFINCH_PUSH_ALIAS"; then
    shift
    set -- "$DIFFINCH_PUSH_REMOTE" "$@"
fi
if test -n "$command_file"; then
    saved=$(cat "$command_file" && printf .) || exit 1
    export DIFFINCH_HOOK_COMMAND="!${saved%.}"
    exec git "--config-env=alias.$DIFFINCH_PUSH_ALIAS=DIFFINCH_HOOK_COMMAND" "$DIFFINCH_PUSH_ALIAS" "$@"
fi
hook="$DIFFINCH_HOOKS_DIR/${0##*/}"
if test -n "$DIFFINCH_HOOK_EXE_SUFFIX" && ! test -f "$hook"; then
    hook="$hook$DIFFINCH_HOOK_EXE_SUFFIX"
fi
if test -f "$hook" && test -x "$hook"; then
    exec "$hook" "$@"
fi
"#;

fn io_error(error: io::Error) -> GitError {
    GitError::new("gitIoFailed", error)
}

fn write_forwarder(file: &Path) -> Result<()> {
    fs::write(file, FORWARD_HOOK).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::PermissionsExt},
        };
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        // Git ignores hooks on a noexec mount. Refuse the push if it would
        // silently skip a user's hook.
        let name = CString::new(file.as_os_str().as_bytes()).map_err(|_| "invalidGitPath")?;
        if unsafe { libc::access(name.as_ptr(), libc::X_OK) } != 0 {
            return Err(io_error(io::Error::last_os_error()));
        }
    }
    Ok(())
}

// Some systems mount the temporary directory noexec. The per-worktree Git
// directory is a second location for this short-lived executable.
fn hook_directory(parent: Option<&Path>) -> Result<TempDir> {
    let mut builder = Builder::new();
    builder.prefix("diffinch-push-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let dir = match parent {
        Some(parent) => builder.tempdir_in(parent),
        None => builder.tempdir(),
    }
    .map_err(io_error)?;
    let hooks = dir.path().join("hooks");
    fs::create_dir(&hooks).map_err(io_error)?;
    write_forwarder(&hooks.join("pre-push"))?;
    Ok(dir)
}

impl Repo {
    pub(super) fn pinned_push_hooks(
        &self,
        git: &mut Command,
        remote: &str,
        alias: &str,
    ) -> Result<TempDir> {
        git.env("DIFFINCH_PUSH_ALIAS", alias)
            .env("DIFFINCH_PUSH_REMOTE", remote);
        let output = self.run([
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ])?;
        let path = PathBuf::from(bytes_to_os(trim_line(&output.bytes))?);
        let hooks = path.parent().ok_or("invalidGitPath")?;
        let dir = match hook_directory(None) {
            Ok(dir) => dir,
            Err(_) => hook_directory(Some(&self.git_dir()?))?,
        };
        let parent_config = dir.path().join("parent-config");
        if let Some(config) = env::var_os("GIT_CONFIG_PARAMETERS") {
            fs::write(&parent_config, config.as_encoded_bytes()).map_err(io_error)?;
        }
        let hooks_dir = dir.path().join("hooks");
        git.env("DIFFINCH_PARENT_CONFIG_FILE", parent_config)
            .env("DIFFINCH_HOOK_EXE_SUFFIX", env::consts::EXE_SUFFIX)
            .env("DIFFINCH_HOOKS_DIR", hooks)
            .env("DIFFINCH_PUSH_HOOKS", &hooks_dir)
            .arg("--config-env=core.hooksPath=DIFFINCH_PUSH_HOOKS");
        let forwarder = hooks_dir.join("pre-push");
        git.env("DIFFINCH_HOOK_FORWARDER", &forwarder);
        // Keep file hooks used by other operations, e.g. reference-transaction
        // on remote deletion. Their scripts and sibling helpers stay in place.
        match fs::read_dir(hooks) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(io_error)?;
                    let name = entry.file_name();
                    #[cfg(windows)]
                    let name = Path::new(&name)
                        .file_stem()
                        .filter(|_| {
                            Path::new(&name)
                                .extension()
                                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                        })
                        .unwrap_or(&name);
                    let target = hooks_dir.join(name);
                    if entry.path().is_file() && !target.try_exists().map_err(io_error)? {
                        fs::copy(&forwarder, target).map_err(io_error)?;
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) => {}
            Err(e) => return Err(io_error(e)),
        }

        self.forward_configured_hooks(git, dir.path())?;
        Ok(dir)
    }

    fn forward_configured_hooks(&self, git: &mut Command, dir: &Path) -> Result<()> {
        // Configured hooks can also be registered for other events. Preserve
        // each registration and let Git interpret its command as a shell alias,
        // using the same shell/argv rules as a configured hook command.
        let mut list = self.command();
        list.args([
            "config",
            "--null",
            "--get-regexp",
            r"^hook\..*\.(event|command)$",
        ]);
        let output = execute(list, &[1], None)?;
        if output.truncated {
            return Err("tooMuchData".into());
        }
        let mut handlers = HashMap::new();
        for record in output.bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let mut fields = record.splitn(2, |b| *b == b'\n');
            let key = fields.next().unwrap_or_default();
            let value = fields.next().unwrap_or_default();
            if let Some(name) = key.strip_suffix(b".command") {
                handlers.entry(name).or_insert((false, None)).1 = Some(value);
            } else if let Some(name) = key.strip_suffix(b".event") {
                let (pre_push, _) = handlers.entry(name).or_insert((false, None));
                if value == b"pre-push" || value.is_empty() {
                    *pre_push = !value.is_empty();
                }
            }
        }
        for (index, (name, handler)) in handlers.into_iter().enumerate() {
            let (true, Some(command)) = handler else {
                continue;
            };
            // Hook commands and inherited Git config can contain credentials.
            // Keep them as private data and pass only the file path to the transport.
            let file = dir.join(format!("command-{index}"));
            fs::write(&file, command).map_err(io_error)?;
            let variable = format!("DIFFINCH_HOOK_FILE_{index}");
            let wrapper = format!("DIFFINCH_HOOK_WRAPPER_{index}");
            let mut override_key = OsString::from("--config-env=");
            override_key.push(bytes_to_os(name)?);
            override_key.push(".command=");
            override_key.push(&wrapper);
            git.env(&variable, file)
                .env(&wrapper, format!(r#""$DIFFINCH_HOOK_FORWARDER" "$DIFFINCH_PUSH_ALIAS/configured" "${variable}""#))
                .arg(override_key);
        }
        Ok(())
    }
}
