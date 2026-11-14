import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LocalizedMessage } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import { readHiddenBranches } from "../lib/branches";
import { git, native, type Snapshot } from "../lib/git";
import { preferences } from "../lib/preferences";
import type { RepositoryTab, SavedSession } from "./types";

const sessionKey = "diffinch.session";

function readSession(): SavedSession {
  if (!native) return { paths: [], activePath: "" };
  try {
    const stored: { paths?: unknown; activePath?: unknown } | null = JSON.parse(
      preferences.getItem(sessionKey) ?? "null",
    );
    if (Array.isArray(stored?.paths)) {
      const paths = [
        ...new Set(
          stored.paths.filter(
            (path): path is string => typeof path === "string" && path.length > 0,
          ),
        ),
      ];
      return { paths, activePath: typeof stored.activePath === "string" ? stored.activePath : "" };
    }
  } catch {
    /* Try the repository saved by earlier versions. */
  }
  const path = preferences.getItem("diffinch.current") ?? "";
  return { paths: path ? [path] : [], activePath: path };
}

function recentRepos(): string[] {
  try {
    const stored: unknown = JSON.parse(preferences.getItem("diffinch.recent") ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
export function useRepositorySession() {
  const [savedSession] = useState(readSession);
  const [{ tabs, activePath }, setSession] = useState<{
    tabs: RepositoryTab[];
    activePath: string | null;
  }>({ tabs: [], activePath: savedSession.paths.length ? null : "" });
  const restoration = useRef<Promise<PromiseSettledResult<Snapshot>[]> | null>(null);
  const [restoreError, setRestoreError] = useState<LocalizedMessage | null>(null);
  const [recents, setRecents] = useState(recentRepos);
  useLayoutEffect(() => {
    if (!native || activePath === null) return;
    preferences.setItem(
      sessionKey,
      JSON.stringify({
        paths: tabs.map((tab) => tab.snapshot.path),
        activePath,
      } satisfies SavedSession),
    );
  }, [activePath, tabs]);

  useEffect(() => {
    if (!savedSession.paths.length) return;
    let cancelled = false;
    restoration.current ??= Promise.allSettled(
      savedSession.paths.map((path) => git.snapshot(path, undefined, readHiddenBranches(path))),
    );
    void restoration.current.then((results) => {
      if (cancelled) return;
      const restored = new Map<string, RepositoryTab>();
      const unavailable: string[] = [];
      let selected = "";
      for (const [index, result] of results.entries()) {
        const savedPath = savedSession.paths[index];
        if (result.status === "rejected") {
          unavailable.push(savedPath);
          continue;
        }
        const snapshot = result.value;
        restored.set(snapshot.path, { snapshot });
        if (savedPath === savedSession.activePath) selected = snapshot.path;
      }
      const tabs = [...restored.values()];
      setSession({ tabs, activePath: selected || tabs[0]?.snapshot.path || "" });
      if (unavailable.length) {
        setRestoreError(
          unavailable.length === 1
            ? { key: "restoreOneFailed", values: { path: unavailable[0] } }
            : { key: "restoreManyFailed", values: { count: unavailable.length } },
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [savedSession]);

  useEffect(() => {
    preferences.setItem("diffinch.recent", JSON.stringify(recents));
  }, [recents]);

  const acceptRepo = useCallback(
    (snapshot: Snapshot, message?: MessageKey, sourcePath?: string) => {
      const opened = { snapshot, message };
      setSession((current) => {
        const isOpen = current.tabs.some((tab) => tab.snapshot.path === snapshot.path);
        return {
          tabs: isOpen
            ? current.tabs.map((tab) => (tab.snapshot.path === snapshot.path ? opened : tab))
            : [...current.tabs, opened],
          activePath:
            sourcePath === undefined || current.activePath === sourcePath
              ? snapshot.path
              : current.activePath || snapshot.path,
        };
      });
      setRecents((current) =>
        [snapshot.path, ...current.filter((path) => path !== snapshot.path)].slice(0, 8),
      );
    },
    [],
  );

  function closeTab(path: string) {
    setSession((current) => {
      const index = current.tabs.findIndex((tab) => tab.snapshot.path === path);
      const tabs = current.tabs.filter((tab) => tab.snapshot.path !== path);
      const next = tabs[index] ?? tabs[index - 1];
      return {
        tabs,
        activePath: current.activePath === path ? (next?.snapshot.path ?? "") : current.activePath,
      };
    });
  }

  function reorderTab(path: string, targetPath: string, side: "before" | "after") {
    setSession((current) => {
      const source = current.tabs.find((tab) => tab.snapshot.path === path);
      if (!source || path === targetPath) return current;
      const tabs = current.tabs.filter((tab) => tab !== source);
      const target = tabs.findIndex((tab) => tab.snapshot.path === targetPath);
      if (target === -1) return current;
      tabs.splice(target + (side === "after" ? 1 : 0), 0, source);
      if (tabs.every((tab, index) => tab === current.tabs[index])) return current;
      return { ...current, tabs };
    });
  }

  function forgetWorktree(path: string) {
    closeTab(path);
    setRecents((current) => current.filter((item) => item !== path));
  }

  return {
    tabs,
    activePath,
    setSession,
    restoreError,
    setRestoreError,
    recents,
    acceptRepo,
    closeTab,
    reorderTab,
    forgetWorktree,
  };
}
