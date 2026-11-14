use super::{
    credentials::credential_url,
    process::{execute_command, Transfer},
    remotes::push_destination,
    GitError, Repo, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const ACCOUNT_OUTPUT_LIMIT: usize = 128 * 1024;
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialAccountRequest {
    pub(super) remote: String,
    pub(super) destination: String,
}

#[derive(Serialize)]
pub struct CredentialAccount {
    pub(super) username: Option<String>,
}

impl Repo {
    pub fn credential_account(
        &self,
        request: CredentialAccountRequest,
    ) -> Result<CredentialAccount> {
        let urls = self
            .credential_urls(&request.remote)
            .map_err(|_| "credentialAccountFailed")?;
        let raw = urls
            .iter()
            .find(|url| push_destination(url) == request.destination)
            .ok_or("credentialDestinationChanged")?;
        let url = credential_url(raw).ok_or("credentialHttpsOnly")?;
        let mut git = self.command();
        // Ask the same helper chain Git uses, preserving URL/user/path matching.
        // Never use `approve` or `reject` for an account lookup.
        git.args([
            "-c",
            "credential.interactive=false",
            "-c",
            "credential.trace=false",
            "-c",
            "credential.traceSecrets=false",
            "-c",
            "core.askPass=",
            "credential",
            "fill",
        ])
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "false")
        .env("GCM_TRACE", "0")
        .env("GCM_TRACE_SECRETS", "0");
        let account = lookup_account(git, format!("url={url}\n\n").as_bytes(), ACCOUNT_TIMEOUT)?;
        // A helper can take time (for example, waiting for the keychain).
        // Do not attribute its result to a remote that was changed meanwhile.
        if !self
            .credential_urls(&request.remote)
            .map_err(|_| "credentialAccountFailed")?
            .iter()
            .any(|url| push_destination(url) == request.destination)
        {
            return Err("credentialDestinationChanged".into());
        }
        Ok(account)
    }
}

fn lookup_account(git: Command, input: &[u8], timeout: Duration) -> Result<CredentialAccount> {
    let cancelled = AtomicBool::new(false);
    let (done, receiver) = mpsc::channel();
    let output = thread::scope(|scope| {
        let cancelled = &cancelled;
        scope.spawn(move || {
            if matches!(
                receiver.recv_timeout(timeout),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                cancelled.store(true, Ordering::Relaxed);
            }
        });
        let transfer = Transfer {
            cancelled,
            progress: &|_| {},
        };
        // Git exits 128 when no complete credential can be returned without
        // prompting. Keep that as "not returned", not proof the store is empty.
        let result = execute_command(
            git,
            &[128],
            Some(input),
            ACCOUNT_OUTPUT_LIMIT,
            Some(&transfer),
        );
        let _ = done.send(());
        result
    })
    .map_err(|error| {
        GitError::from(if error.key == "transferCancelled" {
            "credentialAccountTimedOut"
        } else {
            "credentialAccountFailed"
        })
    })?;
    if output.truncated {
        return Err("credentialAccountFailed".into());
    }
    account_from_output(output.bytes)
}

fn account_from_output(mut output: Vec<u8>) -> Result<CredentialAccount> {
    // Credential output contains the password and may contain refresh tokens.
    // Extract only the username; never serialize or report any other field.
    let mut username = None;
    let mut has_password = false;
    let mut invalid = false;
    for line in output.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(value) = line.strip_prefix(b"username=") {
            match std::str::from_utf8(value) {
                Ok(value) if value.len() <= 1024 && !value.chars().any(char::is_control) => {
                    username = (!value.is_empty()).then(|| value.to_owned());
                }
                _ => invalid = true,
            }
        } else if line.starts_with(b"password=") {
            has_password = true;
        }
    }
    output.fill(0);
    if invalid {
        return Err("credentialAccountFailed".into());
    }
    Ok(CredentialAccount {
        username: username.filter(|_| has_password),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{credentials::CredentialUpdate, tests::repo};
    use super::*;

    const URL: &str = "https://accounts.example.invalid/team/fetch.git";
    const PUSH_URL: &str = "https://accounts.example.invalid/team/push.git";

    fn setup() -> (tempfile::TempDir, Repo) {
        let (dir, repo) = repo();
        repo.run(["remote", "add", "origin", URL]).unwrap();
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
        repo.run(["config", "--local", "credential.useHttpPath", "true"])
            .unwrap();
        (dir, repo)
    }

    fn request(url: &str) -> CredentialAccountRequest {
        CredentialAccountRequest {
            remote: "origin".into(),
            destination: push_destination(url),
        }
    }

    fn save(repo: &Repo, url: &str, username: &str) {
        let update: CredentialUpdate = serde_json::from_value(serde_json::json!({
            "remote": "origin", "destination": push_destination(url), "username": username, "password": "private-test-token",
        })).unwrap();
        repo.update_credentials(update).unwrap();
    }

    #[test]
    fn lookup_returns_only_the_saved_username_for_each_destination_without_writing() {
        let (dir, repo) = setup();
        repo.run(["remote", "set-url", "--push", "origin", PUSH_URL])
            .unwrap();
        save(&repo, URL, "fetch-user");
        save(&repo, PUSH_URL, "push-user");
        let before_config = std::fs::read(repo.0.join(".git/config")).unwrap();
        let before_credentials = std::fs::read(dir.path().join("test credentials")).unwrap();
        let fetch = repo.credential_account(request(URL)).unwrap();
        let push = repo.credential_account(request(PUSH_URL)).unwrap();
        assert_eq!(
            serde_json::to_value(fetch).unwrap(),
            serde_json::json!({ "username": "fetch-user" })
        );
        assert_eq!(
            serde_json::to_value(push).unwrap(),
            serde_json::json!({ "username": "push-user" })
        );
        assert_eq!(
            std::fs::read(repo.0.join(".git/config")).unwrap(),
            before_config
        );
        assert_eq!(
            std::fs::read(dir.path().join("test credentials")).unwrap(),
            before_credentials
        );
    }

    #[test]
    fn configured_username_alone_is_not_reported_as_a_saved_account() {
        let (_dir, repo) = setup();
        repo.run([
            "config",
            "--local",
            &format!("credential.{URL}.username"),
            "configured-only",
        ])
        .unwrap();
        assert!(repo
            .credential_account(request(URL))
            .unwrap()
            .username
            .is_none());
        save(&repo, URL, "configured-only");
        assert_eq!(
            repo.credential_account(request(URL))
                .unwrap()
                .username
                .as_deref(),
            Some("configured-only")
        );
        repo.run([
            "config",
            "--local",
            &format!("credential.{URL}.username"),
            "another-account",
        ])
        .unwrap();
        assert!(repo
            .credential_account(request(URL))
            .unwrap()
            .username
            .is_none());
    }

    #[test]
    fn lookup_rejects_stale_destinations_ssh_and_credential_bearing_urls() {
        let (_dir, repo) = setup();
        repo.run(["remote", "set-url", "origin", PUSH_URL]).unwrap();
        assert_eq!(
            repo.credential_account(request(URL)).err().unwrap().key,
            "credentialDestinationChanged"
        );
        for url in [
            "git@example.invalid:team/repo.git",
            "https://user:private-token@example.invalid/repo.git",
        ] {
            repo.run(["remote", "set-url", "origin", url]).unwrap();
            let error = repo.credential_account(request(url)).err().unwrap();
            assert_eq!(error.key, "credentialHttpsOnly");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("private-token"));
        }
    }

    #[test]
    fn parser_never_returns_passwords_refresh_tokens_or_malformed_usernames() {
        let account = account_from_output(b"protocol=https\nusername=alice\npassword=private-token\noauth_refresh_token=private-refresh\n\n".to_vec()).unwrap();
        assert_eq!(
            serde_json::to_value(account).unwrap(),
            serde_json::json!({"username":"alice"})
        );
        assert!(account_from_output(b"username=configured-only\n".to_vec())
            .unwrap()
            .username
            .is_none());
        assert!(
            account_from_output(b"username=\npassword=private-token\n".to_vec())
                .unwrap()
                .username
                .is_none()
        );
        for bytes in [
            b"username=bad\0name\npassword=secret\n".to_vec(),
            b"username=\xff\npassword=secret\n".to_vec(),
        ] {
            let error = account_from_output(bytes).err().unwrap();
            assert_eq!(error.key, "credentialAccountFailed");
            assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn lookup_disables_prompts_and_never_invokes_helper_store_or_erase() {
        let (dir, repo) = setup();
        let marker = dir.path().join("unexpected-helper-action");
        let helper = format!("!f() {{ test \"$1\" = get && test \"$GCM_INTERACTIVE\" = false && test \"$GIT_TERMINAL_PROMPT\" = 0 && test -z \"$GIT_ASKPASS\" && test -z \"$SSH_ASKPASS\" && test \"$(git config credential.interactive)\" = false || {{ touch '{}'; exit 1; }}; printf 'username=quiet-user\\npassword=private-token\\n'; }}; f", marker.display());
        repo.run(["config", "--local", "--add", "credential.helper", &helper])
            .unwrap();
        assert_eq!(
            repo.credential_account(request(URL))
                .unwrap()
                .username
                .as_deref(),
            Some("quiet-user")
        );
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn lookup_timeout_terminates_the_helper_process_tree() {
        let mut git = Command::new("sh");
        git.args(["-c", "sleep 30"]);
        let start = std::time::Instant::now();
        let error = lookup_account(git, b"", Duration::from_millis(100))
            .err()
            .unwrap();
        assert_eq!(error.key, "credentialAccountTimedOut");
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn lookup_failures_do_not_expose_process_output() {
        let mut git = Command::new("sh");
        git.args([
            "-c",
            "printf 'password=private-token\\n'; printf 'private-refresh\\n' >&2; exit 1",
        ]);
        let error = lookup_account(git, b"", Duration::from_secs(2))
            .err()
            .unwrap();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({"key":"credentialAccountFailed"})
        );
    }
}
