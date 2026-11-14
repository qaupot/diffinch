use super::{process::execute, GitError, Repo, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct Worktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    main: bool,
    current: bool,
    bare: bool,
    locked: Option<String>,
    prunable: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeMode {
    NewBranch,
    ExistingBranch,
    Detached,
}

fn parse_worktrees(bytes: &[u8], root: &Path) -> Result<Vec<Worktree>> {
    // -z keeps paths and lock reasons containing tabs, newlines or quotes intact.
    let output = std::str::from_utf8(bytes).map_err(|_| "repoPathEncoding")?;
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut worktrees = Vec::new();
    let mut entry = Worktree::default();
    for field in output.split_terminator('\0') {
        if field.is_empty() {
            if !entry.path.is_empty() {
                entry.main = worktrees.is_empty();
                entry.current = Path::new(&entry.path)
                    .canonicalize()
                    .is_ok_and(|path| path == root);
                worktrees.push(std::mem::take(&mut entry));
            }
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        match key {
            "worktree" => entry.path = value.into(),
            "HEAD" if !value.bytes().all(|byte| byte == b'0') => entry.head = Some(value.into()),
            "branch" => entry.branch = value.strip_prefix("refs/heads/").map(str::to_owned),
            "bare" => entry.bare = true,
            "locked" => entry.locked = Some(value.into()),
            "prunable" => entry.prunable = Some(value.into()),
            _ => {}
        }
    }
    Ok(worktrees)
}

impl Repo {
    pub(super) fn worktrees(&self) -> Result<Vec<Worktree>> {
        let output = self.run(["worktree", "list", "--porcelain", "-z"])?;
        if output.truncated {
            return Err("tooMuchData".into());
        }
        parse_worktrees(&output.bytes, self.root())
    }

    pub(super) fn create_worktree(
        &self,
        parent: &Path,
        name: &str,
        mode: WorktreeMode,
        branch: &str,
        start: &str,
    ) -> Result<()> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
            || name.contains(['/', '\\'])
            || name.trim() != name
            || !parent.is_absolute()
        {
            return Err("invalidWorktreeFolder".into());
        }
        let parent = parent
            .canonicalize()
            .map_err(|error| GitError::new("gitIoFailed", error))?;
        let destination = parent.join(name);
        if destination.symlink_metadata().is_ok() {
            return Err("worktreeDestinationExists".into());
        }
        let mut git = self.command();
        git.args(["worktree", "add"]);
        match mode {
            WorktreeMode::ExistingBranch => {
                self.branch_target(branch, false)?;
                // Pass the local branch name so Git attaches HEAD and enforces occupancy.
                git.arg("--").arg(&destination).arg(branch);
            }
            WorktreeMode::NewBranch | WorktreeMode::Detached => {
                let start = self.text([
                    "rev-parse",
                    "--verify",
                    "--end-of-options",
                    &format!(
                        "{}^{{commit}}",
                        if start.is_empty() { "HEAD" } else { start }
                    ),
                ])?;
                if matches!(mode, WorktreeMode::NewBranch) {
                    self.check_ref("refs/heads/", branch)?;
                    git.args(["-b", branch]);
                } else {
                    git.arg("--detach");
                }
                git.arg("--").arg(&destination).arg(start);
            }
        }
        execute(git, &[], None)?;
        Ok(())
    }

    pub(super) fn remove_worktree(
        &self,
        path: &str,
        head: Option<&str>,
        branch: Option<&str>,
    ) -> Result<()> {
        let worktree = self
            .worktrees()?
            .into_iter()
            .find(|entry| entry.path == path)
            .ok_or("staleWorktree")?;
        if worktree.main || worktree.current || worktree.bare || worktree.locked.is_some() {
            return Err("protectedWorktree".into());
        }
        if worktree.head.as_deref() != head || worktree.branch.as_deref() != branch {
            return Err("staleWorktree".into());
        }
        // Never force removal: Git must refuse tracked changes, untracked files and submodules.
        self.run(["worktree", "remove", "--", &worktree.path])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{Action, DiffOptions};
    use super::*;

    fn fixture() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main");
        std::fs::create_dir(&root).unwrap();
        let repo = Repo::init(&root).unwrap();
        for (key, value) in [
            ("user.name", "Worktree Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ".git/no-test-hooks"),
            ("core.autocrlf", "false"),
        ] {
            repo.run(["config", "--local", key, value]).unwrap();
        }
        std::fs::write(root.join("notes.txt"), "baseline\n").unwrap();
        repo.run(["add", "."]).unwrap();
        repo.run(["commit", "-m", "Baseline"]).unwrap();
        (dir, repo)
    }

    fn remove_action(worktree: &Worktree) -> Action {
        Action::RemoveWorktree {
            path: worktree.path.clone(),
            head: worktree.head.clone(),
            branch: worktree.branch.clone(),
        }
    }

    #[test]
    fn creates_opens_and_commits_in_independent_worktrees() {
        let (dir, repo) = fixture();
        repo.action(Action::CreateWorktree {
            parent: dir.path().to_string_lossy().into(),
            name: "feature tree".into(),
            mode: WorktreeMode::NewBranch,
            branch: "feature/topic".into(),
            start: "HEAD".into(),
        })
        .unwrap();
        let linked = Repo::discover(dir.path().join("feature tree")).unwrap();
        assert!(linked.root().join(".git").is_file());
        assert_eq!(repo.common_dir().unwrap(), linked.common_dir().unwrap());
        assert_ne!(repo.git_dir().unwrap(), linked.git_dir().unwrap());
        let snapshot = linked.snapshot().unwrap();
        assert_eq!(snapshot.status.branch.as_deref(), Some("feature/topic"));
        assert_eq!(snapshot.worktrees.len(), 2);
        assert!(snapshot.worktrees[0].main && !snapshot.worktrees[0].current);
        assert!(snapshot.worktrees[1].current && !snapshot.worktrees[1].main);

        std::fs::write(linked.root().join("notes.txt"), "linked change\n").unwrap();
        linked.action(Action::StageAll).unwrap();
        let file = linked.status().unwrap().files.remove(0);
        assert_eq!(file.index, 'M');
        assert!(linked
            .file_diff(&file.id, true, DiffOptions::default())
            .unwrap()
            .text
            .contains("+linked change"));
        assert!(repo.status().unwrap().files.is_empty());
        linked.run(["commit", "-m", "Linked commit"]).unwrap();
        assert_ne!(repo.status().unwrap().head, linked.status().unwrap().head);
        assert!(repo
            .snapshot()
            .unwrap()
            .commits
            .iter()
            .any(|commit| commit.subject == "Linked commit"));
        assert_eq!(
            std::fs::read_to_string(repo.root().join("notes.txt")).unwrap(),
            "baseline\n"
        );

        repo.run(["branch", "existing"]).unwrap();
        repo.create_worktree(
            dir.path(),
            "existing tree",
            WorktreeMode::ExistingBranch,
            "existing",
            "",
        )
        .unwrap();
        assert_eq!(
            Repo::discover(dir.path().join("existing tree"))
                .unwrap()
                .status()
                .unwrap()
                .branch
                .as_deref(),
            Some("existing")
        );
        repo.create_worktree(
            dir.path(),
            "detached tree",
            WorktreeMode::Detached,
            "",
            "feature/topic",
        )
        .unwrap();
        let detached = Repo::discover(dir.path().join("detached tree")).unwrap();
        assert!(detached.status().unwrap().branch.is_none());
        assert_eq!(
            detached.status().unwrap().head,
            linked.status().unwrap().head
        );
    }

    #[test]
    fn removal_preserves_dirty_locked_current_and_main_checkouts() {
        let (dir, repo) = fixture();
        repo.create_worktree(
            dir.path(),
            "linked",
            WorktreeMode::NewBranch,
            "topic",
            "HEAD",
        )
        .unwrap();
        let linked = Repo::discover(dir.path().join("linked")).unwrap();
        let listing = repo.worktrees().unwrap();
        assert!(repo
            .action(remove_action(&listing[0]))
            .is_err_and(|error| error.key == "protectedWorktree"));
        assert!(linked
            .action(remove_action(&listing[1]))
            .is_err_and(|error| error.key == "protectedWorktree"));
        std::fs::write(linked.root().join("notes.txt"), "dirty\n").unwrap();
        assert!(repo.action(remove_action(&listing[1])).is_err());
        assert_eq!(
            std::fs::read_to_string(linked.root().join("notes.txt")).unwrap(),
            "dirty\n"
        );
        linked.run(["restore", "notes.txt"]).unwrap();
        std::fs::write(linked.root().join("untracked.txt"), "keep me").unwrap();
        assert!(repo.action(remove_action(&listing[1])).is_err());
        std::fs::remove_file(linked.root().join("untracked.txt")).unwrap();
        repo.run(["worktree", "lock", "--", &listing[1].path])
            .unwrap();
        assert!(repo
            .action(remove_action(&listing[1]))
            .is_err_and(|error| error.key == "protectedWorktree"));
        repo.run(["worktree", "unlock", "--", &listing[1].path])
            .unwrap();
        linked
            .run(["commit", "--allow-empty", "-m", "New tip"])
            .unwrap();
        assert!(repo
            .action(remove_action(&listing[1]))
            .is_err_and(|error| error.key == "staleWorktree"));
        repo.action(remove_action(&repo.worktrees().unwrap()[1]))
            .unwrap();
        assert!(!linked.root().exists());
        assert_eq!(repo.worktrees().unwrap().len(), 1);
        repo.run(["show-ref", "--verify", "refs/heads/topic"])
            .unwrap();
        assert!(repo
            .action(remove_action(&listing[1]))
            .is_err_and(|error| error.key == "staleWorktree"));
    }

    #[test]
    fn rejects_occupied_branches_invalid_destinations_and_invalid_starts() {
        let (dir, repo) = fixture();
        let head = repo.status().unwrap().head;
        assert!(repo
            .create_worktree(
                dir.path(),
                "occupied",
                WorktreeMode::ExistingBranch,
                "main",
                ""
            )
            .is_err());
        assert!(!dir.path().join("occupied").exists());
        for name in ["../escape", ".", "", "two/parts", "two\\parts", "../"] {
            assert!(repo
                .create_worktree(dir.path(), name, WorktreeMode::NewBranch, "invalid", "HEAD")
                .is_err());
        }
        assert!(repo
            .create_worktree(
                dir.path(),
                "main",
                WorktreeMode::NewBranch,
                "invalid",
                "HEAD"
            )
            .is_err_and(|error| error.key == "worktreeDestinationExists"));
        assert!(repo
            .create_worktree(
                dir.path(),
                "invalid",
                WorktreeMode::NewBranch,
                "main",
                "HEAD"
            )
            .is_err());
        assert!(repo
            .create_worktree(
                dir.path(),
                "invalid",
                WorktreeMode::NewBranch,
                "invalid",
                "--help"
            )
            .is_err());
        assert!(repo
            .create_worktree(
                dir.path(),
                "invalid",
                WorktreeMode::NewBranch,
                "--force",
                "HEAD"
            )
            .is_err());
        assert!(!dir.path().join("invalid").exists());
        assert_eq!(repo.status().unwrap().head, head);
        assert_eq!(repo.worktrees().unwrap().len(), 1);
        assert!(repo
            .remove_worktree("main", head.as_deref(), Some("main"))
            .is_err_and(|error| error.key == "staleWorktree"));
    }

    #[test]
    fn lists_unusual_paths_lock_reasons_and_missing_worktrees() {
        let (dir, repo) = fixture();
        let name = if cfg!(windows) {
            "한글 space tree"
        } else {
            "한글 space\t\n\"tree"
        };
        repo.create_worktree(dir.path(), name, WorktreeMode::Detached, "", "HEAD")
            .unwrap();
        let path = dir
            .path()
            .canonicalize()
            .unwrap()
            .join(name)
            .to_str()
            .unwrap()
            .to_owned();
        let reason = "on a drive\nwith a \"name\"";
        repo.run(["worktree", "lock", "--reason", reason, "--", &path])
            .unwrap();
        let entries = repo.worktrees().unwrap();
        assert_eq!(
            Path::new(&entries[1].path).canonicalize().unwrap(),
            Path::new(&path).canonicalize().unwrap()
        );
        assert_eq!(entries[1].locked.as_deref(), Some(reason));
        assert!(entries[1].branch.is_none());
        repo.run(["worktree", "unlock", "--", &path]).unwrap();
        std::fs::remove_dir_all(&path).unwrap();
        assert!(repo.worktrees().unwrap()[1].prunable.is_some());
    }

    #[test]
    fn parses_unusual_worktree_paths_without_line_splitting() {
        let parsed = parse_worktrees(
            b"worktree /space\t\n\"tree\0HEAD abcd\0detached\0locked reason\nwith a \"quote\"\0\0",
            Path::new("/missing"),
        )
        .unwrap();
        assert_eq!(parsed[0].path, "/space\t\n\"tree");
        assert_eq!(
            parsed[0].locked.as_deref(),
            Some("reason\nwith a \"quote\"")
        );
    }

    #[test]
    fn lists_unborn_and_bare_main_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo::init(dir.path()).unwrap();
        let snapshot = repo.snapshot().unwrap();
        assert!(snapshot.worktrees[0].head.is_none());
        assert!(snapshot.worktrees[0].main && snapshot.worktrees[0].current);
        assert_eq!(snapshot.worktrees[0].branch.as_deref(), Some("main"));
        let parsed = parse_worktrees(
            b"worktree /bare\0bare\0\0worktree /linked\0HEAD abcd\0detached\0locked\0\0",
            Path::new("/linked"),
        )
        .unwrap();
        assert!(parsed[0].main && parsed[0].bare);
        assert!(!parsed[1].main && !parsed[1].bare);
        assert_eq!(parsed[1].locked.as_deref(), Some(""));
    }
}
