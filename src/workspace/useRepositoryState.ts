import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  const [view, displayView] = useState<View>("changes");
  const viewRef = useRef<View>("changes");
  const navigation = useRef(0);
  function setView(next: View) {
    navigation.current++;
    viewRef.current = next;
    displayView(next);
  }
  useLayoutEffect(() => {
    if (!active) navigation.current++;
  }, [active]);
  const [workspaceSelection, setSelection] = useState<WorkspaceSelection | null>(() =>
    chooseSelection(tab.snapshot, "changes", null),
  );
  const [diffRevision, setDiffRevision] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyDepth = useRef(historyPageSize);
  const openedTab = useRef<RepositoryTab | null>(tab);
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
  useLayoutEffect(() => {
    openedTab.current = tab;
    updateOpenedRepo(tab);
    return () => {
      openedTab.current = null;
    };
  }, [tab]);

  useEffect(() => {
    if (view === "history")
      setSelection((current) => chooseSelection(graphRepo, "history", current));
  }, [graphRepo, view]);

  const loadSnapshot = useCallback(
    async (scope: RefreshScope = "full") => {
      // A tab can be reopened from another workspace while Git is running.
      // Apply the refresh against the latest open, including after a mutation.
      while (openedTab.current) {
        const opened = openedTab.current;
        const base = tab === opened ? repo : opened.snapshot;
        try {
          if (scope === "working") {
            const update = await git.workingState(base.path);
            if (opened !== openedTab.current) continue;
            if (
              update.status.head === base.status.head &&
              update.status.branch === base.status.branch
            ) {
              return JSON.stringify(update.status) === JSON.stringify(base.status) &&
                update.operation === base.operation &&
                JSON.stringify(update.pushLease) === JSON.stringify(base.pushLease)
                ? base
                : { ...base, ...update };
            }
          }
          const snapshot = await git.snapshot(base.path, historyDepth.current, hiddenBranches);
          if (opened === openedTab.current) return snapshot;
        } catch (error) {
          if (opened === openedTab.current) throw error;
        }
      }
      return null;
    },
    [tab, repo, hiddenBranches],
  );

  const refresh = useCallback(
    async (quiet = false, scope: RefreshScope = "full") => {
      if (!repo.path || inFlight.current) return;
      inFlight.current = true;
      if (!quiet) setBusy(true);
      try {
        const snapshot = await loadSnapshot(scope);
        if (!snapshot) return;
        setRepo(snapshot);
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
    [repo.path, loadSnapshot, hiddenBranches, inFlight, setBusy, setNotice],
  );

  useRepositoryWatch(active, repo.path, (scope) => {
    if (inFlight.current || pauseRefresh) return false;
    void refresh(true, scope);
    return true;
  });
  async function extendHistory(depth: number, base = repo, target?: string) {
    if (!repo.path || inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    setLoadingHistory(true);
    const visit = navigation.current;
    const current = () => openedTab.current === tab && (!target || visit === navigation.current);
    try {
      let snapshot = base;
      while (snapshot.historyCursor && snapshot.commits.length < depth) {
        const offset = snapshot.commits.length;
        const cursor = snapshot.historyCursor;
        const page = await git.historyPage(base.path, {
          roots: cursor.roots,
          offset,
          limit: Math.min(historyPageSize, depth - offset),
        });
        if (!current()) return null;
        if (page.commits[0]?.id !== cursor.next) {
          // A fetch can deepen a shallow clone without moving its pinned tips.
          snapshot = await git.snapshot(base.path, depth, hiddenBranches);
          if (!current()) return null;
          historyDepth.current = depth;
          setRepo(snapshot);
          return snapshot;
        }
        snapshot = {
          ...snapshot,
          commits: [...snapshot.commits, ...page.commits],
          hasOlderCommits: page.nextCommit !== null,
          historyCursor: page.nextCommit ? { roots: cursor.roots, next: page.nextCommit } : null,
        };
        historyDepth.current = snapshot.commits.length;
        setRepo(snapshot);
        if (target && page.commits.some((commit) => commit.id === target)) break;
      }
      return snapshot;
    } catch (error) {
      if (current()) setNotice({ message: errorMessage(error), error: true });
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
      if (openedTab.current !== tab) return null;
      historyDepth.current = historyPageSize;
      setRepo(snapshot);
      setHiddenBranches(hidden);
      saveHiddenBranches(repo.path, hidden);
      const displayed = visibleHistory(snapshot, hidden);
      if (viewRef.current === "history")
        setSelection((current) => chooseSelection(displayed, "history", current));
      return { snapshot, hidden };
    } catch (error) {
      if (openedTab.current === tab) setNotice({ message: errorMessage(error), error: true });
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
    navigation,
    viewRef,
    workspaceSelection,
    setSelection,
    diffRevision,
    setDiffRevision,
    loadingHistory,
    historyDepth,
    loadSnapshot,
    refresh,
    extendHistory,
    changeBranchVisibility,
    updateBranchVisibility,
  };
}
export type RepositoryState = ReturnType<typeof useRepositoryState>;
