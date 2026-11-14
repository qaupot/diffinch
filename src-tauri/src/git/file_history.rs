use super::{
    diff::make_diff,
    model::{Commit, Diff, DiffOptions},
    refs::validate_oid,
    GitError, Repo, Result, OUTPUT_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

const BLAME_PAGE: usize = 300;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileInspectionRequest {
    Catalog {
        revision: String,
    },
    History {
        revision: String,
        file: String,
        limit: usize,
    },
    Blame {
        revision: String,
        file: String,
        page: usize,
    },
    Diff {
        revision: String,
        file: String,
        previous_path: Option<String>,
        options: DiffOptions,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum FileInspectionResult {
    Catalog(FileCatalog),
    History(FileHistory),
    Blame(FileBlame),
    Diff(Diff),
}

#[derive(Serialize)]
pub struct FileCatalog {
    revision: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    #[serde(flatten)]
    commit: Commit,
    path: String,
    previous_path: Option<String>,
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    commits: Vec<FileRevision>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    id: String,
    author: String,
    email: String,
    timestamp: i64,
    summary: String,
    original_line: usize,
    line: usize,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    lines: Vec<BlameLine>,
    total_lines: usize,
    page: usize,
    has_more: bool,
}

// These paths are Git protocol values, never pathspec patterns or shell input.
pub(super) fn validate_file_path(file: &str) -> Result<()> {
    if file.is_empty()
        || file.contains('\0')
        || Path::new(file).is_absolute()
        || Path::new(file).components().any(|part| match part {
            Component::Normal(name) => name
                .to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(".git")),
            _ => true,
        })
    {
        return Err("invalidGitPath".into());
    }
    Ok(())
}

impl Repo {
    pub fn inspect_file(&self, request: FileInspectionRequest) -> Result<FileInspectionResult> {
        match request {
            FileInspectionRequest::Catalog { revision } => self
                .file_catalog(&revision)
                .map(FileInspectionResult::Catalog),
            FileInspectionRequest::History {
                revision,
                file,
                limit,
            } => self
                .file_history(&revision, &file, limit)
                .map(FileInspectionResult::History),
            FileInspectionRequest::Blame {
                revision,
                file,
                page,
            } => self
                .file_blame(&revision, &file, page)
                .map(FileInspectionResult::Blame),
            FileInspectionRequest::Diff {
                revision,
                file,
                previous_path,
                options,
            } => self
                .file_revision_diff(&revision, &file, previous_path.as_deref(), options)
                .map(FileInspectionResult::Diff),
        }
    }

    pub fn file_catalog(&self, revision: &str) -> Result<FileCatalog> {
        let revision = self.resolve_comparison_ref(revision)?;
        let output = self.run([
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            "--full-tree",
            &revision,
            "--",
        ])?;
        if output.truncated {
            return Err("tooManyPaths".into());
        }
        let files = output
            .bytes
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8(path.to_vec()).map_err(|_| "pathEncoding".into()))
            .collect::<Result<Vec<_>>>()?;
        Ok(FileCatalog { revision, files })
    }

    pub fn file_history(&self, revision: &str, file: &str, limit: usize) -> Result<FileHistory> {
        validate_oid(revision)?;
        validate_file_path(file)?;
        let limit = limit.clamp(1, 2000);
        let output = self.run([
            "--literal-pathspecs",
            "log",
            "--follow",
            "--find-renames",
            "--name-status",
            "-z",
            "--no-show-signature",
            "--no-notes",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            "--encoding=UTF-8",
            "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%aI%x00%ae",
            &format!("--max-count={}", limit + 1),
            revision,
            "--",
            file,
        ])?;
        if output.truncated {
            return Err("tooMuchData".into());
        }
        parse_history(&output.bytes, file, limit)
    }

    pub fn file_revision_diff(
        &self,
        revision: &str,
        file: &str,
        previous_path: Option<&str>,
        options: DiffOptions,
    ) -> Result<Diff> {
        validate_oid(revision)?;
        validate_file_path(file)?;
        if let Some(previous) = previous_path {
            validate_file_path(previous)?;
        }
        let mut git = self.command();
        git.args([
            "--literal-pathspecs",
            "show",
            "--format=",
            "--first-parent",
            "--diff-merges=first-parent",
            "--patch",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
        ]);
        options.configure(&mut git);
        git.args([revision, "--", file]).args(previous_path);
        Ok(make_diff(options.execute(git, &[])?, false))
    }

    pub fn file_blame(&self, revision: &str, file: &str, page: usize) -> Result<FileBlame> {
        validate_oid(revision)?;
        validate_file_path(file)?;
        let object = format!("{revision}:{file}");
        let size = self
            .text(["cat-file", "-s", &object])?
            .parse::<usize>()
            .map_err(|_| "incompleteStatus")?;
        if size > OUTPUT_LIMIT {
            return Err("blameUnsupported".into());
        }
        let contents = self.run(["cat-file", "blob", &object])?;
        if contents.truncated || contents.bytes.contains(&0) {
            return Err("blameUnsupported".into());
        }
        let text = std::str::from_utf8(&contents.bytes).map_err(|_| "blameUnsupported")?;
        let total_lines = text.lines().count();
        let start = page.checked_mul(BLAME_PAGE).ok_or("invalidGitPath")?;
        if start >= total_lines {
            return Ok(FileBlame {
                lines: vec![],
                page,
                total_lines,
                has_more: false,
            });
        }
        let end = (start + BLAME_PAGE).min(total_lines);
        let output = self.run([
            "--literal-pathspecs",
            "blame",
            "--line-porcelain",
            "--encoding=UTF-8",
            "--no-textconv",
            "-L",
            &format!("{},{}", start + 1, end),
            revision,
            "--",
            file,
        ])?;
        if output.truncated {
            return Err("tooMuchData".into());
        }
        let lines = parse_blame(&output.bytes)?;
        Ok(FileBlame {
            lines,
            total_lines,
            page,
            has_more: end < total_lines,
        })
    }
}

fn parse_history(bytes: &[u8], file: &str, limit: usize) -> Result<FileHistory> {
    let text = std::str::from_utf8(bytes).map_err(|_| "pathEncoding")?;
    let mut fields = text.split('\0').peekable();
    let mut path = file.to_owned();
    let mut commits = Vec::new();
    while let Some(id) = fields.next() {
        let id = id.trim_start_matches('\n');
        if id.is_empty() {
            continue;
        }
        validate_oid(id)?;
        let mut next = || {
            fields
                .next()
                .ok_or_else(|| GitError::from("incompleteStatus"))
        };
        let commit = Commit {
            id: id.into(),
            short_id: next()?.into(),
            parents: next()?
                .split_ascii_whitespace()
                .map(str::to_owned)
                .collect(),
            subject: next()?.into(),
            author: next()?.into(),
            date: next()?.into(),
            email: next()?.into(),
        };
        let mut entry = FileRevision {
            commit,
            path: path.clone(),
            previous_path: None,
            deleted: false,
        };
        while let Some(status) = fields.peek().copied() {
            let status = status.trim_start_matches('\n');
            if status.is_empty() {
                fields.next();
                continue;
            }
            if validate_oid(status).is_ok() {
                break;
            }
            fields.next();
            let first = fields.next().ok_or("incompleteStatus")?;
            if status.starts_with(['R', 'C']) {
                let second = fields.next().ok_or("incompleteStatus")?;
                if second == path {
                    entry.path = second.into();
                    entry.previous_path = Some(first.into());
                    path = first.into();
                }
            } else if first == path {
                entry.deleted = status == "D";
            }
        }
        commits.push(entry);
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(FileHistory { commits, has_more })
}

fn parse_blame(bytes: &[u8]) -> Result<Vec<BlameLine>> {
    let text = std::str::from_utf8(bytes).map_err(|_| "blameUnsupported")?;
    let mut records = text.split_inclusive('\n');
    let mut lines = Vec::new();
    while let Some(header) = records.next() {
        let mut fields = header.split_ascii_whitespace();
        let id = fields.next().ok_or("incompleteStatus")?;
        validate_oid(id)?;
        let mut line = BlameLine {
            id: id.into(),
            author: String::new(),
            email: String::new(),
            timestamp: 0,
            summary: String::new(),
            original_line: fields
                .next()
                .and_then(|value| value.parse().ok())
                .ok_or("incompleteStatus")?,
            line: fields
                .next()
                .and_then(|value| value.parse().ok())
                .ok_or("incompleteStatus")?,
            text: String::new(),
        };
        let mut complete = false;
        for record in records.by_ref() {
            let record = record.strip_suffix('\n').unwrap_or(record);
            if let Some(value) = record.strip_prefix('\t') {
                line.text = value.into();
                complete = true;
                break;
            }
            if let Some(value) = record.strip_prefix("author ") {
                line.author = value.into();
            }
            if let Some(value) = record.strip_prefix("author-mail ") {
                line.email = value.trim_matches(['<', '>']).into();
            }
            if let Some(value) = record.strip_prefix("author-time ") {
                line.timestamp = value.parse().map_err(|_| "incompleteStatus")?;
            }
            if let Some(value) = record.strip_prefix("summary ") {
                line.summary = value.into();
            }
        }
        if !complete {
            return Err("incompleteStatus".into());
        }
        lines.push(line);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{commit_file, repo};
    use super::*;

    #[test]
    fn follows_renames_and_loads_the_historical_path() {
        let (_dir, repo) = repo();
        let first = commit_file(&repo, "old name.txt", "one\ntwo\n", "Original");
        repo.run(["mv", "old name.txt", "새 이름.txt"]).unwrap();
        let renamed = commit_file(&repo, "새 이름.txt", "one\ntwo\n", "Rename");
        let latest = commit_file(&repo, "새 이름.txt", "one\nchanged\n", "Edit");
        let history = repo.file_history(&latest, "새 이름.txt", 100).unwrap();
        assert_eq!(history.commits.len(), 3);
        assert_eq!(history.commits[0].commit.id, latest);
        assert_eq!(history.commits[1].commit.id, renamed);
        assert_eq!(
            history.commits[1].previous_path.as_deref(),
            Some("old name.txt")
        );
        assert_eq!(history.commits[2].path, "old name.txt");
        let limited = repo.file_history(&latest, "새 이름.txt", 1).unwrap();
        assert_eq!(limited.commits.len(), 1);
        assert!(limited.has_more);
        let blame = repo.file_blame(&latest, "새 이름.txt", 0).unwrap();
        assert_eq!(blame.lines[0].id, first);
        assert_eq!(blame.lines[1].id, latest);
        assert_eq!(blame.lines[1].text, "changed");
        assert_eq!(blame.lines[0].email, "diffinch@example.invalid");
        let patch = repo
            .file_revision_diff(
                &renamed,
                "새 이름.txt",
                Some("old name.txt"),
                DiffOptions::default(),
            )
            .unwrap();
        assert!(patch.text.contains("rename from old name.txt"));
        assert_eq!(
            repo.file_blame(&first, "old name.txt", 0)
                .unwrap()
                .lines
                .len(),
            2
        );
    }

    #[test]
    fn handles_deleted_files_literal_paths_and_empty_files() {
        let (_dir, repo) = repo();
        let first = commit_file(&repo, "[name].txt", "original\n", "Add literal path");
        commit_file(&repo, "n.txt", "not this file\n", "Other file");
        let empty = commit_file(&repo, "empty.txt", "", "Empty");
        assert!(repo
            .file_blame(&empty, "empty.txt", 0)
            .unwrap()
            .lines
            .is_empty());
        repo.run(["rm", "--", "[name].txt"]).unwrap();
        let deleted = commit_file(&repo, "n.txt", "not this file\n", "Delete literal path");
        let history = repo.file_history(&deleted, "[name].txt", 100).unwrap();
        assert_eq!(history.commits.len(), 2);
        assert!(history.commits[0].deleted);
        assert_eq!(history.commits[1].commit.id, first);
        assert!(repo
            .file_revision_diff(&deleted, "[name].txt", None, DiffOptions::default())
            .unwrap()
            .text
            .contains("-original"));
        let catalog = repo.file_catalog("HEAD").unwrap();
        assert_eq!(catalog.revision, deleted);
        assert_eq!(catalog.files, vec!["empty.txt", "n.txt"]);
        assert!(repo
            .file_history(&deleted, "missing.txt", 100)
            .unwrap()
            .commits
            .is_empty());
        for file in [
            "../outside",
            "/absolute",
            ".git/config",
            "folder/../../file",
        ] {
            assert!(repo.file_history(&deleted, file, 100).is_err());
        }
    }

    #[test]
    fn pages_blame_without_losing_lines_and_rejects_binary_content() {
        let (_dir, repo) = repo();
        let contents = (0..650)
            .map(|index| format!("line {index}\n"))
            .collect::<String>();
        let id = commit_file(&repo, "large.txt", &contents, "Many lines");
        let first = repo.file_blame(&id, "large.txt", 0).unwrap();
        let second = repo.file_blame(&id, "large.txt", 1).unwrap();
        let last = repo.file_blame(&id, "large.txt", 2).unwrap();
        assert_eq!(first.lines.len(), 300);
        assert_eq!(second.lines[0].line, 301);
        assert_eq!(last.lines.len(), 50);
        assert_eq!(last.lines.last().unwrap().line, 650);
        assert_eq!(last.total_lines, 650);
        assert!(!last.has_more);
        let binary = commit_file(&repo, "binary", "a\0b", "Binary");
        assert!(repo
            .file_blame(&binary, "binary", 0)
            .is_err_and(|error| error.key == "blameUnsupported"));
    }

    #[cfg(unix)]
    #[test]
    fn preserves_tabs_newlines_and_option_like_names() {
        let (_dir, repo) = repo();
        let name = "--odd\tname\n.txt";
        let id = commit_file(&repo, name, "hello\n", "Unusual path");
        assert_eq!(repo.file_catalog(&id).unwrap().files, vec![name]);
        assert_eq!(
            repo.file_history(&id, name, 100).unwrap().commits[0].path,
            name
        );
        assert_eq!(
            repo.file_blame(&id, name, 0).unwrap().lines[0].text,
            "hello"
        );
    }
}
