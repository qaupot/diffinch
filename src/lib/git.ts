import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalizedMessage } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import type {
  Action,
  AuthorPlan,
  CommitSearch,
  Comparison,
  Conflict,
  CredentialAccount,
  CredentialAccountRequest,
  CredentialTarget,
  CredentialUpdate,
  Diff,
  DiffOptions,
  DiscardPlan,
  FileChange,
  FileInspectionRequest,
  FileInspectionResult,
  RebasePlan,
  RefreshScope,
  RemoteRefKind,
  RemoteRefs,
  SearchField,
  Selection,
  Snapshot,
  WorkingState,
} from "./git-types";
import type { RepositoryToolKind, RepositoryToolState } from "./repository-tools";

export type * from "./git-types";
export const maxDiffPage = 3;

export const native = "__TAURI_INTERNALS__" in window;
export const mac = /Mac/.test(navigator.platform);
export const shortcut = mac ? "⌘" : "Ctrl+";
export const historyPageSize = 160;
export const historyLimit = 2000;

export const staged = (file: FileChange) => file.index !== "." && !file.conflict;
export const unstaged = (file: FileChange) => file.worktree !== "." || file.conflict;
export const basename = (path: string) => path.split("/").at(-1) ?? path;
export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function desktop<T>(command: string, args?: Record<string, unknown>) {
  if (!native) return Promise.reject({ key: "desktopRequired" } satisfies LocalizedMessage);
  return invoke<T>(command, args);
}

export const git = {
  credentialTargets: (path: string, remote: string) =>
    desktop<CredentialTarget[]>("credential_targets", { path, remote }),
  credentialAccount: (path: string, request: CredentialAccountRequest) =>
    desktop<CredentialAccount>("credential_account", { path, request }),
  updateCredentials: (path: string, update: CredentialUpdate) =>
    desktop<MessageKey>("update_credentials", { path, update }),
  repositoryTools: (path: string, kind: RepositoryToolKind) =>
    desktop<RepositoryToolState>("repository_tools", { path, kind }),
  chooseFolder: (title: string) => desktop<string | null>("choose_folder", { title }),
  snapshot: (path: string, limit?: number, hiddenBranches: readonly string[] = []) =>
    desktop<Snapshot>("snapshot", { path, historyLimit: limit, hiddenBranches }),
  searchCommits: (path: string, query: string, field: SearchField, caseSensitive: boolean) =>
    desktop<CommitSearch>("search_commits", { path, query, field, caseSensitive }),
  workingState: (path: string) => desktop<WorkingState>("working_state", { path }),
  watch: (path: string, id: string, onChange: (scope: RefreshScope) => void) =>
    desktop<void>("watch_repository", { path, id, changes: new Channel(onChange) }),
  unwatch: (id: string) => desktop<void>("unwatch_repository", { id }),
  init: (path: string) => desktop<Snapshot>("init_repository", { path }),
  clone: (
    url: string,
    parent: string,
    name: string,
    id: string,
    progress: (percent: number) => void,
  ) =>
    desktop<Snapshot>("clone_repository", {
      url,
      parent,
      name,
      id,
      progress: new Channel(progress),
    }),
  fetch: (path: string, prune: boolean, id: string, progress: (percent: number) => void) =>
    desktop<MessageKey>("fetch_repository", { path, prune, id, progress: new Channel(progress) }),
  cancelTransfer: (id: string) => desktop<void>("cancel_transfer", { id }),
  commitMessage: (path: string, id: string) => desktop<string>("commit_message", { path, id }),
  authorPlan: (path: string, id: string) => desktop<AuthorPlan>("author_plan", { path, id }),
  rebasePlan: (path: string, base: string, fromRoot: boolean) =>
    desktop<RebasePlan>("rebase_plan", { path, base, fromRoot }),
  remoteRefs: (path: string, remote: string, kind: RemoteRefKind) =>
    desktop<RemoteRefs>("remote_refs", { path, remote, kind }),
  conflict: (path: string, id: string) => desktop<Conflict>("conflict", { path, id }),
  discardPlan: (path: string, id: string) => desktop<DiscardPlan>("discard_plan", { path, id }),
  compare: (path: string, base: string, target: string, fromMergeBase: boolean) =>
    desktop<Comparison>("compare", { path, base, target, fromMergeBase }),
  compareFile: (path: string, comparison: Comparison, id: string, options: DiffOptions) =>
    desktop<Diff>("compare_file", {
      path,
      base: comparison.base,
      target: comparison.target,
      id,
      options,
    }),
  jsonDiff: (path: string, selection: Selection, options: DiffOptions) =>
    selection.kind === "file"
      ? desktop<Diff>("file_diff", { path, id: selection.id, staged: selection.staged, options })
      : selection.kind === "changes"
        ? desktop<Diff>("changes_diff", { path, staged: selection.id === "staged", options })
        : desktop<Diff>("commit_diff", { path, id: selection.id, options }),
  inspectFile: (
    path: string,
    request: FileInspectionRequest,
    id: string,
    progress: (percent: number) => void,
  ) =>
    desktop<FileInspectionResult>("inspect_file", {
      path,
      request,
      id,
      progress: new Channel(progress),
    }),
  action: (
    path: string,
    action: Action,
    id: string = crypto.randomUUID(),
    progress: (percent: number) => void = () => {},
  ) =>
    desktop<MessageKey>("git_action", {
      path,
      request: { action, id },
      progress: new Channel(progress),
    }),
};
