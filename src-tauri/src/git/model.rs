use super::{
    credential_helpers::CredentialHelper,
    extensions::ToolAction,
    external_tools::EditorCommand,
    images::ImagePreview,
    worktrees::{Worktree, WorktreeMode},
};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
pub struct GitActionRequest {
    pub id: String,
    pub action: Action,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub(super) branch: Option<String>,
    pub(super) upstream: Option<String>,
    pub(super) head: Option<String>,
    pub(super) ahead: u32,
    pub(super) behind: u32,
    pub(super) files: Vec<FileChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileChange {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) original_path: Option<String>,
    pub(super) index: char,
    pub(super) worktree: char,
    pub(super) conflict: bool,
    pub(super) submodule: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Branch {
    pub(super) name: String,
    pub(super) tip: String,
    pub(super) current: bool,
    pub(super) remote: bool,
    pub(super) upstream: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Commit {
    pub(super) id: String,
    pub(super) short_id: String,
    pub(super) parents: Vec<String>,
    pub(super) subject: String,
    pub(super) author: String,
    pub(super) email: String,
    pub(super) date: String,
}

#[derive(Serialize)]
pub(super) struct Tag {
    pub(super) name: String,
    pub(super) tip: String,
}

#[derive(Serialize)]
pub(super) struct Stash {
    pub(super) id: String,
    pub(super) tip: String,
    pub(super) subject: String,
}

#[derive(Serialize)]
pub(super) struct Remote {
    pub(super) name: String,
    pub(super) url: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteRefKind {
    Branch,
    Tag,
}

impl RemoteRefKind {
    pub(super) fn prefix(self) -> &'static str {
        match self {
            Self::Branch => "refs/heads/",
            Self::Tag => "refs/tags/",
        }
    }
}

#[derive(Serialize)]
pub(super) struct RemoteRef {
    pub(super) name: String,
    pub(super) tip: String,
}

#[derive(Serialize)]
pub struct RemoteRefs {
    pub(super) destination: String,
    pub(super) url: String,
    pub(super) refs: Vec<RemoteRef>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub name: String,
    pub email: String,
    pub sign_commits: bool,
    pub signing_format: String,
    pub signing_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub(super) history_cursor: Option<HistoryCursor>,
    pub(super) path: String,
    pub(super) name: String,
    pub(super) status: Status,
    pub(super) branches: Vec<Branch>,
    pub(super) worktrees: Vec<Worktree>,
    pub(super) commits: Vec<Commit>,
    pub(super) has_older_commits: bool,
    pub(super) stashes: Vec<Stash>,
    pub(super) tags: Vec<Tag>,
    pub(super) remotes: Vec<Remote>,
    pub(super) operation: Option<String>,
    pub(super) push_lease: Option<PushLease>,
    pub(super) settings: Settings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageRequest {
    pub(super) roots: Vec<String>,
    pub(super) offset: usize,
    pub(super) limit: usize,
}

#[derive(Serialize)]
pub(super) struct HistoryCursor {
    pub(super) roots: Vec<String>,
    pub(super) next: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub(super) commits: Vec<Commit>,
    pub(super) next_commit: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingState {
    pub(super) status: Status,
    pub(super) operation: Option<String>,
    pub(super) push_lease: Option<PushLease>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPlan {
    pub(super) id: String,
    pub(super) token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub(super) base: Option<String>,
    pub(super) current: Option<String>,
    pub(super) incoming: Option<String>,
    pub(super) result: String,
    pub(super) token: String,
    pub(super) marker_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonFile {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) original_path: Option<String>,
    pub(super) additions: Option<u32>,
    pub(super) deletions: Option<u32>,
}

#[derive(Serialize)]
pub struct Comparison {
    pub(super) base: String,
    pub(super) target: String,
    pub(super) files: Vec<ComparisonFile>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushLease {
    pub(super) branch: String,
    pub(super) head: String,
    pub(super) remote: String,
    pub(super) target: String,
    pub(super) expected: String,
    pub(super) destination: String,
}

#[derive(Deserialize)]
pub struct HeadTarget {
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorPlan {
    pub(super) branch: String,
    pub(super) head: String,
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) subject: String,
    pub(super) affected_commits: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub(super) branch: String,
    pub(super) head: String,
    pub(super) base: String,
    pub(super) from_root: bool,
    pub(super) commits: Vec<RebaseCommit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RebaseCommit {
    pub(super) id: String,
    pub(super) short_id: String,
    pub(super) subject: String,
}

#[derive(Deserialize)]
pub struct RebaseStep {
    pub(super) id: String,
    #[serde(flatten)]
    pub(super) operation: RebaseOperation,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(super) enum RebaseOperation {
    Pick,
    Reword { message: String },
    Squash,
    Fixup,
    Drop,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub(super) text: String,
    pub(super) truncated: bool,
    pub(super) hunk_token: Option<String>,
    pub(super) images: Vec<ImagePreview>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    pub(super) ignore_whitespace: bool,
    pub(super) page: u32,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    OpenEditor {
        file: String,
        editor: EditorCommand,
    },
    MergeTool {
        id: String,
    },
    RepositoryTool {
        action: ToolAction,
    },
    Stage {
        id: String,
    },
    Unstage {
        id: String,
    },
    StageFiles {
        ids: Vec<String>,
    },
    UnstageFiles {
        ids: Vec<String>,
    },
    StageAll,
    UnstageAll,
    Discard {
        id: String,
        token: String,
    },
    ResolveConflict {
        id: String,
        token: String,
        text: String,
    },
    Hunk {
        id: String,
        staged: bool,
        index: usize,
        token: String,
        page: Option<u32>,
        lines: Option<Vec<usize>>,
    },
    Commit {
        summary: String,
        description: String,
        sign: bool,
        amend: Option<HeadTarget>,
    },
    ChangeAuthor {
        branch: String,
        head: String,
        id: String,
        name: String,
        email: String,
    },
    Fetch,
    FetchPrune,
    Pull,
    PullRebase {
        target: HeadTarget,
    },
    Push,
    ForcePush {
        lease: PushLease,
    },
    Publish {
        remote: String,
    },
    CreateBranch {
        name: String,
        checkout: bool,
        start: Option<String>,
    },
    SwitchBranch {
        name: String,
        remote: bool,
    },
    DeleteBranch {
        name: String,
    },
    CreateWorktree {
        parent: String,
        name: String,
        mode: WorktreeMode,
        branch: String,
        start: String,
    },
    RemoveWorktree {
        path: String,
        head: Option<String>,
        branch: Option<String>,
    },
    Merge {
        name: String,
        #[serde(default)]
        remote: bool,
        tip: String,
        target: HeadTarget,
    },
    Rebase {
        name: String,
        #[serde(default)]
        remote: bool,
        tip: String,
        target: HeadTarget,
    },
    InteractiveRebase {
        branch: String,
        head: String,
        base: String,
        #[serde(default)]
        from_root: bool,
        steps: Vec<RebaseStep>,
    },
    CherryPick {
        id: String,
        target: HeadTarget,
    },
    Revert {
        id: String,
        target: HeadTarget,
    },
    Stash {
        message: String,
        include_untracked: bool,
    },
    ApplyStash {
        id: String,
        tip: String,
    },
    PopStash {
        id: String,
        tip: String,
    },
    DropStash {
        id: String,
        tip: String,
    },
    CreateTag {
        name: String,
        start: Option<String>,
    },
    DeleteTag {
        name: String,
    },
    DeleteRemoteRef {
        remote: String,
        ref_kind: RemoteRefKind,
        name: String,
        tip: String,
        destination: String,
    },
    AddRemote {
        name: String,
        url: String,
    },
    RemoveRemote {
        name: String,
    },
    SaveSettings {
        settings: Settings,
    },
    ConfigureCredentialHelper {
        remote: String,
        destination: String,
        helper: Option<CredentialHelper>,
        token: String,
    },
    ContinueOperation,
    SkipRebase,
    AbortOperation,
}
