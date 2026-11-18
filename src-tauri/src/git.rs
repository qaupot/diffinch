mod actions;
mod author;
mod conflicts;
#[cfg(test)]
mod contracts;
mod credential_accounts;
mod credential_helpers;
mod credentials;
mod diff;
mod discard;
mod extensions;
mod external_tools;
mod file_history;
mod images;
mod model;
mod process;
mod rebase;
mod refs;
mod remotes;
mod search;
mod staging;
mod status;
#[cfg(test)]
mod tests;
mod worktrees;

pub use credential_accounts::{CredentialAccount, CredentialAccountRequest};
pub use credentials::{CredentialTarget, CredentialUpdate};
pub use extensions::{ToolKind, ToolState};
pub use file_history::{FileInspectionRequest, FileInspectionResult};
#[cfg(test)]
pub use model::Action;
pub use model::{
    AuthorPlan, Comparison, Conflict, Diff, DiffOptions, DiscardPlan, GitActionRequest,
    HistoryPage, HistoryPageRequest, RebasePlan, RemoteRefKind, RemoteRefs, Snapshot, WorkingState,
};
pub use process::{
    check_operation, operation_cancellation, with_operation, Cancellation, Transfer,
};
use process::{command, execute, execute_command, Output};
#[cfg(test)]
use search::SearchField;
pub use search::{CommitSearch, CommitSearchRequest};
use serde::Serialize;
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

pub type Result<T> = std::result::Result<T, GitError>;

#[derive(Debug, Serialize)]
pub struct GitError {
    key: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl GitError {
    pub fn new(key: &'static str, detail: impl ToString) -> Self {
        Self {
            key,
            detail: Some(remotes::redact_git_output(&detail.to_string())),
        }
    }
}

impl From<&'static str> for GitError {
    fn from(key: &'static str) -> Self {
        Self { key, detail: None }
    }
}

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const HISTORY_PAGE_SIZE: usize = 160;
const HISTORY_LIMIT: usize = 2_000;

fn bytes_to_os(bytes: &[u8]) -> Result<OsString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| "pathEncoding".into())
    }
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    let Some(line) = bytes.strip_suffix(b"\n") else {
        return bytes;
    };
    if cfg!(windows) {
        return line.strip_suffix(b"\r").unwrap_or(line);
    }
    line
}

fn string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub struct Repo(PathBuf);

impl Repo {
    pub fn root(&self) -> &Path {
        &self.0
    }

    fn metadata_dir(&self, flag: &str) -> Result<PathBuf> {
        let output = self.run(["rev-parse", "--path-format=absolute", flag])?;
        Ok(PathBuf::from(bytes_to_os(trim_line(&output.bytes))?))
    }

    pub fn common_dir(&self) -> Result<PathBuf> {
        self.metadata_dir("--git-common-dir")
    }

    pub fn git_dir(&self) -> Result<PathBuf> {
        self.metadata_dir("--git-dir")
    }

    pub fn discover(path: impl AsRef<Path>) -> Result<Self> {
        let mut git = command();
        git.current_dir(path)
            .args(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
        let root = execute(git, &[], None)?;
        let root = PathBuf::from(bytes_to_os(trim_line(&root.bytes))?);
        if root.to_str().is_none() {
            return Err("repoPathEncoding".into());
        }
        Ok(Self(root))
    }

    pub fn init(path: &Path) -> Result<Self> {
        let mut git = command();
        git.current_dir(path)
            .args(["init", "--initial-branch=main"]);
        execute(git, &[], None)?;
        Self::discover(path)
    }

    pub fn clone(
        url: &str,
        parent: &Path,
        name: &str,
        transfer: Option<&Transfer<'_>>,
    ) -> Result<Self> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
            || name.contains(['/', '\\'])
        {
            return Err("invalidCloneFolder".into());
        }
        if url.trim().is_empty() {
            return Err("missingCloneUrl".into());
        }
        let mut git = command();
        git.current_dir(parent).arg("clone");
        if transfer.is_some() {
            git.arg("--progress");
        }
        git.args(["--", url.trim(), name]);
        execute_command(git, &[], None, OUTPUT_LIMIT, transfer)?;
        Self::discover(parent.join(name))
    }

    pub fn fetch(&self, prune: bool, transfer: Option<&Transfer<'_>>) -> Result<&'static str> {
        let mut git = self.command();
        git.args(["fetch", "--all"]);
        if prune {
            git.args(["--prune", "--no-prune-tags"]);
        }
        if transfer.is_some() {
            git.arg("--progress");
        }
        execute_command(git, &[], None, OUTPUT_LIMIT, transfer)?;
        Ok(if prune { "fetchPruned" } else { "fetchedAll" })
    }

    fn command(&self) -> Command {
        let mut git = command();
        git.current_dir(&self.0);
        git
    }

    fn run(&self, args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> Result<Output> {
        let mut git = self.command();
        git.args(args);
        execute(git, &[], None)
    }

    fn text(&self, args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> Result<String> {
        let out = self.run(args)?;
        if out.truncated {
            return Err("tooMuchData".into());
        }
        Ok(string(trim_line(&out.bytes)))
    }

    fn optional_config(&self, args: &[&str]) -> Result<String> {
        let mut git = self.command();
        git.arg("config").args(args);
        execute(git, &[1], None).map(|out| string(trim_line(&out.bytes)))
    }
}
