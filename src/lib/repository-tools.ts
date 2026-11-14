export type RepositoryToolKind = "submodules" | "subtrees" | "lfs";
export type Submodule = {
  name: string;
  path: string;
  url: string;
  branch: string;
  expected: string;
  head: string | null;
  dirty: boolean;
  conflict: boolean;
};
export type Subtree = { prefix: string; remote: string; branch: string; squash: boolean };
export type SubtreeOperation = "add" | "pull" | "push" | "split";
export type RepositoryToolState =
  | { kind: "submodules"; items: Submodule[] }
  | { kind: "subtrees"; available: boolean; items: Subtree[] }
  | {
      kind: "lfs";
      available: boolean;
      version: string;
      patterns: string;
      files: { name: string; oid: string; size: number; downloaded: boolean; checkout: boolean }[];
    };
export type RepositoryToolAction =
  | { kind: "addSubmodule"; url: string; path: string; branch: string }
  | { kind: "updateSubmodule"; path: string | null; remote: boolean }
  | { kind: "syncSubmodules" | "lfsInstall" }
  | ({ kind: "subtree"; operation: SubtreeOperation } & Subtree)
  | { kind: "lfsTrack"; pattern: string; untrack: boolean }
  | { kind: "lfsTransfer"; operation: "fetch" | "pull" | "checkout"; remote: string };
