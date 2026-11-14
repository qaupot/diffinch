use super::{
    credentials::credential_url, process::execute, remotes::push_destination, Repo, Result,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialHelper {
    Osxkeychain,
    Manager,
    ManagerCore,
    Libsecret,
    Wincred,
    Cache,
}

impl CredentialHelper {
    const ALL: [Self; 6] = [
        Self::Osxkeychain,
        Self::Manager,
        Self::ManagerCore,
        Self::Libsecret,
        Self::Wincred,
        Self::Cache,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Osxkeychain => "osxkeychain",
            Self::Manager => "manager",
            Self::ManagerCore => "manager-core",
            Self::Libsecret => "libsecret",
            Self::Wincred => "wincred",
            Self::Cache => "cache",
        }
    }
}

#[derive(Serialize)]
pub struct CredentialHelperSettings {
    current: &'static str,
    available: Vec<CredentialHelper>,
    token: String,
}

fn installed_helpers(commands: &str) -> Vec<CredentialHelper> {
    CredentialHelper::ALL
        .into_iter()
        .filter(|helper| {
            commands
                .lines()
                .any(|command| command == format!("credential-{}", helper.name()))
        })
        .collect()
}

fn current_helper(values: &[String]) -> &'static str {
    if values.is_empty() {
        return "inherited";
    }
    // Keep compound helpers and arbitrary commands opaque, including secrets
    // embedded in shell helpers. Never send their contents to the frontend.
    let effective = match values {
        [value] => Some(value),
        [reset, value] if reset.is_empty() => Some(value),
        _ => None,
    };
    CredentialHelper::ALL
        .into_iter()
        .find(|helper| effective.is_some_and(|value| value == helper.name()))
        .map_or("custom", CredentialHelper::name)
}

impl Repo {
    pub(super) fn available_credential_helpers(&self) -> Result<Vec<CredentialHelper>> {
        // Ask Git to enumerate executables in its own exec path and PATH;
        // enumeration does not run helpers or access their credential stores.
        self.text(["--list-cmds=main,others"])
            .map(|commands| installed_helpers(&commands))
            .map_err(|_| "credentialHelperFailed".into())
    }

    fn local_credential_helpers(&self, url: &str) -> Result<Vec<String>> {
        let mut git = self.command();
        git.args([
            "config",
            "--local",
            "--no-includes",
            "--null",
            "--get-all",
            &format!("credential.{url}.helper"),
        ]);
        let output = execute(git, &[1], None).map_err(|_| "credentialHelperFailed")?;
        if output.truncated {
            return Err("credentialHelperFailed".into());
        }
        if output.bytes.is_empty() {
            return Ok(vec![]);
        }
        let text = String::from_utf8(output.bytes).map_err(|_| "credentialHelperFailed")?;
        Ok(text
            .strip_suffix('\0')
            .ok_or("credentialHelperFailed")?
            .split('\0')
            .map(str::to_owned)
            .collect())
    }

    pub(super) fn credential_helper_settings(
        &self,
        url: &str,
        available: Vec<CredentialHelper>,
    ) -> Result<CredentialHelperSettings> {
        let values = self.local_credential_helpers(url)?;
        Ok(CredentialHelperSettings {
            current: current_helper(&values),
            available,
            token: push_destination(&format!("{url}\0{}\0{}", values.len(), values.join("\0"))),
        })
    }

    pub(super) fn configure_credential_helper(
        &self,
        remote: &str,
        destination: &str,
        helper: Option<CredentialHelper>,
        token: &str,
    ) -> Result<()> {
        let urls = self
            .credential_urls(remote)
            .map_err(|_| "credentialHelperFailed")?;
        let raw = urls
            .iter()
            .find(|url| push_destination(url) == destination)
            .ok_or("credentialDestinationChanged")?;
        let url = credential_url(raw).ok_or("credentialHttpsOnly")?;
        let settings = self.credential_helper_settings(&url, vec![])?;
        if settings.token != token {
            return Err("credentialHelperChanged".into());
        }
        if let Some(helper) = helper {
            if !self.available_credential_helpers()?.contains(&helper) {
                return Err("credentialHelperUnavailable".into());
            }
        }
        self.write_credential_helper(&url, helper)
            .map_err(|_| "credentialHelperFailed".into())
    }

    fn write_credential_helper(&self, url: &str, helper: Option<CredentialHelper>) -> Result<()> {
        let key = format!("credential.{url}.helper");
        match helper {
            Some(helper) => {
                let previous = self.local_credential_helpers(url)?;
                // Reset inherited helpers before selecting one: Git otherwise
                // tries multiple helpers and sends saved credentials to them all.
                self.run(["config", "--local", "--replace-all", &key, ""])?;
                if let Err(error) = self.run(["config", "--local", "--add", &key, helper.name()]) {
                    // Best-effort rollback if the second config write fails.
                    let _ = self.run(["config", "--local", "--unset-all", &key]);
                    for value in previous {
                        let _ = self.run(["config", "--local", "--add", &key, &value]);
                    }
                    return Err(error);
                }
            }
            None => {
                let mut git = self.command();
                git.args(["config", "--local", "--unset-all", &key]);
                execute(git, &[5], None)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::repo;

    const URL: &str = "https://helpers.example.invalid/team/repo.git";

    fn setup() -> (tempfile::TempDir, Repo) {
        let (dir, repo) = repo();
        repo.run(["remote", "add", "origin", URL]).unwrap();
        (dir, repo)
    }

    #[test]
    fn detects_only_supported_installed_helpers_without_exposing_commands() {
        let helpers = installed_helpers("credential-osxkeychain\ncredential-cache\ncredential-cache--daemon\ncredential-store\ncredential-unknown\n");
        assert_eq!(
            serde_json::to_value(helpers).unwrap(),
            serde_json::json!(["osxkeychain", "cache"])
        );
        assert_eq!(current_helper(&[]), "inherited");
        assert_eq!(current_helper(&["".into()]), "custom");
        assert_eq!(current_helper(&["".into(), "manager".into()]), "manager");
        assert_eq!(
            current_helper(&["cache".into(), "manager".into()]),
            "custom"
        );
        assert_eq!(current_helper(&["!echo private-token".into()]), "custom");
    }

    #[test]
    fn scopes_selection_to_one_url_and_restores_inheritance_without_removing_credentials() {
        let (dir, repo) = setup();
        let store = dir.path().join("saved-credentials");
        std::fs::write(&store, "existing test credentials").unwrap();
        let inherited = format!("store --file='{}'", store.display());
        repo.run(["config", "--local", "credential.helper", &inherited])
            .unwrap();
        repo.run([
            "config",
            "--local",
            "credential.https://other.example.invalid.helper",
            "custom-helper",
        ])
        .unwrap();
        repo.run([
            "config",
            "--local",
            &format!("credential.{URL}.username"),
            "test-user",
        ])
        .unwrap();
        let before = std::fs::read(repo.0.join(".git/config")).unwrap();
        let initial = repo.credential_helper_settings(URL, vec![]).unwrap();
        assert_eq!(initial.current, "inherited");

        // Exercise config writes without invoking an OS credential store.
        repo.write_credential_helper(URL, Some(CredentialHelper::Manager))
            .unwrap();
        assert_eq!(repo.local_credential_helpers(URL).unwrap(), ["", "manager"]);
        let selected = repo.credential_helper_settings(URL, vec![]).unwrap();
        assert_eq!(selected.current, "manager");
        assert_ne!(selected.token, initial.token);
        assert_eq!(
            repo.text(["config", "--local", "--get", "credential.helper"])
                .unwrap(),
            inherited
        );
        assert_eq!(
            repo.text([
                "config",
                "--local",
                "--get",
                "credential.https://other.example.invalid.helper"
            ])
            .unwrap(),
            "custom-helper"
        );

        repo.configure_credential_helper("origin", &push_destination(URL), None, &selected.token)
            .unwrap();
        assert_eq!(
            repo.credential_helper_settings(URL, vec![])
                .unwrap()
                .current,
            "inherited"
        );
        assert_eq!(std::fs::read(repo.0.join(".git/config")).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(&store).unwrap(),
            "existing test credentials"
        );
    }

    #[test]
    fn custom_settings_are_opaque_and_stale_settings_cannot_be_overwritten() {
        let (_dir, repo) = setup();
        let original = repo.credential_helper_settings(URL, vec![]).unwrap();
        let key = format!("credential.{URL}.helper");
        repo.run(["config", "--local", &key, ""]).unwrap();
        let reset = repo.credential_helper_settings(URL, vec![]).unwrap();
        assert_ne!(original.token, reset.token);
        repo.run(["config", "--local", &key, "!echo private-token"])
            .unwrap();
        let custom = repo.credential_helper_settings(URL, vec![]).unwrap();
        assert_eq!(custom.current, "custom");
        assert!(!serde_json::to_string(&custom)
            .unwrap()
            .contains("private-token"));
        let error = repo
            .configure_credential_helper("origin", &push_destination(URL), None, &original.token)
            .unwrap_err();
        assert_eq!(error.key, "credentialHelperChanged");
        assert_eq!(
            repo.local_credential_helpers(URL).unwrap(),
            ["!echo private-token"]
        );
        repo.configure_credential_helper("origin", &push_destination(URL), None, &custom.token)
            .unwrap();
        assert!(repo.local_credential_helpers(URL).unwrap().is_empty());
    }

    #[test]
    fn rejects_changed_destinations_ssh_and_unavailable_helpers_before_writing() {
        let (_dir, repo) = setup();
        let initial = repo.credential_helper_settings(URL, vec![]).unwrap();
        let available = repo.available_credential_helpers().unwrap();
        if let Some(missing) = CredentialHelper::ALL
            .into_iter()
            .find(|helper| !available.contains(helper))
        {
            assert_eq!(
                repo.configure_credential_helper(
                    "origin",
                    &push_destination(URL),
                    Some(missing),
                    &initial.token
                )
                .unwrap_err()
                .key,
                "credentialHelperUnavailable"
            );
            assert!(repo.local_credential_helpers(URL).unwrap().is_empty());
        }
        // A real installed helper can be selected without running it.
        if let Some(installed) = available.first() {
            repo.configure_credential_helper(
                "origin",
                &push_destination(URL),
                Some(*installed),
                &initial.token,
            )
            .unwrap();
            assert_eq!(
                repo.local_credential_helpers(URL).unwrap(),
                ["", installed.name()]
            );
        }
        repo.run([
            "remote",
            "set-url",
            "origin",
            "git@example.invalid:team/repo.git",
        ])
        .unwrap();
        let before = std::fs::read(repo.0.join(".git/config")).unwrap();
        assert_eq!(
            repo.configure_credential_helper(
                "origin",
                &push_destination(URL),
                None,
                &initial.token
            )
            .unwrap_err()
            .key,
            "credentialDestinationChanged"
        );
        assert_eq!(
            repo.configure_credential_helper(
                "origin",
                &push_destination("git@example.invalid:team/repo.git"),
                None,
                &initial.token
            )
            .unwrap_err()
            .key,
            "credentialHttpsOnly"
        );
        assert_eq!(std::fs::read(repo.0.join(".git/config")).unwrap(), before);
    }
}
