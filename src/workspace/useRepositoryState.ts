import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { errorMessage } from "../i18n";
import { branchRef, readHiddenBranches, saveHiddenBranches, visibleHistory } from "../lib/branches";
import { git, historyPageSize, type Branch, type RefreshScope } from "../lib/git";
import { chooseSelection } from "./selection";
import type { RepositoryTab, View, WorkspaceNotice, WorkspaceSelection } from "./types";
import type { GitActivity } from "./useGitActivity";
import { useRepositoryWatch } from "./useRepositoryWatch";

export function useRepositoryState({
  tab,
  active,
  restoring,
  pauseRefresh,
  activity,
  setNotice,
}: {
  tab: RepositoryTab;
  active: boolean;
  restoring: boolean;
  pauseRefresh: boolean;
  activity: GitActivity;
  setNotice: (notice: WorkspaceNotice | null) => void;
}) {
  const { inFlight, setBusy } = activity;
  const [repo, setRepo] = useState(tab.snapshot);
  const [hiddenBranches, setHiddenBranches] = useState(() => readHiddenBranches(tab.snapshot.path));
  const graphRepo = useMemo(() => visibleHistory(repo, hiddenBranches), [repo, hiddenBranches]);
  const [view, setView] = useState<View>("changes");
  const viewRef = useRef<View>("changes");
  const [workspaceSelection, setSelection] = useState<WorkspaceSelection | null>(() =>
    chooseSelection(tab.snapshot, "changes", null),
  );
  const [diffRevision, setDiffRevision] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyDepth = useRef(historyPageSize);
  const updateOpenedRepo = useEffectEvent(({ snapshot, message }: RepositoryTab) => {
    if (repo !== snapshot) {
      historyDepth.current = historyPageSize;
      setRepo(snapshot);
      setDiffRevision((revision) => revision + 1);
      setSelection((current) =>
        chooseSelection(visibleHistory(snapshot, hiddenBranches), viewRef.current, current),
      );
    }
    if (message) setNotice({ message: { key: message }, error: false });
  });
  useEffect(() => {
    updateOpenedRepo(tab);
  }, [tab]);

  useEffect(() => {
    if (view === "history")
      setSelection((current) => chooseSelection(graphRepo, "history", current));
  }, [graphRepo, view]);

  const refresh = useCallback(
    async (quiet = false, scope: RefreshScope = "full") => {
      if (!repo.path || inFlight.current) return;
      inFlight.current = true;
      if (!quiet) setBusy(true);
      try {
        const update = scope === "working" ? await git.workingState(repo.path) : null;
        const canReuse =
          update &&
          update.status.head === repo.status.head &&
          update.status.branch === repo.status.branch;
        const snapshot = canReuse
          ? { ...repo, ...update }
          : await git.snapshot(repo.path, historyDepth.current, hiddenBranches);
        setRepo(
          canReuse &&
            JSON.stringify(snapshot.status) === JSON.stringify(repo.status) &&
            snapshot.operation === repo.operation &&
            JSON.stringify(snapshot.pushLease) === JSON.stringify(repo.pushLease)
            ? repo
            : snapshot,
        );
        setSelection((current) =>
          chooseSelection(
            viewRef.current === "history" ? visibleHistory(snapshot, hiddenBranches) : snapshot,
            viewRef.current,
            current,
          ),
        );
        setDiffRevision((revision) => revision + 1);
      } catch (error) {
        if (!quiet) setNotice({ message: errorMessage(error), error: true });
      } finally {
        if (!quiet) setBusy(false);
        inFlight.current = false;
      }
    },
    [repo, hiddenBranches, inFlight, setBusy, setNotice],
  );

  useRepositoryWatch(active, repo.path, (scope) => {
    if (inFlight.current || pauseRefresh) return false;
    void refresh(true, scope);
    return true;
  });
  async function extendHistory(depth: number, hidden = hiddenBranches) {
    if (!repo.path || inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    setLoadingHistory(true);
    try {
      const snapshot = await git.snapshot(repo.path, depth, hidden);
      historyDepth.current = depth;
      setRepo(snapshot);
      setSelection((current) =>
        chooseSelection(visibleHistory(snapshot, hidden), viewRef.current, current),
      );
      return snapshot;
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setLoadingHistory(false);
    }
  }

  async function changeBranchVisibility(items: Branch[], visible: boolean) {
    const next = new Set(hiddenBranches);
    for (const item of items) {
      if (visible) next.delete(branchRef(item));
      else next.add(branchRef(item));
    }
    return updateBranchVisibility([...next]);
  }

  async function updateBranchVisibility(hidden: string[]) {
    if (!repo.path || restoring || inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const snapshot = await git.snapshot(repo.path, historyPageSize, hidden);
      historyDepth.current = historyPageSize;
      setRepo(snapshot);
      setHiddenBranches(hidden);
      saveHiddenBranches(repo.path, hidden);
      const displayed = visibleHistory(snapshot, hidden);
      if (viewRef.current === "history")
        setSelection((current) => chooseSelection(displayed, "history", current));
      return { snapshot: displayed, hidden };
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return {
    repo,
    setRepo,
    hiddenBranches,
    graphRepo,
    view,
    setView,
    viewRef,
    workspaceSelection,
    setSelection,
    diffRevision,
    setDiffRevision,
    loadingHistory,
    historyDepth,
    refresh,
    extendHistory,
    changeBranchVisibility,
    updateBranchVisibility,
  };
}
export type RepositoryState = ReturnType<typeof useRepositoryState>;
