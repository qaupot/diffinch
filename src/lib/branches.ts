import type { Branch, Snapshot } from "./git";
import { preferences } from "./preferences";

export const branchRef = (branch: Branch) =>
  `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;
const preferenceKey = (path: string) => `diffinch.branches:${path || "example"}`;

export function readHiddenBranches(path: string): string[] {
  try {
    const value: unknown = JSON.parse(preferences.getItem(preferenceKey(path)) ?? "[]");
    return Array.isArray(value)
      ? value.filter((ref): ref is string => typeof ref === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveHiddenBranches(path: string, hidden: readonly string[]) {
  preferences.setItem(preferenceKey(path), JSON.stringify(hidden));
}

export type BranchFolder = {
  name: string;
  path: string;
  folders: BranchFolder[];
  branches: Branch[];
};

export function branchTree(
  branches: readonly Branch[],
  remoteNames: readonly string[] = [],
): BranchFolder {
  const root: BranchFolder = { name: "", path: "", folders: [], branches: [] };
  const remotePrefixes = [...remoteNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => `${name}/`);
  for (const branch of [...branches].sort((a, b) => a.name.localeCompare(b.name))) {
    const remotePrefix = remotePrefixes.find((prefix) => branch.name.startsWith(prefix));
    const folders = remotePrefix
      ? [
          remotePrefix.slice(0, -1),
          ...branch.name.slice(remotePrefix.length).split("/").slice(0, -1),
        ]
      : branch.name.split("/").slice(0, -1);
    let parent = root;
    for (const name of folders) {
      let folder = parent.folders.find((child) => child.name === name);
      if (!folder) {
        folder = {
          name,
          path: parent.path ? `${parent.path}/${name}` : name,
          folders: [],
          branches: [],
        };
        parent.folders.push(folder);
      }
      parent = folder;
    }
    parent.branches.push(branch);
  }
  return root;
}

export function folderBranches(folder: BranchFolder): Branch[] {
  return [...folder.branches, ...folder.folders.flatMap(folderBranches)];
}

// Native history is filtered by Git before pagination. The example uses the same
// reachability rule over its complete in-memory history.
export function visibleHistory(repo: Snapshot, hidden: readonly string[]): Snapshot {
  const excluded = new Set(hidden);
  const branches = repo.branches.filter((branch) => !excluded.has(branchRef(branch)));
  if (repo.path) return { ...repo, branches };
  const pending = [
    ...branches.map((branch) => branch.tip),
    ...repo.tags.map((tag) => tag.tip),
    ...repo.stashes.map((stash) => stash.tip),
  ];
  if (!repo.status.branch && repo.status.head) pending.push(repo.status.head);
  const reachable = reachableCommits(repo.commits, pending);
  return {
    ...repo,
    branches,
    commits: repo.commits.filter(({ id }) => reachable.has(id)),
    hasOlderCommits: false,
  };
}

export function reachableCommits(commits: Snapshot["commits"], pending: string[]): Set<string> {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(byId.get(id)?.parents ?? []));
  }
  return reachable;
}
