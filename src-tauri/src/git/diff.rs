use super::{
    images::{ImageSource, IMAGE_TOTAL_LIMIT},
    model::{Comparison, ComparisonFile, Diff, DiffOptions, FileChange},
    process::{execute, execute_with_limit, Output},
    refs::validate_oid,
    string, Repo, Result, OUTPUT_LIMIT,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    ffi::OsString,
    hash::{Hash, Hasher},
    process::Command,
};
impl DiffOptions {
    pub(super) fn limit(self) -> usize {
        OUTPUT_LIMIT << self.page.min(3)
    }

    pub(super) fn configure(self, git: &mut Command) {
        if self.ignore_whitespace {
            git.arg("--ignore-all-space");
        }
    }

    pub(super) fn execute(self, git: Command, accepted: &[i32]) -> Result<Output> {
        execute_with_limit(git, accepted, None, self.limit())
    }
}

impl Repo {
    #[cfg(test)]
    pub(super) fn diff(&self, id: &str, staged: bool) -> Result<Diff> {
        self.file_diff(id, staged, DiffOptions::default())
    }

    pub fn file_diff(&self, id: &str, staged: bool, options: DiffOptions) -> Result<Diff> {
        let (file, paths) = self.file(id)?;
        let mut budget = IMAGE_TOTAL_LIMIT;
        self.diff_for_file(&file, &paths, staged, options, &mut budget)
    }

    fn diff_for_file(
        &self,
        file: &FileChange,
        paths: &[OsString],
        staged: bool,
        options: DiffOptions,
        budget: &mut usize,
    ) -> Result<Diff> {
        // With --untracked-files=all Git reports embedded repositories as
        // directories. A no-index diff would compare a child named "null".
        if file.worktree == '?' && (staged || paths[0].as_encoded_bytes().ends_with(b"/")) {
            return Ok(Diff::default());
        }
        let paths = Self::change_paths(file, paths, staged);
        let mut git = self.command();
        git.args([
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--ignore-submodules=none",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--submodule=short",
            "--unified=3",
        ]);
        options.configure(&mut git);
        if file.worktree == '?' {
            git.args(["--no-index", "--", "/dev/null"]).arg(&paths[0]);
        } else {
            if staged {
                git.arg("--cached").arg("--").args(paths);
            } else {
                git.arg("--").args(paths);
            }
        }
        let output = options.execute(git, if file.worktree == '?' { &[1] } else { &[] })?;
        let code = if staged { file.index } else { file.worktree };
        let eligible = code == 'M'
            && !file.conflict
            && !file.submodule
            && paths.len() == 1
            && !options.ignore_whitespace
            && !self.is_lfs_path(&paths[0])?;
        let mut diff = make_diff(output, eligible);
        if file.worktree == '?' {
            diff.images.extend(self.untracked_image(&paths[0], budget));
        } else {
            let source = if staged {
                ImageSource::Index
            } else {
                ImageSource::Worktree
            };
            diff.images = self.image_previews(source, paths, budget)?;
        }
        Ok(diff)
    }

    #[cfg(test)]
    pub(super) fn changes_diff(&self, staged: bool) -> Result<Diff> {
        self.working_diff(staged, DiffOptions::default())
    }

    pub fn working_diff(&self, staged: bool, options: DiffOptions) -> Result<Diff> {
        let mut git = self.command();
        git.args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--ignore-submodules=none",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--submodule=short",
            "--unified=3",
        ]);
        if staged {
            git.args(["--cached", "--diff-filter=u"]);
        }
        options.configure(&mut git);
        git.arg("--");
        let mut output = options.execute(git, &[])?;
        let mut budget = IMAGE_TOTAL_LIMIT;
        let source = if staged {
            ImageSource::Index
        } else {
            ImageSource::Worktree
        };
        let mut images = self.image_previews(source, &[], &mut budget)?;
        if !staged && !output.truncated {
            for file in self
                .status()?
                .files
                .iter()
                .filter(|file| file.worktree == '?')
            {
                let paths = Self::file_paths(&file.id)?;
                let diff = self.diff_for_file(file, &paths, false, options, &mut budget)?;
                images.extend(diff.images);
                let remaining = options.limit().saturating_sub(output.bytes.len());
                let bytes = diff.text.as_bytes();
                output
                    .bytes
                    .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                output.truncated |= diff.truncated || bytes.len() > remaining;
                if output.truncated {
                    break;
                }
            }
        }
        let mut diff = make_diff(output, false);
        diff.images = images;
        Ok(diff)
    }

    pub fn commit_message(&self, id: &str) -> Result<String> {
        validate_oid(id)?;
        self.text([
            "show",
            "--no-patch",
            "--no-show-signature",
            "--format=%B",
            id,
            "--",
        ])
    }

    #[cfg(test)]
    pub(super) fn commit_diff(&self, id: &str) -> Result<Diff> {
        self.history_diff(id, DiffOptions::default())
    }

    pub fn history_diff(&self, id: &str, options: DiffOptions) -> Result<Diff> {
        validate_oid(id)?;
        let mut git = self.command();
        git.args([
            "show",
            "--format=",
            "--first-parent",
            "--diff-merges=first-parent",
            "--patch",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--ignore-submodules=none",
            "--unified=3",
        ]);
        options.configure(&mut git);
        git.args([id, "--"]);
        let output = options.execute(git, &[])?;
        let mut diff = make_diff(output, false);
        let mut budget = IMAGE_TOTAL_LIMIT;
        diff.images = self.image_previews(ImageSource::Commit(id), &[], &mut budget)?;
        Ok(diff)
    }

    pub(super) fn apply_hunk(
        &self,
        id: &str,
        staged: bool,
        index: usize,
        token: &str,
        page: u32,
        selected: Option<&[usize]>,
    ) -> Result<()> {
        let diff = self.file_diff(
            id,
            staged,
            DiffOptions {
                page,
                ignore_whitespace: false,
            },
        )?;
        if diff.hunk_token.as_deref() != Some(token) {
            return Err("staleDiff".into());
        }
        let mut lines = diff.text.split_inclusive('\n');
        let leading: Vec<&str> = lines
            .by_ref()
            .take_while(|line| !line.starts_with("@@ "))
            .collect();
        let header: String = leading.concat();
        let hunk = diff.text[header.len()..].split_inclusive('\n');
        let mut hunks = hunk.peekable();
        let mut patch = header;
        for _ in 0..index {
            hunks.next().ok_or("missingHunk")?;
            while hunks.peek().is_some_and(|line| !line.starts_with("@@ ")) {
                hunks.next();
            }
        }
        let heading = hunks
            .next()
            .filter(|line| line.starts_with("@@ "))
            .ok_or("missingHunk")?;
        let lines: Vec<_> = hunks.take_while(|line| !line.starts_with("@@ ")).collect();
        if let Some(selected) = selected {
            patch.push_str(&partial_hunk(heading, &lines, selected, staged)?);
        } else {
            patch.push_str(heading);
            patch.extend(lines);
        }
        let mut git = self.command();
        git.args(["apply", "--cached", "--whitespace=nowarn"]);
        if selected.is_some() {
            git.arg("--unidiff-zero");
        }
        if staged && selected.is_none() {
            git.arg("--reverse");
        }
        git.arg("-");
        execute(git, &[], Some(patch.as_bytes()))?;
        Ok(())
    }

    pub(super) fn resolve_comparison_ref(&self, reference: &str) -> Result<String> {
        self.text([
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ])
    }

    pub fn compare(&self, base: &str, target: &str, from_merge_base: bool) -> Result<Comparison> {
        let mut base = self.resolve_comparison_ref(base)?;
        let target = self.resolve_comparison_ref(target)?;
        if from_merge_base {
            base = self.text(["merge-base", &base, &target])?;
        }
        let output = self.run([
            "diff",
            "--numstat",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            &base,
            &target,
            "--",
        ])?;
        if output.truncated {
            return Err("tooManyPaths".into());
        }
        let mut records = output.bytes.split(|byte| *byte == 0);
        let mut files = Vec::new();
        while let Some(record) = records.next() {
            if record.is_empty() {
                break;
            }
            let mut fields = record.splitn(3, |byte| *byte == b'\t');
            let additions = fields.next().and_then(|value| string(value).parse().ok());
            let deletions = fields.next().and_then(|value| string(value).parse().ok());
            let path = fields.next().ok_or("incompleteStatus")?;
            let (path, original) = if path.is_empty() {
                let original = records.next().ok_or("incompleteStatus")?;
                (records.next().ok_or("incompleteStatus")?, Some(original))
            } else {
                (path, None)
            };
            let mut id = format!("comparison:{}", URL_SAFE_NO_PAD.encode(path));
            if let Some(original) = original {
                id.push('.');
                id.push_str(&URL_SAFE_NO_PAD.encode(original));
            }
            files.push(ComparisonFile {
                id,
                path: string(path),
                original_path: original.map(string),
                additions,
                deletions,
            });
        }
        Ok(Comparison {
            base,
            target,
            files,
        })
    }

    pub fn compare_file(
        &self,
        base: &str,
        target: &str,
        id: &str,
        options: DiffOptions,
    ) -> Result<Diff> {
        validate_oid(base)?;
        validate_oid(target)?;
        let paths = Self::file_paths(id)?;
        let mut git = self.command();
        git.args([
            "--literal-pathspecs",
            "diff",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--ignore-submodules=none",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
        ]);
        options.configure(&mut git);
        git.args([base, target, "--"]).args(&paths);
        let mut diff = make_diff(options.execute(git, &[])?, false);
        let mut budget = IMAGE_TOTAL_LIMIT;
        diff.images =
            self.image_previews(ImageSource::Comparison(base, target), &paths, &mut budget)?;
        Ok(diff)
    }
}

fn partial_hunk(
    heading: &str,
    lines: &[&str],
    selected: &[usize],
    reverse: bool,
) -> Result<String> {
    let selected: HashSet<_> = selected.iter().copied().collect();
    let mut matched = 0;
    let mut body = String::new();
    let mut old_count = 0;
    let mut new_count = 0;
    let mut emitted = false;
    for (index, line) in lines.iter().enumerate() {
        let prefix = match line.as_bytes().first() {
            Some(b'+') if reverse => b'-',
            Some(b'-') if reverse => b'+',
            Some(&prefix) => prefix,
            None => return Err("missingHunk".into()),
        };
        if prefix == b'\\' {
            if emitted {
                body.push_str(line);
            }
            continue;
        }
        let keep = selected.contains(&index) && matches!(prefix, b'+' | b'-');
        matched += usize::from(keep);
        let output = match (prefix, keep) {
            (b'+', false) => None,
            (b'-', false) => Some(b' '),
            (b' ' | b'+' | b'-', _) => Some(prefix),
            _ => return Err("missingHunk".into()),
        };
        emitted = output.is_some();
        if let Some(output) = output {
            old_count += usize::from(output != b'+');
            new_count += usize::from(output != b'-');
            body.push(output as char);
            body.push_str(&line[1..]);
        }
    }
    if matched == 0 || matched != selected.len() {
        return Err("missingHunk".into());
    }
    let range = heading
        .split_ascii_whitespace()
        .nth(if reverse { 2 } else { 1 })
        .ok_or("missingHunk")?;
    let mut coordinates = range[1..].split(',');
    let start: usize = coordinates
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("missingHunk")?;
    let old_start = if coordinates.next() == Some("0") && old_count > 0 {
        start + 1
    } else {
        start
    };
    let new_start = match (old_count, new_count) {
        (0, _) => old_start + 1,
        (_, 0) => old_start.saturating_sub(1),
        _ => old_start,
    };
    Ok(format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{body}"
    ))
}

pub(super) fn make_diff(output: Output, eligible: bool) -> Diff {
    let valid_text = std::str::from_utf8(&output.bytes).is_ok();
    let text = string(&output.bytes);
    let can_apply = eligible
        && valid_text
        && !output.truncated
        && text
            .lines()
            .filter(|line| line.starts_with("diff --git "))
            .count()
            == 1
        && !text.lines().any(|line| {
            line.starts_with("old mode ")
                || line.get(1..).is_some_and(|content| {
                    matches!(
                        content,
                        "version https://git-lfs.github.com/spec/v1"
                            | "version https://hawser.github.com/spec/v1"
                    )
                })
                || line.starts_with("new mode ")
                || line.starts_with("Submodule ")
                || line.starts_with("index ") && line.ends_with(" 160000")
        })
        && text.lines().any(|line| line.starts_with("@@ "));
    let hunk_token = can_apply.then(|| {
        let mut hasher = DefaultHasher::new();
        output.bytes.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    });
    Diff {
        text,
        truncated: output.truncated,
        hunk_token,
        images: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{
        model::Action,
        tests::{commit_file, repo},
    };

    #[test]
    fn preserves_blank_context_and_partial_staging_under_user_diff_settings() {
        let (dir, repo) = repo();
        let base = commit_file(&repo, "notes.txt", "one\n\nold\n\nend\n", "Before");
        repo.run(["config", "diff.suppressBlankEmpty", "true"])
            .unwrap();
        std::fs::write(dir.path().join("notes.txt"), "one\n\nnew\n\nend\n").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        for staged in [false, true] {
            let diff = repo.file_diff(&id, staged, DiffOptions::default()).unwrap();
            assert!(diff.text.contains("\n \n"));
            assert!(!diff.text.contains("\n\n"));
            repo.action(Action::Hunk {
                id: id.clone(),
                staged,
                index: 0,
                token: diff.hunk_token.unwrap(),
                page: None,
                lines: Some(vec![2, 3]),
            })
            .unwrap();
        }
        assert_eq!(
            repo.text(["show", ":notes.txt"]).unwrap(),
            "one\n\nold\n\nend"
        );
        assert!(repo
            .working_diff(false, DiffOptions::default())
            .unwrap()
            .text
            .contains("\n \n"));
        let target = commit_file(&repo, "notes.txt", "one\n\nnew\n\nend\n", "After");
        assert!(repo
            .history_diff(&target, DiffOptions::default())
            .unwrap()
            .text
            .contains("\n \n"));
        let comparison = repo.compare(&base, &target, false).unwrap();
        assert!(repo
            .compare_file(
                &base,
                &target,
                &comparison.files[0].id,
                DiffOptions::default()
            )
            .unwrap()
            .text
            .contains("\n \n"));
    }
}
