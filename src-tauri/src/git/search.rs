use super::{model::Commit, process::read_output, string, GitError, Repo, Result, OUTPUT_LIMIT};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::{io::Read, process::Stdio, thread};

const SEARCH_LIMIT: usize = 200;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    All,
    Title,
    Description,
    Hash,
    Author,
    Reference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCommit {
    #[serde(flatten)]
    commit: Commit,
    description: String,
    references: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearch {
    commits: Vec<SearchCommit>,
    has_more: bool,
}

impl Repo {
    pub fn search_commits(
        &self,
        query: &str,
        field: SearchField,
        case_sensitive: bool,
    ) -> Result<CommitSearch> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(CommitSearch::default());
        }
        let needle = if case_sensitive {
            query.into()
        } else {
            query.to_lowercase()
        };
        let head = self.status()?.head;
        let stashes = self.text(["stash", "list", "--format=%H"])?;
        let mut command = self.command();
        command.args([
            "log",
            "--all",
            "--date-order",
            "--no-show-signature",
            "--no-notes",
            "--no-patch",
            "--decorate=full",
            "-z",
            "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%aI%x00%ae%x00%b%x00%D",
        ]);
        // Include detached HEAD and older stashes, regardless of graph visibility.
        command.args(head).args(stashes.lines()).arg("--");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| GitError::new("gitStartFailed", error))?;
        let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let stderr = child.stderr.take().expect("piped stderr");
        thread::scope(|scope| {
            let stderr = scope.spawn(move || read_output(stderr, OUTPUT_LIMIT));
            // Stream the entire history, retaining only matching commits. Unlike the
            // graph, search has no history-depth cutoff or unbounded log buffer.
            let result = (|| -> Result<CommitSearch> {
                let mut result = CommitSearch::default();
                let mut retained_bytes = 0;
                loop {
                    let mut fields = Vec::with_capacity(9);
                    let mut record_bytes = 0;
                    for index in 0..9 {
                        let mut bytes = Vec::new();
                        let count = Read::by_ref(&mut stdout)
                            .take((OUTPUT_LIMIT + 1) as u64)
                            .read_until(0, &mut bytes)
                            .map_err(|error| GitError::new("gitIoFailed", error))?;
                        if count == 0 && index == 0 {
                            return Ok(result);
                        }
                        record_bytes += count;
                        if record_bytes > OUTPUT_LIMIT || bytes.last() != Some(&0) {
                            return Err("tooMuchData".into());
                        }
                        bytes.pop();
                        fields.push(string(&bytes));
                    }
                    let indices: &[usize] = match field {
                        SearchField::All => &[0, 3, 4, 6, 7, 8],
                        SearchField::Title => &[3],
                        SearchField::Description => &[7],
                        SearchField::Hash => &[0],
                        SearchField::Author => &[4, 6],
                        SearchField::Reference => &[8],
                    };
                    if !indices.iter().any(|&index| {
                        if case_sensitive {
                            fields[index].contains(&needle)
                        } else {
                            fields[index].to_lowercase().contains(&needle)
                        }
                    }) {
                        continue;
                    }
                    if result.commits.len() == SEARCH_LIMIT
                        || retained_bytes + record_bytes > OUTPUT_LIMIT
                    {
                        result.has_more = true;
                        return Ok(result);
                    }
                    retained_bytes += record_bytes;
                    result.commits.push(SearchCommit {
                        commit: Commit {
                            id: fields[0].clone(),
                            short_id: fields[1].clone(),
                            parents: fields[2]
                                .split_ascii_whitespace()
                                .map(str::to_owned)
                                .collect(),
                            subject: fields[3].clone(),
                            author: fields[4].clone(),
                            date: fields[5].clone(),
                            email: fields[6].clone(),
                        },
                        description: fields[7].trim_end().into(),
                        references: fields[8].clone(),
                    });
                }
            })();
            let stopped = result.as_ref().map_or(true, |result| result.has_more);
            if stopped {
                let _ = child.kill();
            }
            let status = child
                .wait()
                .map_err(|error| GitError::new("gitIoFailed", error))?;
            let stderr = stderr
                .join()
                .expect("stderr reader")
                .map_err(|error| GitError::new("gitIoFailed", error))?;
            if !stopped && !status.success() {
                return Err(GitError::new("gitOutput", string(&stderr.bytes)));
            }
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{commit_file, repo};
    use super::super::{DiffOptions, HISTORY_LIMIT};
    use super::*;

    #[test]
    fn searches_literal_titles_descriptions_hashes_authors_and_refs() {
        let (_dir, repo) = repo();
        let id = commit_file(&repo, "file", "one", "Fix [toolbar].*");
        repo.run(["tag", "release/find", &id]).unwrap();
        for (query, field) in [
            ("[toolbar].*", SearchField::Title),
            ("test BODY", SearchField::Description),
            (&id[..9], SearchField::Hash),
            ("diffinch@example.invalid", SearchField::Author),
            ("release/find", SearchField::Reference),
            ("Test body", SearchField::All),
        ] {
            let result = repo.search_commits(query, field, false).unwrap();
            assert_eq!(result.commits.len(), 1, "{query}");
            assert_eq!(result.commits[0].commit.id, id);
            assert_eq!(result.commits[0].commit.email, "diffinch@example.invalid");
            assert_eq!(result.commits[0].description, "Test body");
        }
        assert!(repo
            .search_commits("Test body", SearchField::Title, false)
            .unwrap()
            .commits
            .is_empty());
        assert!(repo
            .search_commits("toolbar", SearchField::Description, false)
            .unwrap()
            .commits
            .is_empty());
        assert!(repo
            .search_commits("test body", SearchField::Description, true)
            .unwrap()
            .commits
            .is_empty());
        assert!(repo
            .search_commits("--all", SearchField::All, false)
            .unwrap()
            .commits
            .is_empty());
    }

    #[test]
    fn searches_past_graph_depth_and_bounds_results() {
        let (_dir, repo) = repo();
        let first = commit_file(&repo, "file", "one", "Ancient needle");
        let tree = repo.text(["rev-parse", "HEAD^{tree}"]).unwrap();
        let mut tip = first.clone();
        for index in 0..HISTORY_LIMIT + 1 {
            tip = repo
                .text([
                    "commit-tree",
                    &tree,
                    "-p",
                    &tip,
                    "-m",
                    &format!("Search fixture {index}"),
                ])
                .unwrap();
        }
        repo.run(["update-ref", "HEAD", &tip]).unwrap();
        let result = repo
            .search_commits("Ancient needle", SearchField::Title, false)
            .unwrap();
        assert_eq!(result.commits[0].commit.id, first);
        assert!(!result.has_more);
        assert!(repo
            .history_diff(&first, DiffOptions::default())
            .unwrap()
            .text
            .contains("+one"));
        let result = repo
            .search_commits("Search fixture", SearchField::Title, false)
            .unwrap();
        assert_eq!(result.commits.len(), SEARCH_LIMIT);
        assert!(result.has_more);
    }

    #[test]
    fn handles_empty_repos_detached_head_and_branch_only_history() {
        let (_dir, repo) = repo();
        assert!(repo
            .search_commits("anything", SearchField::All, false)
            .unwrap()
            .commits
            .is_empty());
        let first = commit_file(&repo, "file", "one", "First");
        repo.run(["checkout", "--detach"]).unwrap();
        let detached = commit_file(&repo, "file", "two", "Detached needle");
        let result = repo
            .search_commits("Detached needle", SearchField::Title, false)
            .unwrap();
        assert_eq!(result.commits[0].commit.id, detached);
        repo.run(["branch", "hidden-search", &detached]).unwrap();
        repo.run(["checkout", "--detach", &first]).unwrap();
        assert_eq!(
            repo.search_commits("Detached needle", SearchField::Title, false)
                .unwrap()
                .commits
                .len(),
            1
        );
        assert!(repo
            .search_commits("  ", SearchField::All, false)
            .unwrap()
            .commits
            .is_empty());
    }

    #[test]
    fn preserves_multiline_messages_and_finds_tag_and_older_stash_history() {
        let (_dir, repo) = repo();
        let first = commit_file(&repo, "file", "one", "First");
        repo.run(["checkout", "--detach"]).unwrap();
        repo.run([
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "검색 title",
            "-m",
            "Description line one\n説明 line two\n\nLast paragraph.",
        ])
        .unwrap();
        let tagged = repo.text(["rev-parse", "HEAD"]).unwrap();
        repo.run(["tag", "only-tag", &tagged]).unwrap();
        repo.run(["checkout", "--detach", &first]).unwrap();
        let result = repo
            .search_commits("説明 line two", SearchField::Description, false)
            .unwrap();
        assert_eq!(result.commits[0].commit.id, tagged);
        assert_eq!(
            result.commits[0].description,
            "Description line one\n説明 line two\n\nLast paragraph."
        );
        for message in ["older-stash-needle", "newer stash"] {
            std::fs::write(repo.0.join("file"), message).unwrap();
            repo.run(["stash", "push", "-m", message]).unwrap();
        }
        let result = repo
            .search_commits("older-stash-needle", SearchField::Title, false)
            .unwrap();
        assert_eq!(result.commits.len(), 1);
    }
}
