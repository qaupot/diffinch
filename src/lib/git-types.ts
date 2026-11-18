import type { MessageKey } from "../i18n/messages";
import type { RepositoryToolAction } from "./repository-tools";

export type GitError = { key: MessageKey; detail?: string };

export type CommitSearchRequest = {
  id: string;
  query: string;
  field: SearchField;
  caseSensitive: boolean;
};

export type GitActionRequest = { id: string; action: Action };
export type EditorCommand = { program: string; args: string[] };
export type FileRevision = Commit & { path: string; previousPath: string | null; deleted: boolean };
export type FileHistory = { commits: FileRevision[]; hasMore: boolean };
export type BlameLine = {
  id: string;
  author: string;
  email: string;
  timestamp: number;
  summary: string;
  originalLine: number;
  line: number;
  text: string;
};
export type FileBlame = { lines: BlameLine[]; totalLines: number; page: number; hasMore: boolean };
export type FileInspectionRequest =
  | { kind: "catalog"; revision: string }
  | { kind: "history"; revision: string; file: string; limit: number }
  | { kind: "blame"; revision: string; file: string; page: number }
  | {
      kind: "diff";
      revision: string;
      file: string;
      previousPath: string | null;
      options: DiffOptions;
    };
export type FileInspectionResult =
  | { kind: "catalog"; data: { revision: string; files: string[] } }
  | { kind: "history"; data: FileHistory }
  | { kind: "blame"; data: FileBlame }
  | { kind: "diff"; data: Diff };

export type FileChange = {
  id: string;
  path: string;
  originalPath: string | null;
  index: string;
  worktree: string;
  conflict: boolean;
  submodule?: boolean;
};

export type Branch = {
  name: string;
  tip: string;
  current: boolean;
  remote: boolean;
  upstream: string;
};
export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  main: boolean;
  current: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};
export type WorktreeMode = "newBranch" | "existingBranch" | "detached";
export type Tag = { name: string; tip: string };
export type Stash = { id: string; tip: string; subject: string };
export type RemoteRefKind = "branch" | "tag";
export type CredentialHelper =
  "osxkeychain" | "manager" | "manager-core" | "libsecret" | "wincred" | "cache";
export type CredentialHelperSettings = {
  current: CredentialHelper | "inherited" | "custom";
  available: CredentialHelper[];
  token: string;
};
export type CredentialTarget = {
  destination: string;
  url: string;
  transport: "https" | "ssh" | "unsupported";
  storage: "configured" | "keychain" | "unavailable";
  helper: CredentialHelperSettings | null;
};
export type CredentialUpdate = {
  remote: string;
  destination: string;
  username: string;
  password: string | null;
};
export type CredentialAccountRequest = { remote: string; destination: string };
export type CredentialAccount = { username: string | null };
export type RemoteRefs = {
  destination: string;
  url: string;
  refs: { name: string; tip: string }[];
};
export type PushLease = {
  branch: string;
  head: string;
  remote: string;
  target: string;
  expected: string;
  destination: string;
};
export type RebaseCommit = { id: string; shortId: string; subject: string };
export type AuthorPlan = {
  branch: string;
  head: string;
  id: string;
  name: string;
  email: string;
  subject: string;
  affectedCommits: number;
};
export type RebaseOperation = "pick" | "reword" | "squash" | "fixup" | "drop";
export type RebaseStep = { id: string } & (
  { operation: "reword"; message: string } | { operation: Exclude<RebaseOperation, "reword"> }
);
export type RebasePlan = {
  branch: string;
  head: string;
  base: string;
  fromRoot: boolean;
  commits: RebaseCommit[];
};
export type Commit = {
  id: string;
  shortId: string;
  parents: string[];
  subject: string;
  description?: string;
  email: string;
  author: string;
  date: string;
};
export type SearchField = "all" | "title" | "description" | "hash" | "author" | "reference";
export type SearchCommit = Commit & { description: string; references: string };
export type CommitSearch = { commits: SearchCommit[]; hasMore: boolean };
export type Settings = {
  name: string;
  email: string;
  signCommits: boolean;
  signingFormat: string;
  signingKey: string;
};
export type HistoryPage = { commits: Commit[]; nextCommit: string | null };
export type HistoryPageRequest = { roots: string[]; offset: number; limit: number };
export type Snapshot = {
  historyCursor: { roots: string[]; next: string } | null;
  path: string;
  name: string;
  status: {
    branch: string | null;
    upstream: string | null;
    head: string | null;
    ahead: number;
    behind: number;
    files: FileChange[];
  };
  branches: Branch[];
  worktrees: Worktree[];
  commits: Commit[];
  hasOlderCommits: boolean;
  stashes: Stash[];
  tags: Tag[];
  remotes: { name: string; url: string }[];
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  pushLease: PushLease | null;
  settings: Settings;
};
export type ImageVersion = {
  dataUrl: string | null;
  size: number | null;
  error: MessageKey | null;
};
export type ImagePreview = {
  path: string;
  originalPath: string | null;
  before: ImageVersion | null;
  after: ImageVersion | null;
};
export type Diff = {
  text: string;
  truncated: boolean;
  hunkToken: string | null;
  images?: ImagePreview[];
};
export type DiffOptions = { ignoreWhitespace: boolean; page: number };
export type WorkingState = Pick<Snapshot, "status" | "operation" | "pushLease">;
export type RefreshScope = "working" | "full" | "unavailable";
export type DiscardPlan = { id: string; token: string };
export type Conflict = {
  base: string | null;
  current: string | null;
  incoming: string | null;
  result: string;
  token: string;
  markerSize: number;
};
export type ComparisonFile = {
  id: string;
  path: string;
  originalPath: string | null;
  additions: number | null;
  deletions: number | null;
};
export type Comparison = { base: string; target: string; files: ComparisonFile[] };
export type Selection =
  | { kind: "file"; id: string; staged: boolean }
  | { kind: "commit"; id: string }
  | { kind: "changes"; id: "unstaged" | "staged" };
export type HeadTarget = { branch: string | null; head: string | null };
export type Action =
  | { kind: "openEditor"; file: string; editor: EditorCommand }
  | { kind: "mergeTool"; id: string }
  | { kind: "repositoryTool"; action: RepositoryToolAction }
  | { kind: "stage" | "unstage"; id: string }
  | ({ kind: "discard" } & DiscardPlan)
  | { kind: "stageFiles" | "unstageFiles"; ids: string[] }
  | {
      kind:
        | "stageAll"
        | "unstageAll"
        | "fetch"
        | "fetchPrune"
        | "pull"
        | "push"
        | "continueOperation"
        | "skipRebase"
        | "abortOperation";
    }
  | {
      kind: "hunk";
      id: string;
      staged: boolean;
      index: number;
      token: string;
      page?: number;
      lines?: number[];
    }
  | { kind: "resolveConflict"; id: string; token: string; text: string }
  | {
      kind: "commit";
      summary: string;
      description: string;
      sign: boolean;
      amend: HeadTarget | null;
    }
  | { kind: "changeAuthor"; branch: string; head: string; id: string; name: string; email: string }
  | { kind: "publish"; remote: string }
  | { kind: "forcePush"; lease: PushLease }
  | { kind: "createBranch"; name: string; checkout: boolean; start?: string }
  | {
      kind: "createWorktree";
      parent: string;
      name: string;
      mode: WorktreeMode;
      branch: string;
      start: string;
    }
  | { kind: "removeWorktree"; path: string; head: string | null; branch: string | null }
  | { kind: "switchBranch"; name: string; remote: boolean }
  | { kind: "merge" | "rebase"; name: string; remote: boolean; tip: string; target: HeadTarget }
  | { kind: "pullRebase"; target: HeadTarget }
  | {
      kind: "interactiveRebase";
      branch: string;
      head: string;
      base: string;
      fromRoot: boolean;
      steps: RebaseStep[];
    }
  | { kind: "createTag"; name: string; start?: string }
  | { kind: "deleteBranch" | "deleteTag" | "removeRemote"; name: string }
  | {
      kind: "deleteRemoteRef";
      refKind: RemoteRefKind;
      remote: string;
      name: string;
      tip: string;
      destination: string;
    }
  | { kind: "cherryPick" | "revert"; id: string; target: HeadTarget }
  | { kind: "applyStash" | "popStash" | "dropStash"; id: string; tip: string }
  | { kind: "stash"; message: string; includeUntracked: boolean }
  | { kind: "addRemote"; name: string; url: string }
  | {
      kind: "configureCredentialHelper";
      remote: string;
      destination: string;
      helper: CredentialHelper | null;
      token: string;
    }
  | { kind: "saveSettings"; settings: Settings };
