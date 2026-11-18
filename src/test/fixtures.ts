import type { FileChange, Snapshot } from "../lib/git-types";

export function fileChange(id: string, index = ".", worktree = "M"): FileChange {
  return {
    id,
    path: `${id}.txt`,
    originalPath: null,
    index,
    worktree,
    conflict: false,
    submodule: false,
  };
}

export function snapshot(path = "/repository"): Snapshot {
  return {
    path,
    name: "repository",
    status: {
      branch: "main",
      upstream: null,
      head: "a".repeat(40),
      ahead: 0,
      behind: 0,
      files: [],
    },
    branches: [],
    worktrees: [],
    commits: [],
    historyCursor: null,
    hasOlderCommits: false,
    stashes: [],
    tags: [],
    remotes: [],
    operation: null,
    pushLease: null,
    settings: {
      name: "Test",
      email: "test@example.invalid",
      signCommits: false,
      signingFormat: "openpgp",
      signingKey: "",
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
