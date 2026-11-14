use super::{
    model::{RebaseCommit, RebaseOperation, RebasePlan, RebaseStep},
    process::execute,
    trim_line, GitError, Repo, Result,
};
use std::{collections::HashSet, io, path::Path, process::Command};
const REBASE_LIMIT: usize = 200;
pub(super) const REBASE_MESSAGES: &str = "rebase-merge/diffinch-messages";
fn reword_editor(git: &mut Command, messages: &Path) {
    // Use a control character for Git's generated comments so user text such
    // as "#123" survives rewording while Git still cleans up squash templates.
    git.args([
        "-c",
        "core.commentChar=\x1f",
        "-c",
        "core.commentString=\x1f",
    ])
    .env("DIFFINCH_REBASE_MESSAGES", messages)
    .env(
        "GIT_EDITOR",
        r#"sh -c '
                last=$(tail -n 1 "$DIFFINCH_REBASE_MESSAGES/../done") || exit 1
                case "$last" in
                    "reword "*) commit=${last#reword };;
                    *) exit 0;;
                esac
                case "$commit" in ""|*[!0-9a-f]*) exit 1;; esac
                cat "$DIFFINCH_REBASE_MESSAGES/$commit" > "$1"
            ' -"#,
    );
}

impl Repo {
    pub fn rebase_plan(&self, base: &str, from_root: bool) -> Result<RebasePlan> {
        if self.operation()?.is_some() {
            return Err("gitOperationActive".into());
        }
        let status = self.status()?;
        let branch = status.branch.ok_or("rebaseNeedsBranch")?;
        let head = status.head.ok_or("rebaseNeedsBranch")?;
        if status.files.iter().any(|file| file.worktree != '?') {
            return Err("rebaseNeedsCleanTree".into());
        }
        let base = self.commit_target(base)?;
        let mut git = self.command();
        git.args(["merge-base", &base, &head]);
        let ancestor = execute(git, &[1], None)?;
        if trim_line(&ancestor.bytes) != base.as_bytes() {
            return Err("rebaseBaseNotAncestor".into());
        }
        let range = if from_root {
            // A shallow boundary appears parentless in the graph. Read the
            // commit header to distinguish it from an actual root commit.
            let commit = self.run(["cat-file", "commit", &base])?;
            let has_parent = commit
                .bytes
                .split(|&byte| byte == b'\n')
                .take_while(|line| !line.is_empty())
                .any(|line| line.starts_with(b"parent "));
            if has_parent {
                return Err("rebaseNeedsRoot".into());
            }
            head.clone()
        } else {
            format!("{base}..{head}")
        };
        let log = self.text([
            "log",
            "--no-show-signature",
            "--topo-order",
            "--reverse",
            "-z",
            "--format=%H%x00%h%x00%P%x00%s",
            &format!("--max-count={}", REBASE_LIMIT + 1),
            &range,
            "--",
        ])?;
        if log.is_empty() {
            return Err("rebaseNoCommits".into());
        }
        let records = log.split_terminator('\0').collect::<Vec<_>>();
        let (records, trailing) = records.as_chunks::<4>();
        if records.len() > REBASE_LIMIT {
            return Err("rebaseTooManyCommits".into());
        }
        if !trailing.is_empty() {
            return Err("invalidRebasePlan".into());
        }
        let mut commits = Vec::with_capacity(records.len());
        for [id, short_id, parents, subject] in records {
            if parents.contains(' ') {
                return Err("rebaseContainsMerge".into());
            }
            commits.push(RebaseCommit {
                id: (*id).into(),
                short_id: (*short_id).into(),
                subject: (*subject).into(),
            });
        }
        Ok(RebasePlan {
            branch,
            head,
            base,
            from_root,
            commits,
        })
    }

    pub(super) fn interactive_rebase(
        &self,
        branch: &str,
        head: &str,
        base: &str,
        from_root: bool,
        steps: Vec<RebaseStep>,
    ) -> Result<()> {
        let plan = self.rebase_plan(base, from_root)?;
        if plan.branch != branch || plan.head != head {
            return Err("staleRebasePlan".into());
        }
        let mut remaining: HashSet<_> = plan
            .commits
            .iter()
            .map(|commit| commit.id.as_str())
            .collect();
        let mut has_previous = false;
        let mut todo = String::new();
        let mut rewords = Vec::new();
        for step in &steps {
            if !remaining.remove(step.id.as_str()) {
                return Err("invalidRebasePlan".into());
            }
            let operation = match &step.operation {
                RebaseOperation::Pick => {
                    has_previous = true;
                    "pick"
                }
                RebaseOperation::Reword { message } => {
                    if message.trim().is_empty() || message.contains('\0') {
                        return Err("invalidRebaseMessage".into());
                    }
                    has_previous = true;
                    rewords.push((&step.id, message));
                    "reword"
                }
                RebaseOperation::Squash if has_previous => "squash",
                RebaseOperation::Fixup if has_previous => "fixup",
                RebaseOperation::Drop => "drop",
                _ => return Err("invalidRebasePlan".into()),
            };
            todo.push_str(&format!("{operation} {}\n", step.id));
        }
        if !remaining.is_empty() {
            return Err("invalidRebasePlan".into());
        }
        // Git would otherwise leave its temporary empty root as the branch tip.
        if plan.from_root && !has_previous {
            return Err("rebaseKeepRootHistory".into());
        }
        // Git invokes a shell for this fixed editor command. Todo data is passed
        // separately and consists only of validated object IDs and typed operations.
        let mut git = self.command();
        let drafts = if rewords.is_empty() {
            None
        } else {
            let io_error = |error: io::Error| GitError::new("gitIoFailed", error);
            let drafts = tempfile::tempdir().map_err(io_error)?;
            for (id, message) in rewords {
                std::fs::write(drafts.path().join(id), message).map_err(io_error)?;
            }
            reword_editor(&mut git, &self.git_dir()?.join(REBASE_MESSAGES));
            Some(drafts)
        };
        git.env_remove("DIFFINCH_REBASE_DRAFTS")
            .env("DIFFINCH_REBASE_TODO", todo)
            .env(
                "GIT_SEQUENCE_EDITOR",
                r#"sh -c '
                    if [ -n "$DIFFINCH_REBASE_DRAFTS" ]; then
                        cp -R "$DIFFINCH_REBASE_DRAFTS" "$DIFFINCH_REBASE_MESSAGES" || exit 1
                    fi
                    printf "%s" "$DIFFINCH_REBASE_TODO" > "$1"
                ' -"#,
            );
        if let Some(drafts) = &drafts {
            // Keep the edits in Git's per-worktree rebase state until completion
            // or abort, including when a conflict interrupts the rebase.
            git.env("DIFFINCH_REBASE_DRAFTS", drafts.path());
        }
        git.args([
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.missingCommitsCheck=error",
            "rebase",
            "--interactive",
            "--no-rebase-merges",
            "--no-autosquash",
            "--no-autostash",
            "--reapply-cherry-picks",
        ]);
        if plan.from_root {
            git.arg("--root");
        } else {
            git.args(["--", &plan.base]);
        }
        execute(git, &[], None)?;
        Ok(())
    }

    pub(super) fn resume_rebase(&self, option: &str) -> Result<()> {
        let messages = self.git_dir()?.join(REBASE_MESSAGES);
        let mut git = self.command();
        if messages.is_dir() {
            reword_editor(&mut git, &messages);
        }
        git.args(["rebase", option]);
        execute(git, &[], None)?;
        Ok(())
    }
}
