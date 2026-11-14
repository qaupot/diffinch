import type { LocalizedMessage } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import type { Action, Selection, Snapshot } from "../lib/git";

export type View =
  | "fileHistory"
  | "submodules"
  | "subtrees"
  | "lfs"
  | "find"
  | "changes"
  | "history"
  | "compare"
  | "branches"
  | "worktrees"
  | "stashes"
  | "tags"
  | "remotes";
export type ActionModal =
  | "clone"
  | "branch"
  | "worktree"
  | "stash"
  | "tag"
  | "remote"
  | "publish"
  | "settings"
  | "confirm"
  | "rebase";
export type Modal =
  ActionModal | "manual" | "interactiveRebase" | "changeAuthor" | "deleteRemoteRef" | "credentials";
export type Values = Record<string, string | boolean>;
export type Confirm = {
  title: MessageKey | LocalizedMessage;
  message: LocalizedMessage;
  label: MessageKey;
  action: Action;
  destructive?: boolean;
};
export type RepositoryTab = { snapshot: Snapshot; message?: MessageKey };
export type SavedSession = { paths: string[]; activePath: string };
export type Theme = "blue" | "white" | "dark";
export type FileSelection = Extract<Selection, { kind: "file" }> & {
  ids: ReadonlySet<string>;
  anchor: string;
};
export type WorkspaceSelection = FileSelection | Exclude<Selection, { kind: "file" }>;
export type WorkspaceNotice = { message: LocalizedMessage; error: boolean };

export type WorkspaceMenu = "repo" | "branch" | "git" | "find" | "fileTools" | null;
