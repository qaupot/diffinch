use super::{bytes_to_os, model::FileChange, process::execute, Repo, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
};
impl Repo {
    pub(super) fn file(&self, id: &str) -> Result<(FileChange, Vec<OsString>)> {
        let file = self
            .status()?
            .files
            .into_iter()
            .find(|file| file.id == id)
            .ok_or("changeMissing")?;
        Ok((file, Self::file_paths(id)?))
    }

    pub(super) fn file_paths(id: &str) -> Result<Vec<OsString>> {
        let (_, encoded_paths) = id.split_once(':').ok_or("invalidGitPath")?;
        encoded_paths
            .split('.')
            .map(|encoded| {
                let bytes = URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| "invalidGitPath")?;
                bytes_to_os(&bytes)
            })
            .collect()
    }

    pub(super) fn change_paths<'a>(
        file: &FileChange,
        paths: &'a [OsString],
        staged: bool,
    ) -> &'a [OsString] {
        let code = if staged { file.index } else { file.worktree };
        // Renames change both endpoints. A copy's source is an independent entry.
        if code == 'R' {
            paths
        } else {
            &paths[..1]
        }
    }

    pub(super) fn set_files_staged(&self, ids: &[String], stage: bool) -> Result<()> {
        if ids.is_empty() {
            return Err("changeMissing".into());
        }
        let status = self.status()?;
        let files: HashMap<_, _> = status
            .files
            .iter()
            .map(|file| (file.id.as_str(), file))
            .collect();
        let mut selected = Vec::with_capacity(ids.len());
        for id in ids {
            let file = files
                .get(id.as_str())
                .copied()
                .filter(|file| {
                    if stage {
                        file.worktree != '.' || file.conflict
                    } else {
                        file.index != '.' && !file.conflict
                    }
                })
                .ok_or("changeMissing")?;
            selected.push(file);
        }
        self.stage_paths(selected, stage, &status.files)
    }

    pub(super) fn unstage_all(&self) -> Result<()> {
        let status = self.status()?;
        let staged = status
            .files
            .iter()
            .filter(|file| file.index != '.' && !file.conflict);
        self.stage_paths(staged, false, &status.files)
    }

    fn stage_paths<'a>(
        &self,
        files: impl IntoIterator<Item = &'a FileChange>,
        stage: bool,
        status: &[FileChange],
    ) -> Result<()> {
        let mut selected = HashMap::new();
        for file in files {
            let paths = Self::file_paths(&file.id)?;
            for path in Self::change_paths(file, &paths, !stage) {
                selected.insert(PathBuf::from(path), stage && file.worktree == 'D');
            }
        }
        if selected.is_empty() {
            return Ok(());
        }
        let parents: HashSet<&Path> = selected
            .keys()
            .flat_map(|p| p.ancestors().skip(1))
            .collect();
        // A Git index cannot hold both a file and one of its children. Refuse
        // an update that would implicitly replace another staged entry.
        for file in status.iter().filter(|f| f.index != '.' || f.conflict) {
            let paths = Self::file_paths(&file.id)?;
            for (i, path) in Self::change_paths(file, &paths, true).iter().enumerate() {
                let path = Path::new(path);
                if selected.contains_key(path) {
                    continue;
                }
                let in_index = file.index != 'D' && i == 0;
                if (in_index && parents.contains(path))
                    || ((!stage || in_index)
                        && path.ancestors().skip(1).any(|p| selected.contains_key(p)))
                {
                    return Err("overlappingIndexChanges".into());
                }
            }
        }

        let mut pathspecs = Vec::new();
        for (path, deleting) in &selected {
            let bytes = path.as_os_str().as_encoded_bytes();
            if *deleting {
                // Adding a selected child already stages the file's removal.
                // Otherwise exclude the replacement directory's contents.
                if parents.contains(path.as_path()) {
                    continue;
                }
                pathspecs.extend_from_slice(b":(exclude,literal)");
                pathspecs.extend_from_slice(bytes);
                pathspecs.extend_from_slice(b"/\0");
            }
            pathspecs.extend_from_slice(b":(literal)");
            pathspecs.extend_from_slice(bytes);
            pathspecs.push(0);
        }

        let mut git = self.command();
        git.args(if stage {
            ["add", "-A"]
        } else {
            ["reset", "--quiet"]
        });
        git.args(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        execute(git, &[], Some(&pathspecs))?;
        Ok(())
    }
}
