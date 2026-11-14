import { useEffect, useMemo, useState } from "react";
import { errorMessage, type LocalizedMessage } from "../i18n";
import { git, type Diff, type SearchCommit, type Selection } from "../lib/git";
import type { RepositoryState } from "./useRepositoryState";

export function useRepositoryDiff(
  repository: RepositoryState,
  active: boolean,
  diffVisible: boolean,
  foundCommit: SearchCommit | null,
) {
  const { repo, view, workspaceSelection, diffRevision } = repository;
  const [loadedDiff, setLoadedDiff] = useState<{
    key: string;
    selection: string;
    diff: Diff | null;
    error: LocalizedMessage | null;
  } | null>(null);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [diffPage, setDiffPage] = useState({ selection: "", page: 0 });
  const selectionKind = workspaceSelection?.kind;
  const selectionId = workspaceSelection?.id;
  const selectionStaged = workspaceSelection?.kind === "file" && workspaceSelection.staged;
  const selection = useMemo<Selection | null>(() => {
    if (view === "find") return foundCommit ? { kind: "commit", id: foundCommit.id } : null;
    if (!selectionId) return null;
    if (selectionKind === "changes")
      return { kind: "changes", id: selectionId === "staged" ? "staged" : "unstaged" };
    return selectionKind === "file"
      ? { kind: "file", id: selectionId, staged: selectionStaged }
      : { kind: "commit", id: selectionId };
  }, [selectionKind, selectionId, selectionStaged, view, foundCommit]);
  const selectionKey = JSON.stringify([repo.path, selection, ignoreWhitespace]);
  const page = diffPage.selection === selectionKey ? diffPage.page : 0;
  const diffKey = JSON.stringify([selectionKey, page]);
  const currentDiff = loadedDiff?.key === diffKey ? loadedDiff : null;
  const previewDiff =
    currentDiff?.diff ??
    (loadedDiff?.selection === selectionKey && !currentDiff ? loadedDiff.diff : null);
  const file =
    selection?.kind === "file"
      ? repo.status.files.find((candidate) => candidate.id === selection.id)
      : undefined;
  const conflictFile = view === "changes" && file?.conflict && !file.submodule ? file : null;
  const conflictId = conflictFile?.id;
  const mutableRevision =
    selection?.kind === "commit" && !previewDiff?.images?.length ? 0 : diffRevision;
  useEffect(() => {
    if (!active || !diffVisible || !repo.path || !selection || conflictId) return;
    let pending = true;
    git
      .jsonDiff(repo.path, selection, { ignoreWhitespace, page })
      .then((result) => {
        if (!pending) return;
        setLoadedDiff((previous) =>
          previous?.key === diffKey &&
          previous.diff?.text === result.text &&
          previous.diff.truncated === result.truncated &&
          previous.diff.hunkToken === result.hunkToken &&
          !result.images?.length &&
          !previous.diff.images?.length
            ? previous
            : { key: diffKey, selection: selectionKey, diff: result, error: null },
        );
      })
      .catch((error: unknown) => {
        if (pending)
          setLoadedDiff({
            key: diffKey,
            selection: selectionKey,
            diff: null,
            error: errorMessage(error),
          });
      });
    return () => {
      pending = false;
    };
  }, [
    active,
    view,
    diffVisible,
    diffKey,
    mutableRevision,
    repo.path,
    selection,
    selectionKey,
    conflictId,
    ignoreWhitespace,
    page,
  ]);

  return {
    selection,
    selectionKey,
    page,
    setDiffPage,
    currentDiff,
    previewDiff,
    file,
    conflictFile,
    ignoreWhitespace,
    setIgnoreWhitespace,
  };
}
