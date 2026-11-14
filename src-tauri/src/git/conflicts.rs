use super::{
    model::Conflict,
    process::{execute, read_output, Output},
    string, GitError, Repo, Result, OUTPUT_LIMIT,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    io,
    path::PathBuf,
};
impl Repo {
    pub fn conflict(&self, id: &str) -> Result<Conflict> {
        let path = self.conflict_path(id)?;
        let relative = path.strip_prefix(&self.0).map_err(|_| "invalidGitPath")?;
        let mut attributes = self.command();
        attributes
            .args(["check-attr", "-z", "conflict-marker-size", "--"])
            .arg(relative);
        let attributes = execute(attributes, &[], None)?;
        if attributes.truncated {
            return Err("unsupportedConflict".into());
        }
        let marker_size = attributes
            .bytes
            .split(|byte| *byte == 0)
            .nth(2)
            .and_then(|value| std::str::from_utf8(value).ok())
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|size| *size > 0)
            .unwrap_or(7) as usize;
        let mut git = self.command();
        git.args(["--literal-pathspecs", "ls-files", "-u", "-z", "--"])
            .arg(relative);
        let index = execute(git, &[], None)?;
        if index.bytes.is_empty() || index.truncated {
            return Err("staleConflict".into());
        }
        let mut sides = [None, None, None];
        for record in index
            .bytes
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let end = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or("incompleteStatus")?;
            let metadata = string(&record[..end]);
            let mut fields = metadata.split_ascii_whitespace();
            let mode = fields.next().ok_or("incompleteStatus")?;
            let oid = fields.next().ok_or("incompleteStatus")?;
            let stage = fields
                .next()
                .and_then(|field| field.parse::<usize>().ok())
                .filter(|stage| (1..=3).contains(stage))
                .ok_or("incompleteStatus")?;
            if !matches!(mode, "100644" | "100755") {
                return Err("unsupportedConflict".into());
            }
            let contents = self.run(["cat-file", "blob", oid])?;
            sides[stage - 1] = Some(conflict_text(contents)?);
        }
        let result = match std::fs::File::open(&path) {
            Ok(file) => conflict_text(read_output(file, OUTPUT_LIMIT).map_err(conflict_io)?)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(conflict_io(error)),
        };
        let mut hash = DefaultHasher::new();
        index.bytes.hash(&mut hash);
        result.hash(&mut hash);
        marker_size.hash(&mut hash);
        let token = format!("{:016x}", hash.finish());
        let [base, current, incoming] = sides;
        Ok(Conflict {
            base,
            current,
            incoming,
            result,
            token,
            marker_size,
        })
    }

    pub(super) fn conflict_path(&self, id: &str) -> Result<PathBuf> {
        let (file, paths) = self.file(id)?;
        if !file.conflict || paths.len() != 1 {
            return Err("staleConflict".into());
        }
        let root = self.0.canonicalize().map_err(conflict_io)?;
        let path = self.0.join(&paths[0]);
        let parent = path.parent().ok_or("invalidGitPath")?;
        let expected = root.join(parent.strip_prefix(&self.0).map_err(|_| "invalidGitPath")?);
        if parent.canonicalize().map_err(conflict_io)? != expected {
            return Err("unsupportedConflict".into());
        }
        match path.symlink_metadata() {
            Ok(metadata) if !metadata.is_file() => return Err("unsupportedConflict".into()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                return Err(conflict_io(error))
            }
            _ => {}
        }
        Ok(path)
    }
}

pub(super) fn conflict_io(error: io::Error) -> GitError {
    GitError::new("gitIoFailed", error)
}

fn conflict_text(output: Output) -> Result<String> {
    if output.truncated || output.bytes.contains(&0) {
        return Err("unsupportedConflict".into());
    }
    String::from_utf8(output.bytes).map_err(|_| "unsupportedConflict".into())
}

pub(super) fn has_conflict_markers(text: &str, marker_size: usize) -> bool {
    text.lines().any(|line| {
        let Some(&marker) = line.as_bytes().first() else {
            return false;
        };
        // A separator by itself is also valid text, e.g. a Markdown heading.
        // Opening, base and closing markers still reject incomplete conflicts.
        if !matches!(marker, b'<' | b'|' | b'>') {
            return false;
        }
        let size = line.bytes().take_while(|byte| *byte == marker).count();
        size >= marker_size && (size == line.len() || line.as_bytes()[size] == b' ')
    })
}

#[cfg(test)]
mod tests {
    use crate::git::{
        model::Action,
        tests::{commit_file, repo},
    };

    #[test]
    fn respects_custom_marker_sizes_and_rejects_changed_attributes() {
        for size in [3, 5, 32] {
            let (dir, repo) = repo();
            commit_file(
                &repo,
                ".gitattributes",
                &format!("notes.txt conflict-marker-size={size}\n"),
                "Attributes",
            );
            let prefix = if size > 7 {
                "<<<<<<< documented example\n"
            } else {
                ""
            };
            commit_file(&repo, "notes.txt", &format!("{prefix}base\n"), "Base");
            repo.run(["switch", "-c", "topic"]).unwrap();
            commit_file(
                &repo,
                "notes.txt",
                &format!("{prefix}incoming\n"),
                "Incoming",
            );
            repo.run(["switch", "main"]).unwrap();
            commit_file(&repo, "notes.txt", &format!("{prefix}current\n"), "Current");
            assert!(repo.run(["merge", "--no-edit", "topic"]).is_err());
            let id = repo
                .status()
                .unwrap()
                .files
                .into_iter()
                .find(|file| file.conflict)
                .unwrap()
                .id;
            let conflict = repo.conflict(&id).unwrap();
            assert_eq!(conflict.marker_size, size);
            assert!(conflict
                .result
                .contains(&format!("{} HEAD", "<".repeat(size))));
            assert!(repo
                .action(Action::ResolveConflict {
                    id: id.clone(),
                    token: conflict.token.clone(),
                    text: conflict.result.clone(),
                })
                .is_err_and(|error| error.key == "unresolvedConflict"));
            let resolved = format!("{prefix}resolved\n");
            std::fs::write(
                dir.path().join(".gitattributes"),
                "notes.txt conflict-marker-size=9\n",
            )
            .unwrap();
            assert!(repo
                .action(Action::ResolveConflict {
                    id: id.clone(),
                    token: conflict.token.clone(),
                    text: resolved.clone(),
                })
                .is_err_and(|error| error.key == "staleConflict"));
            assert_eq!(
                std::fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
                conflict.result
            );
            std::fs::write(
                dir.path().join(".gitattributes"),
                format!("notes.txt conflict-marker-size={size}\n"),
            )
            .unwrap();
            repo.action(Action::ResolveConflict {
                id,
                token: conflict.token,
                text: resolved.clone(),
            })
            .unwrap();
            assert_eq!(
                repo.text(["show", ":notes.txt"]).unwrap(),
                resolved.trim_end()
            );
            assert!(repo.run(["ls-files", "-u"]).unwrap().bytes.is_empty());
        }
    }

    #[test]
    fn resolves_markdown_headings_but_rejects_remaining_conflict_markers() {
        let (dir, repo) = repo();
        commit_file(&repo, "README.md", "Title\n=======\nbase\n", "Base");
        repo.run(["switch", "-c", "topic"]).unwrap();
        commit_file(&repo, "README.md", "Title\n=======\nincoming\n", "Incoming");
        repo.run(["switch", "main"]).unwrap();
        commit_file(&repo, "README.md", "Title\n=======\ncurrent\n", "Current");
        assert!(repo.run(["merge", "--no-edit", "topic"]).is_err());
        let id = repo.status().unwrap().files.remove(0).id;
        let conflict = repo.conflict(&id).unwrap();
        for unresolved in [
            conflict.result.clone(),
            "<<<<<<< HEAD\ncurrent\n=======\nincoming\n".into(),
            "current\n=======\nincoming\n>>>>>>> topic\n".into(),
            "||||||| base\nbase\n=======\nincoming\n".into(),
            format!("{} HEAD\r\ncurrent\r\n", "<".repeat(32)),
        ] {
            assert!(repo
                .action(Action::ResolveConflict {
                    id: id.clone(),
                    token: conflict.token.clone(),
                    text: unresolved
                })
                .is_err_and(|error| error.key == "unresolvedConflict"));
        }
        let resolved = "Title\n=======\nresolved\n";
        repo.action(Action::ResolveConflict {
            id,
            token: conflict.token,
            text: resolved.into(),
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("README.md")).unwrap(),
            resolved
        );
        assert_eq!(
            repo.text(["show", ":README.md"]).unwrap(),
            resolved.trim_end()
        );
        repo.action(Action::ContinueOperation).unwrap();
        assert!(repo.status().unwrap().files.is_empty());
    }
}
