use super::{model::DiscardPlan, process::check_operation, GitError, Repo, Result};
use std::{
    collections::hash_map::DefaultHasher,
    ffi::{OsStr, OsString},
    fs,
    hash::{Hash, Hasher},
    io::{self, Read},
    path::Path,
};

fn io_error(error: io::Error) -> GitError {
    GitError::new("gitIoFailed", error)
}

// Hash actual worktree bytes, including binary and filtered files. A rendered
// diff can be truncated or identical for two different binary contents.
fn hash_path(path: &Path, root: &Path, hash: &mut DefaultHasher) -> Result<()> {
    for parent in path.ancestors().skip(1).take_while(|path| *path != root) {
        match parent.symlink_metadata() {
            Ok(metadata) if !metadata.is_dir() => return Err("invalidDiscard".into()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(io_error(error)),
            _ => {}
        }
    }
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            "missing".hash(hash);
            return Ok(());
        }
        Err(error) => return Err(io_error(error)),
    };
    if metadata.is_symlink() {
        "symlink".hash(hash);
        fs::read_link(path).map_err(io_error)?.hash(hash);
    } else if metadata.is_file() {
        "file".hash(hash);
        metadata.permissions().readonly().hash(hash);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode().hash(hash);
        }
        let mut file = fs::File::open(path).map_err(io_error)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            check_operation()?;
            let count = file.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            hash.write(&buffer[..count]);
        }
    } else {
        return Err("invalidDiscard".into());
    }
    Ok(())
}

impl Repo {
    fn discard_state(&self, id: &str) -> Result<(DiscardPlan, Vec<OsString>)> {
        let (file, paths) = self.file(id)?;
        if file.conflict || file.submodule || matches!(file.worktree, '?' | '.') {
            return Err("invalidDiscard".into());
        }
        let paths = Self::working_paths(&file, &paths).to_vec();
        let index = self.run(
            ["--literal-pathspecs", "ls-files", "--stage", "-z", "--"]
                .iter()
                .map(OsStr::new)
                .chain(paths.iter().map(OsString::as_os_str)),
        )?;
        if index.truncated {
            return Err("tooManyPaths".into());
        }
        let mut hash = DefaultHasher::new();
        id.hash(&mut hash);
        file.index.hash(&mut hash);
        file.worktree.hash(&mut hash);
        index.bytes.hash(&mut hash);
        for path in &paths {
            path.hash(&mut hash);
            hash_path(&self.root().join(path), self.root(), &mut hash)?;
        }
        Ok((
            DiscardPlan {
                id: id.into(),
                token: format!("{:016x}", hash.finish()),
            },
            paths,
        ))
    }

    pub fn discard_plan(&self, id: &str) -> Result<DiscardPlan> {
        self.discard_state(id).map(|(plan, _)| plan)
    }

    pub(super) fn discard(&self, id: &str, token: &str) -> Result<()> {
        let (plan, paths) = self.discard_state(id)?;
        if plan.token != token {
            return Err("staleDiscard".into());
        }
        self.run(
            ["--literal-pathspecs", "restore", "--worktree", "--"]
                .iter()
                .map(OsStr::new)
                .chain(paths.iter().map(OsString::as_os_str)),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{
        model::Action,
        tests::{commit_file, repo},
        OUTPUT_LIMIT,
    };

    fn request(plan: DiscardPlan) -> Action {
        Action::Discard {
            id: plan.id,
            token: plan.token,
        }
    }

    #[test]
    fn rejects_edits_after_confirmation_and_allows_a_fresh_confirmation() {
        let (dir, repo) = repo();
        commit_file(&repo, "notes.txt", "baseline\n", "Baseline");
        let path = dir.path().join("notes.txt");
        fs::write(&path, "reviewed edit\n").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let plan = repo.discard_plan(&id).unwrap();
        fs::write(&path, "new edit after confirmation\n").unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "new edit after confirmation\n"
        );
        assert_eq!(repo.text(["show", ":notes.txt"]).unwrap(), "baseline");
        repo.action(request(repo.discard_plan(&id).unwrap()))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "baseline\n");
    }

    #[test]
    fn rejects_binary_and_large_file_edits_beyond_the_diff_limit() {
        let (dir, repo) = repo();
        commit_file(&repo, "data.bin", "baseline\n", "Baseline");
        let path = dir.path().join("data.bin");
        let mut contents = vec![0; OUTPUT_LIMIT + 100];
        fs::write(&path, &contents).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let plan = repo.discard_plan(&id).unwrap();
        *contents.last_mut().unwrap() = 1;
        fs::write(&path, &contents).unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        assert_eq!(fs::read(&path).unwrap(), contents);
        repo.action(request(repo.discard_plan(&id).unwrap()))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "baseline\n");
    }

    #[test]
    fn rejects_a_changed_restore_source_even_when_worktree_bytes_are_unchanged() {
        let (dir, repo) = repo();
        commit_file(&repo, "notes.txt", "baseline\n", "Baseline");
        let path = dir.path().join("notes.txt");
        fs::write(&path, "first staged version\n").unwrap();
        repo.action(Action::StageAll).unwrap();
        fs::write(&path, "working\n").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let plan = repo.discard_plan(&id).unwrap();
        fs::write(&path, "second staged version\n").unwrap();
        repo.action(Action::StageAll).unwrap();
        fs::write(&path, "working\n").unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "working\n");
        assert_eq!(
            repo.text(["show", ":notes.txt"]).unwrap(),
            "second staged version"
        );
    }

    #[test]
    fn rejects_recreated_deleted_files_and_can_restore_an_unchanged_deletion() {
        let (dir, repo) = repo();
        commit_file(&repo, "notes.txt", "baseline\n", "Baseline");
        let path = dir.path().join("notes.txt");
        fs::remove_file(&path).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let plan = repo.discard_plan(&id).unwrap();
        fs::write(&path, "recreated\n").unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "recreated\n");
        fs::remove_file(&path).unwrap();
        repo.action(request(repo.discard_plan(&id).unwrap()))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "baseline\n");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_retargets_and_mode_changes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (dir, repo) = repo();
        commit_file(&repo, "notes.txt", "baseline\n", "Baseline");
        let path = dir.path().join("notes.txt");
        fs::write(&path, "working\n").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let plan = repo.discard_plan(&id).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        fs::remove_file(&path).unwrap();
        symlink("missing-first", &path).unwrap();
        let plan = repo.discard_plan(&id).unwrap();
        fs::remove_file(&path).unwrap();
        symlink("missing-second", &path).unwrap();
        assert!(repo
            .action(request(plan))
            .is_err_and(|error| error.key == "staleDiscard"));
        assert_eq!(fs::read_link(&path).unwrap(), Path::new("missing-second"));
    }

    #[test]
    fn a_discard_request_requires_a_confirmation_token() {
        assert!(serde_json::from_value::<Action>(serde_json::json!({
            "kind": "discard", "id": "tracked:bm90ZXMudHh0"
        }))
        .is_err());
    }
}
