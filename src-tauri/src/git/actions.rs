use super::{
    conflicts::{conflict_io, has_conflict_markers},
    model::{Action, HeadTarget, RemoteRefKind, Settings},
    process::execute,
    refs::validate_oid,
    trim_line, Repo, Result, OUTPUT_LIMIT,
};
use std::path::Path;

fn needs_pinentry(detail: &str) -> bool {
    let mut lines = detail.lines();
    if !lines.any(|line| line == "error: gpg failed to sign the data:") {
        return false;
    }
    lines
        .filter_map(|line| line.trim().strip_prefix("gpg:"))
        .any(|message| message.trim() == "signing failed: Inappropriate ioctl for device")
}

impl Repo {
    fn check_head_target(&self, target: &HeadTarget) -> Result<()> {
        let status = self.status()?;
        if status.branch != target.branch || status.head != target.head {
            return Err("staleHistoryAction".into());
        }
        if self.operation()?.is_some() {
            return Err("gitOperationActive".into());
        }
        Ok(())
    }

    fn checked_branch_tip(&self, name: &str, remote: bool, tip: &str) -> Result<String> {
        validate_oid(tip)?;
        let reference = self.branch_target(name, remote)?;
        if self.text(["rev-parse", "--verify", &reference])? != tip {
            return Err("staleHistoryAction".into());
        }
        Ok(reference)
    }

    pub(super) fn save_settings(&self, settings: Settings) -> Result<()> {
        if !matches!(settings.signing_format.as_str(), "openpgp" | "ssh" | "x509") {
            return Err("invalidSigningFormat".into());
        }
        let current = self.settings()?;
        let changes = [
            ("user.name", current.name, settings.name),
            ("user.email", current.email, settings.email),
            (
                "gpg.format",
                current.signing_format,
                settings.signing_format,
            ),
            ("user.signingkey", current.signing_key, settings.signing_key),
            (
                "commit.gpgsign",
                current.sign_commits.to_string(),
                settings.sign_commits.to_string(),
            ),
        ];
        if changes
            .iter()
            .any(|(_, _, value)| value.contains(['\n', '\r', '\0']))
        {
            return Err("invalidSettingsLine".into());
        }
        for (key, old, value) in changes {
            if old != value {
                self.run(["config", "--local", "--replace-all", key, &value])?;
            }
        }
        Ok(())
    }

    pub fn action(&self, action: Action) -> Result<&'static str> {
        let message = match action {
            Action::OpenEditor { file, editor } => {
                self.open_editor(&file, editor)?;
                "editorOpened"
            }
            Action::MergeTool { id } => {
                self.merge_tool(&id)?;
                "mergeToolFinished"
            }
            Action::RepositoryTool { action } => return self.repository_tool_action(action),
            Action::Stage { id } => {
                self.set_files_staged(&[id], true)?;
                "fileStaged"
            }
            Action::Unstage { id } => {
                self.set_files_staged(&[id], false)?;
                "fileUnstaged"
            }
            Action::StageFiles { ids } => {
                self.set_files_staged(&ids, true)?;
                "selectedFilesStaged"
            }
            Action::UnstageFiles { ids } => {
                self.set_files_staged(&ids, false)?;
                "selectedFilesUnstaged"
            }
            Action::StageAll => {
                self.run(["add", "--all"])?;
                "allChangesStaged"
            }
            Action::UnstageAll => {
                self.unstage_all()?;
                "allChangesUnstaged"
            }
            Action::Discard { id, token } => {
                self.discard(&id, &token)?;
                "changesDiscarded"
            }
            Action::ResolveConflict { id, token, text } => {
                let conflict = self.conflict(&id)?;
                if conflict.token != token {
                    return Err("staleConflict".into());
                }
                if text.len() > OUTPUT_LIMIT
                    || text.contains('\0')
                    || has_conflict_markers(&text, conflict.marker_size)
                {
                    return Err("unresolvedConflict".into());
                }
                std::fs::write(self.conflict_path(&id)?, text).map_err(conflict_io)?;
                self.set_files_staged(&[id], true)?;
                "conflictResolved"
            }
            Action::Hunk {
                id,
                staged,
                index,
                token,
                page,
                lines,
            } => {
                self.apply_hunk(
                    &id,
                    staged,
                    index,
                    &token,
                    page.unwrap_or(0),
                    lines.as_deref(),
                )?;
                if lines.is_some() && staged {
                    "linesUnstaged"
                } else if lines.is_some() {
                    "linesStaged"
                } else if staged {
                    "hunkUnstaged"
                } else {
                    "hunkStaged"
                }
            }
            Action::Commit {
                summary,
                description,
                sign,
                amend,
            } => {
                if summary.trim().is_empty() || summary.contains(['\n', '\r']) {
                    return Err("invalidSummary".into());
                }
                if let Some(target) = &amend {
                    let status = self.status()?;
                    if target.head.is_none()
                        || status.branch != target.branch
                        || status.head != target.head
                        || self.operation()?.is_some()
                    {
                        return Err("staleAmend".into());
                    }
                }
                let mut git = self.command();
                git.arg("commit")
                    .arg(if sign { "--gpg-sign" } else { "--no-gpg-sign" });
                if amend.is_some() {
                    git.arg("--amend");
                }
                git.args(["--file", "-"]);
                let message = if description.trim().is_empty() {
                    format!("{}\n", summary.trim())
                } else {
                    format!("{}\n\n{}\n", summary.trim(), description.trim_end())
                };
                execute(git, &[], Some(message.as_bytes())).map_err(|mut error| {
                    if sign
                        && error.key == "gitOutput"
                        && error.detail.as_deref().is_some_and(needs_pinentry)
                    {
                        error.key = "gpgNeedsPinentry";
                    }
                    error
                })?;
                if amend.is_some() {
                    "commitAmended"
                } else {
                    "commitCreated"
                }
            }
            Action::ChangeAuthor {
                branch,
                head,
                id,
                name,
                email,
            } => {
                self.change_author(&branch, &head, &id, &name, &email)?;
                "commitAuthorChanged"
            }
            Action::Fetch => self.fetch(false, None)?,
            Action::FetchPrune => self.fetch(true, None)?,
            Action::Pull => {
                self.run([
                    "pull",
                    "--progress",
                    "--ff-only",
                    "--no-rebase",
                    "--no-autostash",
                ])?;
                "pullComplete"
            }
            Action::PullRebase { target } => {
                self.check_head_target(&target)?;
                self.run(["pull", "--progress", "--rebase", "--ff", "--no-autostash"])?;
                "pullRebaseComplete"
            }
            Action::Push => {
                let status = self.status()?;
                let branch = status.branch.ok_or("pushDetached")?;
                let remote =
                    self.optional_config(&["--get", &format!("branch.{branch}.remote")])?;
                let target = self.optional_config(&["--get", &format!("branch.{branch}.merge")])?;
                if status.upstream.is_none()
                    || remote.is_empty()
                    || !target.starts_with("refs/heads/")
                {
                    return Err("pushUnpublished".into());
                }
                self.run([
                    "push",
                    "--progress",
                    "--porcelain",
                    "--",
                    &remote,
                    &format!("refs/heads/{branch}:{target}"),
                ])?;
                "pushComplete"
            }
            Action::ForcePush { lease } => {
                self.force_push(lease)?;
                "forcePushComplete"
            }
            Action::Publish { remote } => {
                self.tracked_remote(&remote)?;
                let branch = self.status()?.branch.ok_or("publishDetached")?;
                let target = format!("refs/heads/{branch}");
                self.run([
                    "push",
                    "--progress",
                    "--porcelain",
                    "--set-upstream",
                    "--",
                    &remote,
                    &format!("{target}:{target}"),
                ])?;
                "branchPublished"
            }
            Action::CreateBranch {
                name,
                checkout,
                start,
            } => {
                self.check_ref("refs/heads/", &name)?;
                let start = start
                    .as_deref()
                    .map(|id| self.commit_target(id))
                    .transpose()?;
                let mut args = if checkout {
                    vec!["switch", "--create", &name]
                } else {
                    vec!["branch", "--", &name]
                };
                if let Some(start) = &start {
                    args.push(start);
                }
                self.run(args)?;
                "branchCreated"
            }
            Action::SwitchBranch { name, remote } => {
                self.switch(&name, remote)?;
                "branchSwitched"
            }
            Action::DeleteBranch { name } => {
                self.check_ref("refs/heads/", &name)?;
                self.run(["branch", "--delete", "--", &name])?;
                "branchDeleted"
            }
            Action::CreateWorktree {
                parent,
                name,
                mode,
                branch,
                start,
            } => {
                self.create_worktree(Path::new(&parent), &name, mode, &branch, &start)?;
                "worktreeCreated"
            }
            Action::RemoveWorktree { path, head, branch } => {
                self.remove_worktree(&path, head.as_deref(), branch.as_deref())?;
                "worktreeRemoved"
            }
            Action::Merge {
                name,
                remote,
                tip,
                target,
            } => {
                self.check_head_target(&target)?;
                let reference = self.checked_branch_tip(&name, remote, &tip)?;
                self.run(["merge", "--no-edit", "--", &reference])?;
                "mergeComplete"
            }
            Action::Rebase {
                name,
                remote,
                tip,
                target,
            } => {
                self.check_head_target(&target)?;
                self.checked_branch_tip(&name, remote, &tip)?;
                self.run(["rebase", "--", &tip])?;
                "rebaseComplete"
            }
            Action::InteractiveRebase {
                branch,
                head,
                base,
                from_root,
                steps,
            } => {
                self.interactive_rebase(&branch, &head, &base, from_root, steps)?;
                "rebaseComplete"
            }
            Action::CherryPick { id, target } => {
                self.check_head_target(&target)?;
                validate_oid(&id)?;
                self.run(["cherry-pick", &id])?;
                "commitCherryPicked"
            }
            Action::Revert { id, target } => {
                self.check_head_target(&target)?;
                validate_oid(&id)?;
                self.run(["revert", "--no-edit", &id])?;
                "commitReverted"
            }
            Action::Stash {
                message,
                include_untracked,
            } => {
                let mut git = self.command();
                git.args(["stash", "push"]);
                if include_untracked {
                    git.arg("--include-untracked");
                }
                if !message.trim().is_empty() {
                    git.args(["--message", message.trim()]);
                }
                let output = execute(git, &[], None)?;
                if trim_line(&output.bytes) == b"No local changes to save" {
                    "nothingToStash"
                } else {
                    "stashSaved"
                }
            }
            Action::ApplyStash { id, tip } => {
                self.check_stash(&id, &tip)?;
                self.run(["stash", "apply", "--index", "--", &tip])?;
                "stashApplied"
            }
            Action::PopStash { id, tip } => {
                self.check_stash(&id, &tip)?;
                self.run(["stash", "apply", "--index", "--", &tip])?;
                // Applying can take time. Do not drop a different entry if another
                // Git client changed the stash list while it was running.
                self.check_stash(&id, &tip)?;
                self.run(["stash", "drop", "--", &id])?;
                "stashRestored"
            }
            Action::DropStash { id, tip } => {
                self.check_stash(&id, &tip)?;
                self.run(["stash", "drop", "--", &id])?;
                "stashDropped"
            }
            Action::CreateTag { name, start } => {
                self.check_ref("refs/tags/", &name)?;
                if let Some(start) = start {
                    self.run([
                        "tag",
                        "--no-sign",
                        "--",
                        &name,
                        &self.commit_target(&start)?,
                    ])?;
                } else {
                    self.run(["tag", "--no-sign", "--", &name])?;
                }
                "tagCreated"
            }
            Action::DeleteTag { name } => {
                self.check_ref("refs/tags/", &name)?;
                self.run(["tag", "--delete", "--", &name])?;
                "tagDeleted"
            }
            Action::DeleteRemoteRef {
                remote,
                ref_kind,
                name,
                tip,
                destination,
            } => {
                self.delete_remote_ref(&remote, ref_kind, &name, &tip, &destination)?;
                match ref_kind {
                    RemoteRefKind::Branch => "remoteBranchDeleted",
                    RemoteRefKind::Tag => "remoteTagDeleted",
                }
            }
            Action::AddRemote { name, url } => {
                self.check_ref("refs/remotes/", &name)?;
                if url.trim().is_empty() {
                    return Err("missingRemoteUrl".into());
                }
                self.run(["remote", "add", "--", &name, url.trim()])?;
                "remoteAdded"
            }
            Action::RemoveRemote { name } => {
                self.tracked_remote(&name)?;
                self.run(["remote", "remove", "--", &name])?;
                "remoteRemoved"
            }
            Action::SaveSettings { settings } => {
                self.save_settings(settings)?;
                "settingsSaved"
            }
            Action::ConfigureMacPinentry => {
                #[cfg(target_os = "macos")]
                {
                    super::pinentry::configure(self)?;
                    "macPinentryConfigured"
                }
                #[cfg(not(target_os = "macos"))]
                return Err("gpgNeedsPinentry".into());
            }
            Action::ConfigureCredentialHelper {
                remote,
                destination,
                helper,
                token,
            } => {
                self.configure_credential_helper(&remote, &destination, helper, &token)?;
                "credentialHelperSaved"
            }
            Action::ContinueOperation => {
                let operation = self.operation()?.ok_or("noOperation")?;
                if operation == "rebase" {
                    self.resume_rebase("--continue")?;
                } else {
                    self.run([&operation, "--continue"])?;
                }
                "operationCompleted"
            }
            Action::SkipRebase => {
                if self.operation()?.as_deref() != Some("rebase") {
                    return Err("noOperation".into());
                }
                self.resume_rebase("--skip")?;
                "rebaseCommitSkipped"
            }
            Action::AbortOperation => {
                let operation = self.operation()?.ok_or("noOperation")?;
                self.run([&operation, "--abort"])?;
                "operationAborted"
            }
        };
        Ok(message)
    }
}
