use super::{
    credential_helpers::CredentialHelperSettings,
    process::{execute, read_output},
    remotes::{push_destination, redact_remote},
    GitError, Repo, Result, OUTPUT_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    process::{Command, Stdio},
    thread,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTarget {
    destination: String,
    url: String,
    transport: &'static str,
    storage: &'static str,
    helper: Option<CredentialHelperSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialUpdate {
    remote: String,
    destination: String,
    username: String,
    password: Option<String>,
}

pub(super) fn credential_url(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    // Git decodes URL components before feeding the line-based helper protocol.
    let lower = raw.to_ascii_lowercase();
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !raw.chars().any(char::is_control)
        && !["%00", "%0a", "%0d"]
            .iter()
            .any(|value| lower.contains(value)))
    .then(|| raw.to_owned())
}

fn valid_field(value: &str) -> bool {
    !value.is_empty() && value.len() < 60_000 && !value.contains(['\r', '\n', '\0'])
}

pub(super) fn authentication_required(message: &str) -> bool {
    message.lines().any(|line| {
        let line = line.trim();
        ["Username", "Password"].iter().any(|field| {
            line.starts_with(&format!("fatal: could not read {field} for 'https://"))
                || line.starts_with(&format!("fatal: could not read {field} for 'http://"))
        }) || line.starts_with("fatal: Authentication failed for 'https://")
            || line.starts_with("fatal: Authentication failed for 'http://")
    })
}

impl Repo {
    pub(super) fn credential_urls(&self, remote: &str) -> Result<Vec<String>> {
        self.tracked_remote(remote)?;
        let fetch = self.text(["remote", "get-url", "--", remote])?;
        let push = self.text(["remote", "get-url", "--push", "--all", "--", remote])?;
        let mut urls = vec![fetch];
        for url in push.lines() {
            if !urls.iter().any(|item| item == url) {
                urls.push(url.to_owned());
            }
        }
        Ok(urls)
    }

    fn credential_storage(&self, url: &str) -> Result<&'static str> {
        let mut git = self.command();
        git.args([
            "config",
            "--null",
            "--get-urlmatch",
            "credential.helper",
            url,
        ]);
        let helpers = execute(git, &[1], None)?;
        if helpers.truncated {
            return Err("credentialsFailed".into());
        }
        let mut configured = false;
        for helper in helpers
            .bytes
            .strip_suffix(&[0])
            .unwrap_or(&helpers.bytes)
            .split(|byte| *byte == 0)
        {
            configured = !helper.is_empty();
        }
        if configured {
            Ok("configured")
        } else if cfg!(target_os = "macos") {
            Ok("keychain")
        } else {
            Ok("unavailable")
        }
    }

    pub fn credential_targets(&self, remote: &str) -> Result<Vec<CredentialTarget>> {
        let available = self.available_credential_helpers()?;
        self.credential_urls(remote)
            .map_err(|_| GitError::from("credentialsFailed"))?
            .into_iter()
            .map(|raw| {
                let supported = credential_url(&raw);
                Ok(CredentialTarget {
                    destination: push_destination(&raw),
                    url: redact_remote(&raw),
                    transport: if supported.is_some() {
                        "https"
                    } else if raw.starts_with("ssh://")
                        || (!raw.contains("://") && raw.contains('@') && raw.contains(':'))
                    {
                        "ssh"
                    } else {
                        "unsupported"
                    },
                    storage: match supported {
                        Some(ref url) => self.credential_storage(url)?,
                        None => "unavailable",
                    },
                    helper: supported
                        .map(|url| self.credential_helper_settings(&url, available.clone()))
                        .transpose()?,
                })
            })
            .collect::<Result<_>>()
            .map_err(|_| "credentialsFailed".into())
    }

    pub fn update_credentials(&self, update: CredentialUpdate) -> Result<&'static str> {
        if !valid_field(&update.username)
            || update
                .password
                .as_deref()
                .is_some_and(|value| !valid_field(value))
        {
            return Err("invalidCredentials".into());
        }
        let urls = self
            .credential_urls(&update.remote)
            .map_err(|_| GitError::from("credentialsFailed"))?;
        let raw = urls
            .iter()
            .find(|url| push_destination(url) == update.destination)
            .ok_or("credentialDestinationChanged")?;
        let url = credential_url(raw).ok_or("credentialHttpsOnly")?;
        let storage = self
            .credential_storage(&url)
            .map_err(|_| GitError::from("credentialsFailed"))?;
        if storage == "unavailable" || (storage == "keychain" && update.password.is_none()) {
            return Err("credentialHelperMissing".into());
        }
        if storage == "keychain" {
            // Scope the fallback to this URL and repository; preserve existing helpers.
            self.run([
                "config",
                "--local",
                &format!("credential.{url}.helper"),
                "osxkeychain",
            ])
            .map_err(|_| GitError::from("credentialsFailed"))?;
        }
        let mut input = format!("url={url}\nusername={}\n", update.username);
        if let Some(password) = &update.password {
            input.push_str(&format!("password={password}\n"));
        }
        input.push('\n');
        let mut git = self.command();
        git.args([
            "credential",
            if update.password.is_some() {
                "approve"
            } else {
                "reject"
            },
        ]);
        credential_command(git, input.as_bytes())?;
        if update.password.is_some() {
            // Select this account on subsequent fetch/pull/push, including when
            // another username is inherited from global Git configuration.
            self.run([
                "config",
                "--local",
                &format!("credential.{url}.username"),
                &update.username,
            ])
            .map_err(|_| GitError::from("credentialsFailed"))?;
        }
        Ok(if update.password.is_some() {
            "credentialsSaved"
        } else {
            "credentialsRemoved"
        })
    }
}

// Helpers can fail while `git credential` exits successfully. Inspect stderr, but
// never return helper output: custom helpers may echo the supplied password.
fn credential_command(mut git: Command, input: &[u8]) -> Result<()> {
    let result = (|| -> io::Result<bool> {
        let mut child = git
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        thread::scope(|scope| {
            let out = scope.spawn(move || read_output(stdout, OUTPUT_LIMIT));
            let err = scope.spawn(move || read_output(stderr, OUTPUT_LIMIT));
            let write = scope.spawn(move || stdin.write_all(input));
            let status = child.wait()?;
            let out = out.join().expect("credential stdout")?;
            let err = err.join().expect("credential stderr")?;
            write.join().expect("credential stdin")?;
            Ok(status.success() && out.bytes.is_empty() && err.bytes.is_empty())
        })
    })();
    match result {
        Ok(true) => Ok(()),
        _ => Err("credentialsFailed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        process::{execute, Output},
        string,
    };
    use super::*;

    fn setup() -> (tempfile::TempDir, Repo) {
        let (dir, repo) = super::super::tests::repo();
        repo.run([
            "remote",
            "add",
            "origin",
            "https://credentials.example.invalid/team/repo.git",
        ])
        .unwrap();
        repo.run(["config", "--local", "credential.helper", ""])
            .unwrap();
        repo.run([
            "config",
            "--local",
            "--add",
            "credential.helper",
            &format!(
                "store --file='{}'",
                dir.path().join("test credentials").display()
            ),
        ])
        .unwrap();
        (dir, repo)
    }

    fn update(target: &CredentialTarget, password: Option<&str>) -> CredentialUpdate {
        CredentialUpdate {
            remote: "origin".into(),
            destination: target.destination.clone(),
            username: "test-user".into(),
            password: password.map(str::to_owned),
        }
    }

    fn fill(repo: &Repo, url: &str) -> Result<Output> {
        let mut git = repo.command();
        git.args(["-c", "core.askPass=", "credential", "fill"])
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "");
        execute(
            git,
            &[],
            Some(format!("url={url}\nusername=test-user\n\n").as_bytes()),
        )
    }

    #[test]
    fn missing_https_credentials_request_sign_in_without_exposing_output() {
        let (dir, repo) = setup();
        let config = dir.path().join("empty-config");
        std::fs::write(&config, "").unwrap();
        for account in ["", "username=private-user\n"] {
            let mut git = repo.command();
            git.args([
                "-c",
                "credential.helper=",
                "-c",
                "core.askPass=",
                "credential",
                "fill",
            ])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "");
            let error = execute(
                git,
                &[],
                Some(
                    format!("url=https://credentials.example.invalid/team/repo.git\n{account}\n")
                        .as_bytes(),
                ),
            )
            .err()
            .unwrap();
            assert_eq!(error.key, "authenticationRequired");
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn recognizes_https_authentication_errors_but_preserves_other_failures() {
        for message in [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "fatal: could not read Password for 'https://private-user@github.com': terminal prompts disabled",
            "remote: Invalid username or token.\nfatal: Authentication failed for 'https://user:secret@github.com/team/repo.git/'",
            "fatal: could not read Username for 'http://host': No such device or address",
        ] {
            assert!(authentication_required(message));
        }
        for message in [
            "fatal: unable to access 'https://github.com/team/repo.git/': Could not resolve host: github.com",
            "fatal: repository 'https://github.com/team/repo.git/' not found",
            "! [rejected] main -> main (non-fast-forward)",
            "git@github.com: Permission denied (publickey).",
            "remote: fatal: Authentication failed for 'https://host/repo'",
        ] {
            assert!(!authentication_required(message));
        }
    }

    #[test]
    fn saves_and_forgets_credentials_used_by_git_without_changing_remote_urls() {
        let (_dir, repo) = setup();
        let targets = repo.credential_targets("origin").unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].storage, "configured");
        repo.update_credentials(update(&targets[0], Some("test-token:$'`=")))
            .unwrap();
        let output = fill(&repo, &targets[0].url).unwrap();
        assert!(string(&output.bytes).contains("password=test-token:$'`="));
        let mut git = repo.command();
        git.args(["credential", "fill"]);
        let selected = execute(
            git,
            &[],
            Some(format!("url={}\n\n", targets[0].url).as_bytes()),
        )
        .unwrap();
        assert!(string(&selected.bytes).contains("username=test-user"));
        let config = repo.text(["config", "--local", "--list"]).unwrap();
        assert!(!config.contains("test-token"));
        assert_eq!(
            repo.text(["remote", "get-url", "origin"]).unwrap(),
            targets[0].url
        );
        repo.update_credentials(update(&targets[0], None)).unwrap();
        assert!(fill(&repo, &targets[0].url).is_err());
    }

    #[test]
    fn separates_fetch_and_push_destinations_and_rejects_stale_targets() {
        let (_dir, repo) = setup();
        repo.run([
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://push.example.invalid/team/repo.git",
        ])
        .unwrap();
        let targets = repo.credential_targets("origin").unwrap();
        assert_eq!(targets.len(), 2);
        repo.update_credentials(update(&targets[1], Some("push-token")))
            .unwrap();
        assert!(fill(&repo, &targets[0].url).is_err());
        assert!(
            string(&fill(&repo, &targets[1].url).unwrap().bytes).contains("password=push-token")
        );
        repo.run([
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://changed.example.invalid/repo.git",
        ])
        .unwrap();
        assert_eq!(
            repo.update_credentials(update(&targets[1], Some("token")))
                .unwrap_err()
                .key,
            "credentialDestinationChanged"
        );
    }

    #[test]
    fn honors_path_scoping_and_helper_resets() {
        let (_dir, repo) = setup();
        repo.run(["config", "credential.useHttpPath", "true"])
            .unwrap();
        let targets = repo.credential_targets("origin").unwrap();
        repo.update_credentials(update(&targets[0], Some("scoped-token")))
            .unwrap();
        assert!(fill(&repo, "https://credentials.example.invalid/other/repo.git").is_err());
        assert!(fill(&repo, &targets[0].url).is_ok());
        repo.run(["config", "--add", "credential.helper", ""])
            .unwrap();
        assert_ne!(
            repo.credential_targets("origin").unwrap()[0].storage,
            "configured"
        );
    }

    #[test]
    fn rejects_protocol_injection_and_unsupported_urls() {
        for raw in [
            "http://host/repo",
            "ssh://git@host/repo",
            "https://user:secret@host/repo",
            "https://user@host/repo",
            "https://host/repo?token=secret",
            "https://host/repo#fragment",
            "https://host/repo%0Apassword=secret",
            "https://host/repo%00",
            "https://host/\nrepo",
        ] {
            assert!(credential_url(raw).is_none(), "{raw}");
        }
        assert_eq!(
            redact_remote("https://user:secret@host/repo?token=secret#secret"),
            "https://host/repo"
        );
        assert!(credential_url("https://host:8443/team/repo.git").is_some());
        let (_dir, repo) = setup();
        let targets = repo.credential_targets("origin").unwrap();
        for value in ["", "a\npassword=other", "a\r", "a\0"] {
            assert_eq!(
                repo.update_credentials(update(&targets[0], Some(value)))
                    .unwrap_err()
                    .key,
                "invalidCredentials"
            );
            let mut request = update(&targets[0], Some("token"));
            request.username = value.into();
            assert_eq!(
                repo.update_credentials(request).unwrap_err().key,
                "invalidCredentials"
            );
        }
    }

    #[test]
    fn reports_ssh_and_redacts_embedded_secrets_without_loading_credentials() {
        let (_dir, repo) = setup();
        repo.run(["remote", "set-url", "origin", "git@host:team/repo.git"])
            .unwrap();
        assert_eq!(
            repo.credential_targets("origin").unwrap()[0].transport,
            "ssh"
        );
        repo.run([
            "remote",
            "set-url",
            "origin",
            "https://user:secret@host/repo?token=secret",
        ])
        .unwrap();
        let targets = repo.credential_targets("origin").unwrap();
        assert_eq!(targets[0].transport, "unsupported");
        assert!(!serde_json::to_string(&targets).unwrap().contains("secret"));
    }

    #[cfg(unix)]
    #[test]
    fn helper_failures_never_expose_passwords_in_errors() {
        let (_dir, repo) = setup();
        repo.run([
            "config",
            "--replace-all",
            "credential.helper",
            "!f() { cat >&2; exit 1; }; f",
        ])
        .unwrap();
        let targets = repo.credential_targets("origin").unwrap();
        let error = repo
            .update_credentials(update(&targets[0], Some("private-token")))
            .unwrap_err();
        assert_eq!(error.key, "credentialsFailed");
        assert!(error.detail.is_none());
    }
}
