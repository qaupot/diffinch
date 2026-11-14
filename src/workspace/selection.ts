import { staged, unstaged, type Snapshot } from "../lib/git";
import type { FileSelection, View, WorkspaceSelection } from "./types";

export function selectFile(
  id: string,
  staged: boolean,
  ids: ReadonlySet<string> = new Set([id]),
  anchor = id,
): FileSelection {
  return { kind: "file", id, staged, ids, anchor };
}

export function chooseSelection(
  snapshot: Snapshot,
  view: View,
  current: WorkspaceSelection | null,
): WorkspaceSelection | null {
  if (view === "history") {
    if (
      current?.kind === "changes" &&
      snapshot.status.files.some(current.id === "staged" ? staged : unstaged)
    )
      return current;
    if (current?.kind !== "commit") {
      const inIndex = current?.kind === "file" && current.staged;
      if (snapshot.status.files.some(inIndex ? staged : unstaged))
        return { kind: "changes", id: inIndex ? "staged" : "unstaged" };
      if (snapshot.status.files.some(staged)) return { kind: "changes", id: "staged" };
    }
    const id =
      current?.kind === "commit" && snapshot.commits.some((commit) => commit.id === current.id)
        ? current.id
        : (snapshot.commits.find((commit) => commit.id === snapshot.status.head)?.id ??
          snapshot.commits[0]?.id);
    return id ? { kind: "commit", id } : null;
  }
  if (current?.kind === "file") {
    const available = new Set(
      snapshot.status.files.filter(current.staged ? staged : unstaged).map((file) => file.id),
    );
    const ids = new Set([...current.ids].filter((id) => available.has(id)));
    if (ids.size || (!current.ids.size && available.has(current.id))) {
      const id = ids.has(current.id) ? current.id : (ids.values().next().value ?? current.id);
      const anchor = available.has(current.anchor) ? current.anchor : id;
      return ids.size === current.ids.size && anchor === current.anchor
        ? current
        : selectFile(id, current.staged, ids, anchor);
    }
    const selected = snapshot.status.files.find((file) => file.id === current.id);
    if (selected && (staged(selected) || unstaged(selected)))
      return selectFile(selected.id, staged(selected));
  }
  const file = snapshot.status.files.find(unstaged) ?? snapshot.status.files.find(staged);
  return file ? selectFile(file.id, !unstaged(file)) : null;
}
