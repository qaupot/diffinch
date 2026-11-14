use super::{GitError, Repo, Result};
impl Repo {
    pub(super) fn check_ref(&self, prefix: &str, name: &str) -> Result<()> {
        if name.is_empty() || name.starts_with('-') || name.trim() != name {
            return Err("invalidGitName".into());
        }
        self.run(["check-ref-format", &format!("{prefix}{name}")])?;
        Ok(())
    }

    pub(super) fn branch_target(&self, name: &str, remote: bool) -> Result<String> {
        self.check_ref("refs/heads/", name)?;
        let prefix = if remote { "refs/remotes" } else { "refs/heads" };
        let target = format!("{prefix}/{name}");
        if self
            .run(["show-ref", "--verify", "--quiet", &target])
            .is_ok()
        {
            return Ok(target);
        }
        Err(GitError::new("missingBranch", name))
    }

    pub(super) fn commit_target(&self, id: &str) -> Result<String> {
        validate_oid(id)?;
        self.text([
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{id}^{{commit}}"),
        ])
    }

    pub(super) fn check_stash(&self, id: &str, tip: &str) -> Result<()> {
        validate_stash(id)?;
        validate_oid(tip)?;
        let current = self.text(["rev-parse", "--verify", "--end-of-options", id])?;
        if current != tip {
            return Err("staleStash".into());
        }
        Ok(())
    }

    pub(super) fn switch(&self, name: &str, remote: bool) -> Result<()> {
        self.check_ref("refs/heads/", name)?;
        if remote {
            let target = format!("refs/remotes/{name}");
            self.run(["switch", "--track", "--", &target])?;
        } else {
            self.run(["switch", "--no-guess", "--", name])?;
        }
        Ok(())
    }
}

pub(super) fn validate_oid(id: &str) -> Result<()> {
    if matches!(id.len(), 40 | 64) && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("invalidCommitId".into())
    }
}

pub(super) fn validate_stash(id: &str) -> Result<()> {
    let index = id
        .strip_prefix("stash@{")
        .and_then(|part| part.strip_suffix('}'));
    if index
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Ok(())
    } else {
        Err("invalidStash".into())
    }
}
