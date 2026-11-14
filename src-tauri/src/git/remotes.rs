use super::{
    model::{PushLease, RemoteRef, RemoteRefKind, RemoteRefs, Status},
    process::execute,
    refs::validate_oid,
    string, trim_line, GitError, Repo, Result,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    process::Command,
};

struct PushPlan {
    lease: PushLease,
    url: String,
    tracking: String,
}

impl Repo {
    pub(super) fn push_lease(&self, status: &Status) -> Result<Option<PushLease>> {
        Ok(self.push_plan(status)?.map(|plan| plan.lease))
    }

    fn push_plan(&self, status: &Status) -> Result<Option<PushPlan>> {
        let (Some(branch), Some(head), Some(_)) = (&status.branch, &status.head, &status.upstream)
        else {
            return Ok(None);
        };
        let upstream = self.text([
            "for-each-ref",
            "--format=%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)",
            &format!("refs/heads/{branch}"),
        ])?;
        let fields: Vec<_> = upstream.split('\t').collect();
        let [tracking, remote, target] = fields.as_slice() else {
            return Ok(None);
        };
        if !tracking.starts_with("refs/remotes/")
            || remote.is_empty()
            || *remote == "."
            || !target.starts_with("refs/heads/")
        {
            return Ok(None);
        }
        let mut git = self.command();
        git.args([
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            tracking,
        ]);
        let result = execute(git, &[1], None)?;
        let expected = string(trim_line(&result.bytes));
        if validate_oid(&expected).is_err() {
            return Ok(None);
        }
        let Some(url) = self.single_push_url(remote)? else {
            return Ok(None);
        };
        Ok(Some(PushPlan {
            lease: PushLease {
                branch: branch.clone(),
                head: head.clone(),
                remote: (*remote).into(),
                target: (*target).into(),
                expected,
                destination: push_destination(&url),
            },
            url,
            tracking: (*tracking).into(),
        }))
    }

    pub(super) fn force_push(&self, lease: PushLease) -> Result<()> {
        let status = self.status()?;
        let plan = self.push_plan(&status)?.ok_or("stalePushLease")?;
        if self.operation()?.is_some() || plan.lease != lease {
            return Err("stalePushLease".into());
        }
        // Use the resolved destination so a remote configuration change cannot
        // redirect the push after validation.
        let mut git = self.push_command(&lease.remote, &plan.url)?;
        git.args([
            "--progress",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
            &format!("--force-with-lease={}:{}", lease.target, lease.expected),
            "--",
            &plan.url,
            &format!("{}:{}", lease.head, lease.target),
        ]);
        execute(git, &[], None)?;
        // Pushing by URL does not update the named remote's tracking ref. The
        // push already succeeded, so this local refresh is best effort; the
        // expected old value protects a newer fetch or a deleted tracking ref.
        let _ = self.run([
            "update-ref",
            "--no-deref",
            "-m",
            "update by push",
            &plan.tracking,
            &lease.head,
            &lease.expected,
        ]);
        Ok(())
    }

    fn remote_config_values(&self, remote: &str, key: &str) -> Result<Vec<String>> {
        let mut git = self.command();
        git.args([
            "config",
            "--null",
            "--get-all",
            &format!("remote.{remote}.{key}"),
        ]);
        let output = execute(git, &[1], None)?;
        if output.truncated {
            return Err("tooMuchData".into());
        }
        Ok(output
            .bytes
            .split_inclusive(|byte| *byte == 0)
            .map(|value| string(value.strip_suffix(&[0]).unwrap_or(value)))
            .collect())
    }

    fn push_command(&self, remote: &str, url: &str) -> Result<Command> {
        let mut git = self.command();
        // Using a pinned URL bypasses remote.<name> transport options. Apply
        // those explicitly, including an empty proxy that disables inheritance.
        for (remote_key, http_key) in [("proxy", "proxy"), ("proxyauthmethod", "proxyAuthMethod")] {
            if let Some(value) = self.remote_config_values(remote, remote_key)?.last() {
                git.args(["-c", &format!("http.{url}.{http_key}={value}")]);
            }
        }
        git.arg("push");
        // Git uses the first receivepack value when multiple scopes specify it.
        if let Some(value) = self.remote_config_values(remote, "receivepack")?.first() {
            git.arg(format!("--receive-pack={value}"));
        }
        Ok(git)
    }

    pub(super) fn tracked_remote(&self, remote: &str) -> Result<()> {
        if self.text(["remote"])?.lines().any(|name| name == remote) {
            Ok(())
        } else {
            Err(GitError::new("missingRemote", remote))
        }
    }

    pub(super) fn remote_push_url(&self, remote: &str) -> Result<String> {
        self.single_push_url(remote)?
            .ok_or_else(|| "multiplePushDestinations".into())
    }

    fn single_push_url(&self, remote: &str) -> Result<Option<String>> {
        self.tracked_remote(remote)?;
        let urls = self.text(["remote", "get-url", "--push", "--all", "--", remote])?;
        if urls.is_empty() || urls.contains('\n') {
            return Ok(None);
        }
        Ok(Some(urls))
    }

    pub fn remote_refs(&self, remote: &str, kind: RemoteRefKind) -> Result<RemoteRefs> {
        let url = self.remote_push_url(remote)?;
        let refs = self.text([
            "ls-remote",
            "--refs",
            "--",
            &url,
            &format!("{}*", kind.prefix()),
        ])?;
        let refs = refs
            .lines()
            .filter_map(|line| {
                let (tip, reference) = line.split_once('\t')?;
                let name = reference.strip_prefix(kind.prefix())?;
                Some(RemoteRef {
                    name: name.to_owned(),
                    tip: tip.to_owned(),
                })
            })
            .collect();
        Ok(RemoteRefs {
            destination: push_destination(&url),
            url: redact_remote(&url),
            refs,
        })
    }

    pub(super) fn delete_remote_ref(
        &self,
        remote: &str,
        kind: RemoteRefKind,
        name: &str,
        tip: &str,
        destination: &str,
    ) -> Result<()> {
        self.check_ref(kind.prefix(), name)?;
        validate_oid(tip)?;
        if push_destination(&self.remote_push_url(remote)?) != destination {
            return Err("stalePushDestination".into());
        }
        let reference = format!("{}{name}", kind.prefix());
        self.run([
            "push",
            "--progress",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
            &format!("--force-with-lease={reference}:{tip}"),
            "--",
            remote,
            &format!(":{reference}"),
        ])?;
        Ok(())
    }
}

/// Sanitize URLs before they cross the IPC boundary or enter display strings.
pub(super) fn redact_remote(raw: &str) -> String {
    if let Ok(mut url) = tauri::Url::parse(raw) {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return url.to_string();
    }
    // Preserve SCP-style SSH destinations and local paths. For malformed URLs,
    // also strip likely credentials instead of falling back to the original text.
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);
    if let Some((scheme, rest)) = raw.split_once("://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        if let Some((_, address)) = authority.rsplit_once('@') {
            return format!("{scheme}://{address}{}", &rest[authority.len()..]);
        }
    }
    raw.into()
}

/// Git diagnostics can quote malformed URLs (including spaces), or print
/// unquoted URLs. Sanitize each destination while retaining the surrounding error.
pub(super) fn redact_git_output(message: &str) -> String {
    let mut output = String::with_capacity(message.len());
    let mut remaining = message;
    while let Some(marker) = remaining.find("://") {
        let start = remaining[..marker]
            .rfind(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '+' | '-' | '.'))
            .map_or(0, |index| {
                index + remaining[index..].chars().next().unwrap().len_utf8()
            });
        if !remaining[start..marker].starts_with(|c: char| c.is_ascii_alphabetic()) {
            output.push_str(&remaining[..marker + 3]);
            remaining = &remaining[marker + 3..];
            continue;
        }
        let quote = remaining[..start]
            .chars()
            .next_back()
            .filter(|c| matches!(c, '\'' | '"'));
        let end = remaining[marker + 3..]
            .char_indices()
            .find_map(|(offset, c)| {
                let index = marker + 3 + offset;
                let boundary = if let Some(quote) = quote {
                    c == '\n'
                        || c == '\r'
                        || c == quote
                            && remaining[index + c.len_utf8()..]
                                .chars()
                                .next()
                                .is_none_or(|next| {
                                    next.is_whitespace()
                                        || matches!(next, ':' | ',' | ';' | ')' | ']')
                                })
                } else {
                    c.is_whitespace() || matches!(c, '<' | '>')
                };
                boundary.then_some(index)
            })
            .unwrap_or(remaining.len());
        output.push_str(&remaining[..start]);
        output.push_str(&redact_remote(&remaining[start..end]));
        remaining = &remaining[end..];
    }
    output.push_str(remaining);
    output
}

pub(super) fn push_destination(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{model::Action, tests::repo};

    #[test]
    fn pinned_push_honors_remote_proxy_overrides_including_an_empty_proxy() {
        for use_proxy in [true, false] {
            let (_dir, repo) = repo();
            crate::git::tests::commit_file(&repo, "notes", "Base", "Base");
            let url = "http://127.0.0.1:1/repo.git";
            repo.run(["remote", "add", "origin", url]).unwrap();
            // Invalid proxy schemes fail before any connection. The direct
            // destination uses a local closed port instead of an external host.
            repo.run([
                "config",
                "http.proxy",
                "unsupported-proxy://inherited.invalid",
            ])
            .unwrap();
            let proxy = if use_proxy {
                "unsupported-proxy://selected.invalid"
            } else {
                ""
            };
            repo.run(["config", "remote.origin.proxy", proxy]).unwrap();
            let mut git = repo.push_command("origin", url).unwrap();
            git.env("no_proxy", "").env("NO_PROXY", "").args([
                "--dry-run",
                "--",
                url,
                "HEAD:refs/heads/main",
            ]);
            let error = execute(git, &[], None).err().unwrap();
            let detail = error.detail.unwrap();
            assert!(!detail.contains("inherited.invalid"), "{detail}");
            assert_eq!(detail.contains("selected.invalid"), use_proxy, "{detail}");
            if !use_proxy {
                assert!(!detail.contains("Unsupported proxy"), "{detail}");
            }
        }
    }

    #[test]
    fn redacts_urls_in_errors_without_losing_the_diagnostic() {
        for message in [
            "fatal: unable to access 'https://user:secret@example.invalid/repo?token=secret#secret': Failed to connect",
            "fatal: unable to access 'https://user:secret@bad host/repo?token=secret': URL rejected",
            "fatal: unable to access \"https://user:secret@bad host/repo?token=secret\": URL rejected",
            "fatal: unable to access 'https://host/repo?token=one'secret': URL rejected",
            "fatal: redirects from 'https://host/repo?token=secret' to 'https://user:secret@other/repo#secret' failed",
            "fatal: https://user:secret@host/repo?token=secret failed\nremote: https://host/repo#secret rejected",
        ] {
            let error = GitError::new("gitOutput", message);
            let displayed = error.detail.unwrap();
            assert!(!displayed.contains("secret"), "{displayed}");
            assert!(displayed.starts_with("fatal: "), "{displayed}");
            assert!(displayed.contains("https://"), "{displayed}");
        }
        let message = "fatal: non-fast-forward\nhint: fetch first";
        assert_eq!(redact_git_output(message), message);
        assert_eq!(
            redact_git_output(
                "fatal: unable to access 'https://host/repo?token=secret': Failed to connect"
            ),
            "fatal: unable to access 'https://host/repo': Failed to connect"
        );
    }

    #[test]
    fn malformed_remote_errors_cross_the_ipc_boundary_without_credentials() {
        let (_dir, repo) = repo();
        let error = repo
            .text([
                "ls-remote",
                "--",
                "https://user:secret@bad host/repo.git?access_token=secret",
            ])
            .unwrap_err();
        assert_eq!(error.key, "gitOutput");
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("secret"), "{serialized}");
        assert!(serialized.contains("bad host/repo.git"), "{serialized}");
    }

    #[test]
    fn redacts_credentials_in_every_display_url() {
        for url in [
            "https://user:secret@example.invalid/repo.git?access_token=secret#secret",
            "https://example.invalid/repo.git?access_token=secret",
            "ssh://git@example.invalid/repo.git#secret",
            "https://user:secret@bad host/repo.git?access_token=secret",
        ] {
            let displayed = redact_remote(url);
            assert!(!displayed.contains("secret"), "{displayed}");
        }
        assert_eq!(
            redact_remote("git@example.invalid:owner/repo.git"),
            "git@example.invalid:owner/repo.git"
        );
        assert_eq!(redact_remote("/local/repository"), "/local/repository");
    }

    #[test]
    fn snapshots_and_credential_targets_share_url_redaction() {
        let (_dir, repo) = repo();
        repo.action(Action::AddRemote {
            name: "origin".into(),
            url: "https://user:secret@example.invalid/repo.git?access_token=secret#secret".into(),
        })
        .unwrap();
        let displayed = repo.snapshot().unwrap().remotes.remove(0).url;
        assert_eq!(displayed, "https://example.invalid/repo.git");
        let targets = serde_json::to_value(repo.credential_targets("origin").unwrap()).unwrap();
        assert_eq!(targets[0]["url"], displayed);
        assert!(!targets.to_string().contains("secret"));
    }
}
