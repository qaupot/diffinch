use super::{
    model::{
        Branch, Commit, FileChange, HistoryCursor, HistoryPage, HistoryPageRequest, Remote,
        Settings, Snapshot, Stash, Status, Tag, WorkingState,
    },
    process::execute,
    refs::validate_oid,
    remotes::redact_remote,
    string, Repo, Result, HISTORY_LIMIT, HISTORY_PAGE_SIZE,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
impl Repo {
    pub(super) fn status(&self) -> Result<Status> {
        let output = self.run([
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ])?;
        if output.truncated {
            return Err("tooManyPaths".into());
        }
        parse_status(&output.bytes)
    }

    pub(super) fn settings(&self) -> Result<Settings> {
        let get = |key| self.optional_config(&["--get", key]);
        let format = get("gpg.format")?;
        let sign = self.optional_config(&["--type=bool", "--get", "commit.gpgsign"])?;
        Ok(Settings {
            name: get("user.name")?,
            email: get("user.email")?,
            sign_commits: sign == "true",
            signing_format: if format.is_empty() {
                "openpgp".to_owned()
            } else {
                format
            },
            signing_key: get("user.signingkey")?,
        })
    }

    pub(super) fn operation(&self) -> Result<Option<String>> {
        let git_dir = self.git_dir()?;
        for (marker, name) in [
            ("rebase-merge", "rebase"),
            ("rebase-apply/rebasing", "rebase"),
            ("MERGE_HEAD", "merge"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ] {
            if git_dir.join(marker).exists() {
                return Ok(Some(name.to_owned()));
            }
        }
        Ok(None)
    }

    pub fn working_state(&self) -> Result<WorkingState> {
        let status = self.status()?;
        Ok(WorkingState {
            push_lease: self.push_lease(&status)?,
            operation: self.operation()?,
            status,
        })
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        self.snapshot_with_history(None)
    }

    pub fn snapshot_with_history(&self, history_limit: Option<usize>) -> Result<Snapshot> {
        self.snapshot_with_branches(history_limit, &[])
    }

    pub fn snapshot_with_branches(
        &self,
        history_limit: Option<usize>,
        hidden_branches: &[String],
    ) -> Result<Snapshot> {
        let status = self.status()?;
        let push_lease = self.push_lease(&status)?;
        let branches = self.text([
            "for-each-ref",
            "--sort=refname",
            "--format=%(HEAD)%09%(refname)%09%(upstream:short)%09%(symref)%09%(objectname)",
            "refs/heads",
            "refs/remotes",
        ])?;
        let branches: Vec<Branch> = branches
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\t');
                let current = fields.next()? == "*";
                let full = fields.next()?;
                let upstream = fields.next()?.to_owned();
                if !fields.next()?.is_empty() {
                    return None;
                }
                let remote = full.starts_with("refs/remotes/");
                let name = full.strip_prefix(if remote {
                    "refs/remotes/"
                } else {
                    "refs/heads/"
                })?;
                Some(Branch {
                    name: name.to_owned(),
                    tip: fields.next()?.to_owned(),
                    current,
                    remote,
                    upstream,
                })
            })
            .collect();

        // Every stash lives in the reflog; refs/stash alone only reaches the newest one.
        let stash_list = self.text([
            "stash",
            "list",
            "--no-show-signature",
            "-z",
            "--format=%gd%x00%H%x00%gs",
        ])?;
        let stashes: Vec<Stash> = stash_list
            .split_terminator('\0')
            .collect::<Vec<_>>()
            .as_chunks::<3>()
            .0
            .iter()
            .map(|fields| Stash {
                id: fields[0].into(),
                tip: fields[1].into(),
                subject: fields[2].into(),
            })
            .collect();
        let tags = self.tags()?;
        let limit = history_limit
            .unwrap_or(HISTORY_PAGE_SIZE)
            .clamp(1, HISTORY_LIMIT);
        let hidden: std::collections::HashSet<&str> =
            hidden_branches.iter().map(String::as_str).collect();
        let visible_tips: Vec<&str> = branches
            .iter()
            .filter(|branch| {
                let prefix = if branch.remote {
                    "refs/remotes"
                } else {
                    "refs/heads"
                };
                !hidden.contains(format!("{prefix}/{}", branch.name).as_str())
            })
            .map(|branch| branch.tip.as_str())
            .collect();
        let filtered = visible_tips.len() != branches.len();
        // Resolve all graph roots once, including linked worktrees, non-branch
        // refs and tag peeling. Every subsequent page walks the same tips.
        let history_roots = {
            let mut git = self.command();
            git.args(["rev-list", "--no-walk=unsorted", "--stdin"]);
            let mut roots = Vec::new();
            if filtered {
                // Branch visibility does not hide independent tag or stash history.
                // Select roots before pagination and pass only resolved IDs on stdin.
                git.arg("--tags");
                roots.extend(visible_tips.iter().copied());
            } else {
                git.arg("--all");
            }
            roots.extend(stashes.iter().map(|stash| stash.tip.as_str()));
            if !filtered || status.branch.is_none() {
                roots.extend(status.head.as_deref());
            }
            git.arg("--");
            let input = roots.join("\n");
            let output = execute(git, &[], Some(input.as_bytes()))?;
            if output.truncated {
                return Err("tooMuchData".into());
            }
            string(&output.bytes)
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let HistoryPage {
            commits,
            next_commit,
        } = self.read_history(&history_roots, 0, limit)?;

        let remotes = self.text(["remote"])?;
        let remotes: Result<Vec<_>> = remotes
            .lines()
            .map(|name| {
                let url = self.text(["remote", "get-url", "--", name])?;
                Ok(Remote {
                    name: name.into(),
                    url: redact_remote(&url),
                })
            })
            .collect();
        let path = self.0.to_string_lossy().into_owned();
        let name = self
            .0
            .file_name()
            .unwrap_or(self.0.as_os_str())
            .to_string_lossy()
            .into_owned();
        Ok(Snapshot {
            has_older_commits: next_commit.is_some(),
            history_cursor: next_commit.map(|next| HistoryCursor {
                roots: history_roots,
                next,
            }),
            path,
            name,
            status,
            branches,
            worktrees: self.worktrees()?,
            commits,
            stashes,
            tags,
            remotes: remotes?,
            operation: self.operation()?,
            push_lease,
            settings: self.settings()?,
        })
    }

    pub fn history_page(&self, request: HistoryPageRequest) -> Result<HistoryPage> {
        if request.offset >= HISTORY_LIMIT || request.limit == 0 {
            return Err("tooMuchData".into());
        }
        for oid in &request.roots {
            validate_oid(oid)?;
        }
        let limit = request
            .limit
            .min(HISTORY_PAGE_SIZE)
            .min(HISTORY_LIMIT - request.offset);
        self.read_history(&request.roots, request.offset, limit)
    }

    fn read_history(&self, roots: &[String], offset: usize, limit: usize) -> Result<HistoryPage> {
        if roots.is_empty() {
            return Ok(HistoryPage::default());
        }
        let mut git = self.command();
        git.args([
            "log",
            "--topo-order",
            "--no-show-signature",
            "-z",
            "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%aI%x00%ae",
            &format!("--skip={offset}"),
            &format!("--max-count={}", limit + 1),
            "--stdin",
            "--",
        ]);
        let output = execute(git, &[], Some(roots.join("\n").as_bytes()))?;
        if output.truncated {
            // A deep refresh may cover several pages the user already loaded.
            // Retry at page size so each Git read keeps its normal output bound.
            if limit > HISTORY_PAGE_SIZE {
                let mut page = self.read_history(roots, offset, HISTORY_PAGE_SIZE)?;
                while page.next_commit.is_some() && page.commits.len() < limit {
                    let loaded = page.commits.len();
                    let next = self.read_history(
                        roots,
                        offset + loaded,
                        HISTORY_PAGE_SIZE.min(limit - loaded),
                    )?;
                    if next.commits.first().map(|commit| &commit.id) != page.next_commit.as_ref() {
                        return Err("staleHistoryAction".into());
                    }
                    page.commits.extend(next.commits);
                    page.next_commit = next.next_commit;
                }
                return Ok(page);
            }
            return Err("tooMuchData".into());
        }
        let log = string(&output.bytes);
        let mut commits: Vec<Commit> = log
            .split_terminator('\0')
            .collect::<Vec<_>>()
            .as_chunks::<7>()
            .0
            .iter()
            .map(|fields| Commit {
                id: fields[0].into(),
                short_id: fields[1].into(),
                parents: fields[2]
                    .split_ascii_whitespace()
                    .map(str::to_owned)
                    .collect(),
                subject: fields[3].into(),
                author: fields[4].into(),
                date: fields[5].into(),
                email: fields[6].into(),
            })
            .collect();
        let next_commit = if commits.len() > limit {
            commits.pop().map(|commit| commit.id)
        } else {
            None
        };
        Ok(HistoryPage {
            commits,
            next_commit,
        })
    }

    pub(super) fn tags(&self) -> Result<Vec<Tag>> {
        let mut git = self.command();
        git.args(["show-ref", "--tags", "--dereference"]);
        let output = execute(git, &[1], None)?;
        if output.truncated {
            return Err("tooManyTags".into());
        }
        let mut tags = std::collections::BTreeMap::new();
        for (tip, reference) in string(&output.bytes)
            .lines()
            .filter_map(|line| line.split_once(' '))
        {
            if let Some(name) = reference.strip_prefix("refs/tags/") {
                if let Some(name) = name.strip_suffix("^{}") {
                    tags.insert(name.to_owned(), tip.to_owned());
                } else {
                    tags.entry(name.to_owned())
                        .or_insert_with(|| tip.to_owned());
                }
            }
        }
        Ok(tags
            .into_iter()
            .map(|(name, tip)| Tag { name, tip })
            .collect())
    }
}

fn parse_status(bytes: &[u8]) -> Result<Status> {
    let mut status = Status::default();
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix(b"# ") {
            if let Some((key, value)) = string(header).split_once(' ') {
                match key {
                    "branch.head" if value != "(detached)" => status.branch = Some(value.into()),
                    "branch.oid" if value != "(initial)" => status.head = Some(value.into()),
                    "branch.upstream" => status.upstream = Some(value.into()),
                    "branch.ab" => {
                        if let Some((ahead, behind)) = value.split_once(' ') {
                            status.ahead =
                                ahead.trim_start_matches('+').parse().unwrap_or_default();
                            status.behind =
                                behind.trim_start_matches('-').parse().unwrap_or_default();
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }
        let (fields, original, conflict) = match record.first() {
            Some(b'1') => (9, None, false),
            Some(b'2') => (
                10,
                Some(records.next().ok_or("missingRenameSource")?),
                false,
            ),
            Some(b'u') => (11, None, true),
            Some(b'?') => (2, None, false),
            _ => continue,
        };
        let parts: Vec<_> = record.splitn(fields, |byte| *byte == b' ').collect();
        if parts.len() != fields {
            return Err("incompleteStatus".into());
        }
        let path = parts[fields - 1];
        let (index, worktree) = if fields == 2 {
            ('.', '?')
        } else if let [index, worktree] = parts[1] {
            (*index as char, *worktree as char)
        } else {
            return Err("invalidFileStatus".into());
        };
        let scope = if worktree == '?' {
            "untracked"
        } else {
            "tracked"
        };
        let mut id = format!("{scope}:{}", URL_SAFE_NO_PAD.encode(path));
        if let Some(original) = original {
            id.push('.');
            id.push_str(&URL_SAFE_NO_PAD.encode(original));
        }
        status.files.push(FileChange {
            id,
            path: string(path.strip_suffix(b"/").unwrap_or(path)),
            original_path: original.map(string),
            index,
            worktree,
            conflict,
            submodule: fields != 2
                && (parts[2].starts_with(b"S")
                    || parts[3..if conflict { 7 } else { 6 }].contains(&b"160000".as_slice())),
        });
    }
    Ok(status)
}
