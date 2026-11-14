use super::{
    process::execute, refs::validate_oid, remotes::redact_remote, string, GitError, Repo, Result,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::{
    collections::HashMap,
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Submodules,
    Subtrees,
    Lfs,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolState {
    Submodules {
        items: Vec<Submodule>,
    },
    Subtrees {
        available: bool,
        items: Vec<Subtree>,
    },
    Lfs {
        available: bool,
        version: String,
        patterns: String,
        files: Vec<LfsFile>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    name: String,
    path: String,
    url: String,
    branch: String,
    expected: String,
    head: Option<String>,
    dirty: bool,
    conflict: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Subtree {
    prefix: String,
    remote: String,
    branch: String,
    squash: bool,
}

#[derive(Deserialize, Serialize)]
pub struct LfsFile {
    name: String,
    oid: String,
    size: u64,
    downloaded: bool,
    checkout: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolAction {
    AddSubmodule {
        url: String,
        path: String,
        branch: String,
    },
    UpdateSubmodule {
        path: Option<String>,
        remote: bool,
    },
    SyncSubmodules,
    Subtree {
        operation: SubtreeOperation,
        prefix: String,
        remote: String,
        branch: String,
        squash: bool,
    },
    LfsInstall,
    LfsTrack {
        pattern: String,
        untrack: bool,
    },
    LfsTransfer {
        operation: LfsOperation,
        remote: String,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubtreeOperation {
    Add,
    Pull,
    Push,
    Split,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LfsOperation {
    Fetch,
    Pull,
    Checkout,
}

impl Repo {
    // Commands accepting paths must stay in this checkout, including through symlinks.
    fn extension_path(&self, path: &str) -> Result<PathBuf> {
        if path.is_empty()
            || path.starts_with('-')
            || path.contains(['\\', '\0', '\n', '\r'])
            || path.split('/').any(|part| {
                part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
            })
            || !Path::new(path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            return Err("invalidExtensionPath".into());
        }
        let mut full = self.0.clone();
        for part in Path::new(path).components() {
            full.push(part);
            match full.symlink_metadata() {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("invalidExtensionPath".into())
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(GitError::new("gitIoFailed", error)),
            }
        }
        Ok(full)
    }

    fn submodules(&self) -> Result<Vec<Submodule>> {
        let modules = self.extension_path(".gitmodules")?;
        if !modules.is_file() {
            return Ok(Vec::new());
        }
        let mut git = self.command();
        git.args([
            "config",
            "--null",
            "--file",
            ".gitmodules",
            "--get-regexp",
            "^submodule\\..*\\.path$",
        ]);
        let output = execute(git, &[1], None)?;
        if output.truncated {
            return Err("tooManyPaths".into());
        }
        let index = self.run(["ls-files", "--stage", "-z"])?;
        if index.truncated {
            return Err("tooManyPaths".into());
        }
        let mut links = HashMap::new();
        for record in index.bytes.split(|byte| *byte == 0) {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            let header = string(&record[..tab]);
            let fields: Vec<_> = header.split(' ').collect();
            if fields.len() == 3 && fields[0] == "160000" {
                links.insert(
                    string(&record[tab + 1..]),
                    (fields[1].to_string(), fields[2] != "0"),
                );
            }
        }
        let mut items = Vec::new();
        for record in output
            .bytes
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let record = std::str::from_utf8(record).map_err(|_| "invalidGitPath")?;
            let (key, path) = record.split_once('\n').ok_or("invalidGitPath")?;
            let name = key
                .strip_prefix("submodule.")
                .and_then(|key| key.strip_suffix(".path"))
                .ok_or("invalidGitPath")?;
            let Some((expected, conflict)) = links.get(path) else {
                continue;
            };
            let child = self.extension_path(path).ok().and_then(|full| {
                if !full.join(".git").exists() {
                    return None;
                }
                let repo = Repo::discover(&full).ok()?;
                (repo.0.canonicalize().ok()? == full.canonicalize().ok()?).then_some(repo)
            });
            let state = child.map(|child| child.status()).transpose()?;
            items.push(Submodule {
                name: name.into(),
                path: path.into(),
                url: redact_remote(&self.optional_config(&[
                    "--file",
                    ".gitmodules",
                    "--get",
                    &format!("submodule.{name}.url"),
                ])?),
                branch: self.optional_config(&[
                    "--file",
                    ".gitmodules",
                    "--get",
                    &format!("submodule.{name}.branch"),
                ])?,
                expected: expected.clone(),
                conflict: *conflict,
                head: state.as_ref().and_then(|state| state.head.clone()),
                dirty: state.is_some_and(|state| !state.files.is_empty()),
            });
        }
        items.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(items)
    }

    fn saved_subtrees(&self) -> Result<Vec<Subtree>> {
        let value = self.optional_config(&["--local", "--get", "diffinch.subtrees"])?;
        if value.is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str(&value).map_err(|error| GitError::new("invalidSubtreeConfig", error))
    }

    fn subtrees(&self) -> Result<Vec<Subtree>> {
        let mut items: BTreeMap<String, Subtree> = self
            .saved_subtrees()?
            .into_iter()
            .map(|item| (item.prefix.clone(), item))
            .collect();
        if self.status()?.head.is_some() {
            let history = self.text([
                "log",
                "--format=%(trailers:key=git-subtree-dir,valueonly)",
                "--grep=^git-subtree-dir:",
                "HEAD",
                "--",
            ])?;
            for prefix in history.lines().filter(|line| !line.is_empty()) {
                if self.extension_path(prefix).is_ok_and(|path| path.is_dir()) {
                    items.entry(prefix.into()).or_insert_with(|| Subtree {
                        prefix: prefix.into(),
                        remote: String::new(),
                        branch: String::new(),
                        squash: true,
                    });
                }
            }
        }
        Ok(items
            .into_values()
            .filter(|item| {
                self.extension_path(&item.prefix)
                    .is_ok_and(|path| path.is_dir())
            })
            .collect())
    }

    fn has_subtree(&self) -> bool {
        let mut git = self.command();
        git.args(["subtree", "-h"]);
        execute(git, &[129], None).is_ok()
    }

    pub fn repository_tools(&self, kind: ToolKind) -> Result<ToolState> {
        Ok(match kind {
            ToolKind::Submodules => ToolState::Submodules {
                items: self.submodules()?,
            },
            ToolKind::Subtrees => ToolState::Subtrees {
                available: self.has_subtree(),
                items: self.subtrees()?,
            },
            ToolKind::Lfs => {
                let version = self.text(["lfs", "version"]).unwrap_or_default();
                if version.is_empty() {
                    ToolState::Lfs {
                        available: false,
                        version,
                        patterns: String::new(),
                        files: Vec::new(),
                    }
                } else {
                    #[derive(Deserialize)]
                    struct Files {
                        files: Option<Vec<LfsFile>>,
                    }
                    let output = self.text(["lfs", "ls-files", "--json"])?;
                    let files: Files = serde_json::from_str(&output)
                        .map_err(|error| GitError::new("gitOutput", error))?;
                    ToolState::Lfs {
                        available: true,
                        version,
                        patterns: self.text(["lfs", "track"])?,
                        files: files.files.unwrap_or_default(),
                    }
                }
            }
        })
    }

    pub(super) fn repository_tool_action(&self, action: ToolAction) -> Result<&'static str> {
        match action {
            ToolAction::AddSubmodule { url, path, branch } => {
                self.extension_path(&path)?;
                self.extension_path(".gitmodules")?;
                extension_argument(&url)?;
                let mut git = self.command();
                git.args(["submodule", "add"]);
                if !branch.is_empty() {
                    self.check_ref("refs/heads/", &branch)?;
                    git.args(["--branch", &branch]);
                }
                git.args(["--", &url, &path]);
                execute(git, &[], None)?;
                Ok("submoduleAdded")
            }
            ToolAction::UpdateSubmodule { path, remote } => {
                if remote && path.is_none() {
                    return Err("invalidExtensionPath".into());
                }
                let items = self.submodules()?;
                for item in &items {
                    self.extension_path(&item.path)?;
                }
                if let Some(path) = &path {
                    if !items
                        .iter()
                        .any(|item| &item.path == path && !item.conflict)
                    {
                        return Err("changeMissing".into());
                    }
                }
                let mut git = self.command();
                // Explicit checkout ignores custom submodule update commands. Never force away edits.
                git.args([
                    "--literal-pathspecs",
                    "submodule",
                    "update",
                    "--init",
                    "--recursive",
                    "--checkout",
                ]);
                if remote {
                    git.arg("--remote");
                }
                git.arg("--");
                if let Some(path) = path {
                    git.arg(path);
                }
                execute(git, &[], None)?;
                Ok("submodulesUpdated")
            }
            ToolAction::SyncSubmodules => {
                self.submodules()?;
                self.run(["submodule", "sync", "--recursive"])?;
                Ok("submodulesSynced")
            }
            ToolAction::Subtree {
                operation,
                prefix,
                remote,
                branch,
                squash,
            } => {
                self.extension_path(&prefix)?;
                self.check_ref("refs/heads/", &branch)?;
                if !self.has_subtree() {
                    return Err("subtreeUnavailable".into());
                }
                // Parse saved settings before running a command that can create commits or push.
                let mut saved = self.saved_subtrees()?;
                let mut git = self.command();
                git.arg("subtree")
                    .arg(match operation {
                        SubtreeOperation::Add => "add",
                        SubtreeOperation::Pull => "pull",
                        SubtreeOperation::Push => "push",
                        SubtreeOperation::Split => "split",
                    })
                    .arg(format!("--prefix={prefix}"));
                if matches!(operation, SubtreeOperation::Split) {
                    git.args(["--branch", &branch]);
                } else {
                    extension_argument(&remote)?;
                    if squash && matches!(operation, SubtreeOperation::Add | SubtreeOperation::Pull)
                    {
                        git.arg("--squash");
                    }
                    git.args(["--", &remote, &branch]);
                }
                execute(git, &[], None)?;
                if !matches!(operation, SubtreeOperation::Split) {
                    saved.retain(|item| item.prefix != prefix);
                    saved.push(Subtree {
                        prefix,
                        remote,
                        branch,
                        squash,
                    });
                    let value = serde_json::to_string(&saved)
                        .map_err(|error| GitError::new("invalidSubtreeConfig", error))?;
                    self.run(["config", "--local", "diffinch.subtrees", &value])?;
                }
                Ok("subtreeComplete")
            }
            ToolAction::LfsInstall => {
                self.run(["lfs", "install", "--local"])?;
                Ok("lfsInstalled")
            }
            ToolAction::LfsTrack { pattern, untrack } => {
                self.extension_path(".gitattributes")?;
                extension_argument(&pattern)?;
                if Path::new(&pattern).is_absolute()
                    || pattern.contains('\\')
                    || pattern.split('/').any(|part| part == "..")
                {
                    return Err("invalidExtensionPath".into());
                }
                self.run([
                    "lfs",
                    if untrack { "untrack" } else { "track" },
                    "--",
                    &pattern,
                ])?;
                Ok("lfsTrackingUpdated")
            }
            ToolAction::LfsTransfer { operation, remote } => {
                let mut git = self.command();
                git.arg("lfs").arg(match operation {
                    LfsOperation::Fetch => "fetch",
                    LfsOperation::Pull => "pull",
                    LfsOperation::Checkout => "checkout",
                });
                if !matches!(operation, LfsOperation::Checkout) {
                    self.tracked_remote(&remote)?;
                    git.args(["--", &remote]);
                }
                execute(git, &[], None)?;
                Ok("lfsComplete")
            }
        }
    }

    pub(super) fn is_lfs_path(&self, path: &OsStr) -> Result<bool> {
        let output = self.run([
            OsStr::new("check-attr"),
            OsStr::new("-z"),
            OsStr::new("filter"),
            OsStr::new("--"),
            path,
        ])?;
        Ok(output.bytes.split(|byte| *byte == 0).nth(2) == Some(b"lfs".as_slice()))
    }

    pub(super) fn lfs_object_path(&self, oid: &str) -> Result<PathBuf> {
        if oid.len() != 64 {
            return Err("lfsImageMissing".into());
        }
        validate_oid(oid)?;
        let environment = self.text(["lfs", "env"])?;
        let directory = environment
            .lines()
            .find_map(|line| line.strip_prefix("LocalMediaDir="))
            .filter(|directory| !directory.is_empty())
            .ok_or("lfsImageMissing")?;
        Ok(self
            .0
            .join(directory)
            .join(&oid[..2])
            .join(&oid[2..4])
            .join(oid))
    }
}

fn extension_argument(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.starts_with('-') || value.contains(['\0', '\r', '\n']) {
        return Err("invalidExtensionArgument".into());
    }
    Ok(())
}

// Pointers are metadata, never editable file content for partial staging or image decoding.
pub(super) fn lfs_pointer(bytes: &[u8]) -> Option<(&str, u64)> {
    if bytes.len() >= 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if !matches!(
        lines.next()?,
        "version https://git-lfs.github.com/spec/v1" | "version https://hawser.github.com/spec/v1"
    ) {
        return None;
    }
    let oid = lines.next()?.strip_prefix("oid sha256:")?;
    if oid.len() != 64
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let size = lines.next()?.strip_prefix("size ")?.parse().ok()?;
    if lines.next().is_some() {
        return None;
    }
    Some((oid, size))
}

#[cfg(test)]
mod tests {
    use super::super::model::{Action, DiffOptions};
    use super::*;
    use base64::Engine;
    use std::fs;

    fn repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo::init(dir.path()).unwrap();
        for (key, value) in [
            ("user.name", "Diffinch Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ".git/test-hooks"),
            ("protocol.file.allow", "always"),
        ] {
            repo.run(["config", "--local", key, value]).unwrap();
        }
        (dir, repo)
    }

    fn commit(repo: &Repo, name: &str, content: &str) -> String {
        fs::write(repo.0.join(name), content).unwrap();
        repo.run(["add", "--all"]).unwrap();
        repo.run(["commit", "--no-gpg-sign", "-m", "Test change"])
            .unwrap();
        repo.text(["rev-parse", "HEAD"]).unwrap()
    }

    #[test]
    fn submodules_inspect_update_stage_and_reject_partial_staging() {
        let (_source_dir, source) = repo();
        let first = commit(&source, "file.txt", "first\n");
        let (_parent_dir, parent) = repo();
        commit(&parent, "README", "parent\n");
        // Pre-clone the child so tests need no global file-protocol configuration.
        parent
            .run(["clone", "--", source.0.to_str().unwrap(), "nested module"])
            .unwrap();
        parent
            .repository_tool_action(ToolAction::AddSubmodule {
                url: source.0.to_string_lossy().into(),
                path: "nested module".into(),
                branch: "main".into(),
            })
            .unwrap();
        parent
            .run(["commit", "--no-gpg-sign", "-am", "Add module"])
            .unwrap();
        let modules = parent.submodules().unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].head.as_deref(), Some(first.as_str()));
        assert!(!modules[0].dirty);
        let child = Repo::discover(parent.0.join("nested module")).unwrap();
        child.run(["config", "user.name", "Diffinch Test"]).unwrap();
        child
            .run(["config", "user.email", "test@example.invalid"])
            .unwrap();
        fs::write(child.0.join("untracked.txt"), "keep me\n").unwrap();
        assert!(parent.submodules().unwrap()[0].dirty);
        fs::remove_file(child.0.join("untracked.txt")).unwrap();
        let second = commit(&child, "file.txt", "second\n");
        parent
            .run(["config", "diff.ignoreSubmodules", "all"])
            .unwrap();
        let file = parent.status().unwrap().files.remove(0);
        assert!(file.submodule);
        let diff = parent
            .file_diff(&file.id, false, DiffOptions::default())
            .unwrap();
        assert!(diff.text.contains(&second));
        assert!(diff.hunk_token.is_none());
        assert!(parent
            .action(Action::Discard {
                id: file.id.clone(),
                token: "invalid-submodule-discard".into(),
            })
            .is_err());
        parent
            .action(Action::Stage {
                id: file.id.clone(),
            })
            .unwrap();
        assert_eq!(parent.submodules().unwrap()[0].expected, second);
        parent.action(Action::Unstage { id: file.id }).unwrap();
        parent
            .repository_tool_action(ToolAction::UpdateSubmodule {
                path: Some("nested module".into()),
                remote: false,
            })
            .unwrap();
        assert_eq!(
            parent.submodules().unwrap()[0].head.as_deref(),
            Some(first.as_str())
        );
        let remote_tip = commit(&source, "file.txt", "remote update\n");
        child
            .run(["config", "protocol.file.allow", "always"])
            .unwrap();
        parent
            .repository_tool_action(ToolAction::UpdateSubmodule {
                path: Some("nested module".into()),
                remote: true,
            })
            .unwrap();
        assert_eq!(
            parent.submodules().unwrap()[0].head.as_deref(),
            Some(remote_tip.as_str())
        );
        assert_eq!(parent.submodules().unwrap()[0].expected, first);
        parent
            .repository_tool_action(ToolAction::UpdateSubmodule {
                path: Some("nested module".into()),
                remote: false,
            })
            .unwrap();
        parent
            .repository_tool_action(ToolAction::SyncSubmodules)
            .unwrap();
        parent
            .run(["submodule", "deinit", "--", "nested module"])
            .unwrap();
        assert!(parent.submodules().unwrap()[0].head.is_none());
        // Reinitializing a deinitialized checkout reuses its existing local Git directory.
        parent
            .repository_tool_action(ToolAction::UpdateSubmodule {
                path: None,
                remote: false,
            })
            .unwrap();
        assert!(parent.submodules().unwrap()[0].head.is_some());
    }

    #[test]
    fn subtrees_add_discover_pull_split_and_push() {
        let (_source_dir, source) = repo();
        commit(&source, "library.txt", "one\n");
        let (_parent_dir, parent) = repo();
        commit(&parent, "README", "parent\n");
        assert!(
            parent.has_subtree(),
            "git-subtree is required for this integration test"
        );
        let run = |operation, branch: &str| {
            parent.repository_tool_action(ToolAction::Subtree {
                operation,
                prefix: "vendor/lib with spaces".into(),
                remote: source.0.to_string_lossy().into(),
                branch: branch.into(),
                squash: true,
            })
        };
        run(SubtreeOperation::Add, "main").unwrap();
        assert_eq!(
            fs::read_to_string(parent.0.join("vendor/lib with spaces/library.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(parent.subtrees().unwrap()[0].branch, "main");
        parent
            .run(["config", "--unset", "diffinch.subtrees"])
            .unwrap();
        assert_eq!(
            parent.subtrees().unwrap()[0].prefix,
            "vendor/lib with spaces"
        );
        commit(&source, "library.txt", "two\n");
        run(SubtreeOperation::Pull, "main").unwrap();
        assert_eq!(
            fs::read_to_string(parent.0.join("vendor/lib with spaces/library.txt")).unwrap(),
            "two\n"
        );
        commit(&parent, "vendor/lib with spaces/library.txt", "three\n");
        run(SubtreeOperation::Split, "exported").unwrap();
        assert_eq!(
            parent.text(["show", "exported:library.txt"]).unwrap(),
            "three"
        );
        run(SubtreeOperation::Push, "exported").unwrap();
        assert_eq!(
            source.text(["show", "exported:library.txt"]).unwrap(),
            "three"
        );
        assert!(run(SubtreeOperation::Push, "+main:main").is_err());
    }

    #[test]
    fn lfs_tracks_materializes_and_previews_cached_images() {
        let (_dir, repo) = repo();
        assert!(
            repo.text(["lfs", "version"]).is_ok(),
            "git-lfs is required for this integration test"
        );
        repo.repository_tool_action(ToolAction::LfsInstall).unwrap();
        repo.run(["config", "lfs.storage", "custom-lfs-store"])
            .unwrap();
        repo.run(["config", "core.excludesFile", ".git/test-excludes"])
            .unwrap();
        fs::write(repo.0.join(".git/test-excludes"), "/custom-lfs-store/\n").unwrap();
        repo.repository_tool_action(ToolAction::LfsTrack {
            pattern: "*.svg".into(),
            untrack: false,
        })
        .unwrap();
        let before = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>before</text></svg>\n";
        let after = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>after</text></svg>\n";
        let id = commit(&repo, "picture with spaces.svg", before);
        let pointer = repo.text(["show", "HEAD:picture with spaces.svg"]).unwrap();
        let (oid, size) = lfs_pointer(pointer.as_bytes()).unwrap();
        assert_eq!(size, before.len() as u64);
        let cached = repo.lfs_object_path(oid).unwrap();
        let diff = repo.history_diff(&id, DiffOptions::default()).unwrap();
        let image = serde_json::to_value(&diff).unwrap();
        assert!(image["images"][0]["after"]["dataUrl"]
            .as_str()
            .unwrap()
            .ends_with(&base64::engine::general_purpose::STANDARD.encode(before)));
        let linked_dir = tempfile::tempdir().unwrap();
        let linked_path = linked_dir.path().join("linked");
        repo.run([
            "worktree",
            "add",
            "--detach",
            linked_path.to_str().unwrap(),
            &id,
        ])
        .unwrap();
        let linked = Repo::discover(&linked_path).unwrap();
        assert_eq!(linked.lfs_object_path(oid).unwrap(), cached);
        let linked_image =
            serde_json::to_value(linked.history_diff(&id, DiffOptions::default()).unwrap())
                .unwrap();
        assert_eq!(linked_image["images"], image["images"]);
        fs::write(repo.0.join("picture with spaces.svg"), after).unwrap();
        let file = repo
            .status()
            .unwrap()
            .files
            .into_iter()
            .find(|file| file.path.ends_with(".svg"))
            .unwrap();
        assert!(repo
            .file_diff(&file.id, false, DiffOptions::default())
            .unwrap()
            .hunk_token
            .is_none());
        repo.action(Action::Stage {
            id: file.id.clone(),
        })
        .unwrap();
        assert!(repo
            .file_diff(&file.id, true, DiffOptions::default())
            .unwrap()
            .hunk_token
            .is_none());
        let ToolState::Lfs { files, .. } = repo.repository_tools(ToolKind::Lfs).unwrap() else {
            panic!()
        };
        assert_eq!(files[0].name, "picture with spaces.svg");
        assert!(files[0].downloaded);
        fs::remove_file(cached).unwrap();
        let missing =
            serde_json::to_value(repo.history_diff(&id, DiffOptions::default()).unwrap()).unwrap();
        assert_eq!(missing["images"][0]["after"]["error"], "lfsImageMissing");
        assert!(missing["images"][0]["after"]["dataUrl"].is_null());
        let staged_pointer = repo.text(["show", ":picture with spaces.svg"]).unwrap();
        fs::write(
            repo.0.join("picture with spaces.svg"),
            format!("{staged_pointer}\n"),
        )
        .unwrap();
        repo.repository_tool_action(ToolAction::LfsTransfer {
            operation: LfsOperation::Checkout,
            remote: String::new(),
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join("picture with spaces.svg")).unwrap(),
            after
        );
        repo.repository_tool_action(ToolAction::LfsTrack {
            pattern: "*.svg".into(),
            untrack: true,
        })
        .unwrap();
        assert!(!repo
            .is_lfs_path(OsStr::new("picture with spaces.svg"))
            .unwrap());
        assert!(repo
            .file_diff(&file.id, true, DiffOptions::default())
            .unwrap()
            .hunk_token
            .is_none());
    }

    #[test]
    fn lfs_fetch_and_pull_download_current_ref_without_overwriting_edits() {
        let (_source_dir, source) = repo();
        source
            .repository_tool_action(ToolAction::LfsInstall)
            .unwrap();
        source
            .repository_tool_action(ToolAction::LfsTrack {
                pattern: "*.dat".into(),
                untrack: false,
            })
            .unwrap();
        let content = "large-file-content\n";
        commit(&source, "asset.dat", content);
        let (_target_dir, target) = repo();
        target
            .run(["remote", "add", "origin", source.0.to_str().unwrap()])
            .unwrap();
        target.run(["fetch", "origin"]).unwrap();
        target
            .repository_tool_action(ToolAction::LfsInstall)
            .unwrap();
        let mut git = target.command();
        git.env("GIT_LFS_SKIP_SMUDGE", "1")
            .args(["reset", "--hard", "origin/main"]);
        execute(git, &[], None).unwrap();
        let pointer = fs::read(target.0.join("asset.dat")).unwrap();
        let (oid, _) = lfs_pointer(&pointer).unwrap();
        assert!(!target.lfs_object_path(oid).unwrap().exists());
        target
            .repository_tool_action(ToolAction::LfsTransfer {
                operation: LfsOperation::Fetch,
                remote: "origin".into(),
            })
            .unwrap();
        assert!(target.lfs_object_path(oid).unwrap().is_file());
        assert_eq!(fs::read(target.0.join("asset.dat")).unwrap(), pointer);
        target
            .repository_tool_action(ToolAction::LfsTransfer {
                operation: LfsOperation::Pull,
                remote: "origin".into(),
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(target.0.join("asset.dat")).unwrap(),
            content
        );
        fs::write(target.0.join("asset.dat"), "local edit\n").unwrap();
        target
            .repository_tool_action(ToolAction::LfsTransfer {
                operation: LfsOperation::Pull,
                remote: "origin".into(),
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(target.0.join("asset.dat")).unwrap(),
            "local edit\n"
        );
    }

    #[test]
    fn validates_paths_and_pointer_metadata() {
        let (_dir, repo) = repo();
        for path in [
            "",
            ".",
            "../elsewhere",
            "/tmp/elsewhere",
            "x/../y",
            ".git/config",
            "x/.git/config",
            "-option",
            "x\\y",
            "x\ny",
        ] {
            assert!(repo.extension_path(path).is_err(), "{path}");
        }
        for value in ["", "--upload-pack=bad", "one\ntwo", "one\0two"] {
            assert!(extension_argument(value).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), repo.0.join("outside")).unwrap();
            assert!(repo.extension_path("outside/file").is_err());
        }
        let valid = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 42\n",
            "a".repeat(64)
        );
        assert_eq!(lfs_pointer(valid.as_bytes()).unwrap().1, 42);
        assert!(lfs_pointer(valid.replace("size 42", "size -1").as_bytes()).is_none());
        assert!(lfs_pointer(valid.replace(&"a".repeat(64), "../../bad").as_bytes()).is_none());
        assert!(lfs_pointer(b"not a pointer").is_none());
    }
}
