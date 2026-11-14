use super::{bytes_to_os, model::FileChange, process::execute, Repo, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{collections::HashMap, ffi::OsString};
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

    pub(super) fn working_paths<'a>(file: &FileChange, paths: &'a [OsString]) -> &'a [OsString] {
        if matches!(file.worktree, 'R' | 'C') {
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
        let mut pathspecs = Vec::new();
        for id in ids {
            let file = files
                .get(id.as_str())
                .filter(|file| {
                    if stage {
                        file.worktree != '.' || file.conflict
                    } else {
                        file.index != '.' && !file.conflict
                    }
                })
                .ok_or("changeMissing")?;
            let paths = Self::file_paths(id)?;
            let paths = if stage {
                Self::working_paths(file, &paths)
            } else {
                &paths
            };
            for path in paths {
                pathspecs.extend_from_slice(path.as_encoded_bytes());
                pathspecs.push(0);
            }
        }

        let mut git = self.command();
        git.arg("--literal-pathspecs");
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
