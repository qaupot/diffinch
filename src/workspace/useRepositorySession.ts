import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocalizedMessage } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import { readHiddenBranches } from "../lib/branches";
import { git, native, type Snapshot } from "../lib/git";
import { preferences } from "../lib/preferences";
import type { RepositoryTab, SavedSession } from "./types";

const sessionKey = "diffinch.session";
const backgroundRestoreLimit = 2;

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
  const [{ slots, activePath, failedPaths }, setSession] = useState<{
    slots: { path: string; tab?: RepositoryTab }[];
    activePath: string | null;
    failedPaths: string[];
  }>(() => ({
    slots: savedSession.paths.map((path) => ({ path })),
    activePath: savedSession.paths.length ? null : "",
    failedPaths: [],
  }));
  const tabs = useMemo(() => slots.flatMap(({ tab }) => (tab ? [tab] : [])), [slots]);
  const restoration = useRef(new Map<string, Promise<Snapshot>>());
  const closedDuringRestore = useRef<Set<string> | null>(
    savedSession.paths.length ? new Set() : null,
  );
  const restoreError: LocalizedMessage | null =
    !failedPaths.length || slots.some((slot) => !slot.tab)
      ? null
      : failedPaths.length === 1
        ? { key: "restoreOneFailed", values: { path: failedPaths[0] } }
        : { key: "restoreManyFailed", values: { count: failedPaths.length } };
  const [recents, setRecents] = useState(recentRepos);
  useLayoutEffect(() => {
    if (!native || activePath === null) return;
    preferences.setItem(
      sessionKey,
      JSON.stringify({
        paths: slots.map(({ path }) => path),
        activePath,
      } satisfies SavedSession),
    );
  }, [activePath, slots]);

  useEffect(() => {
    if (!savedSession.paths.length) return;
    let cancelled = false;
    const requests = restoration.current;
    async function restore(path: string) {
      try {
        let request = requests.get(path);
        if (!request) {
          request = git.snapshot(path, undefined, readHiddenBranches(path));
          requests.set(path, request);
        }
        const snapshot = await request;
        if (cancelled) return;
        const closed = closedDuringRestore.current?.has(snapshot.path);
        setSession((current) => {
          if (!current.slots.some((slot) => slot.path === path && !slot.tab)) return current;
          let placed =
            closed || current.slots.some((slot) => slot.tab && slot.path === snapshot.path);
          const slots = current.slots.flatMap((slot) => {
            if (slot.tab || (slot.path !== path && slot.path !== snapshot.path)) return [slot];
            if (placed) return [];
            placed = true;
            return [{ path: snapshot.path, tab: { snapshot } }];
          });
          return {
            ...current,
            slots,
            failedPaths: current.failedPaths.filter((failed) => failed !== snapshot.path),
            activePath: closed ? current.activePath : current.activePath || snapshot.path,
          };
        });
        return true;
      } catch {
        if (cancelled) return;
        setSession((current) => {
          const slots = current.slots.filter((slot) => slot.path !== path || slot.tab);
          if (slots.length === current.slots.length) return current;
          return {
            slots,
            activePath: slots.length ? current.activePath : "",
            failedPaths: [...current.failedPaths, path],
          };
        });
        return false;
      } finally {
        if (!cancelled) requests.delete(path);
      }
    }
    async function restoreSession() {
      const first = savedSession.paths.includes(savedSession.activePath)
        ? savedSession.activePath
        : savedSession.paths[0];
      const ordered = [first, ...savedSession.paths.filter((path) => path !== first)];
      for (const [index, path] of ordered.entries()) {
        const opened = await restore(path);
        if (cancelled) return;
        if (opened) {
          const pending = ordered.slice(index + 1).values();
          async function restoreNext() {
            for (const path of pending) {
              if (cancelled) return;
              await restore(path);
            }
          }
          await Promise.all(Array.from({ length: backgroundRestoreLimit }, restoreNext));
          break;
        }
      }
      if (cancelled) return;
      closedDuringRestore.current = null;
    }
    void restoreSession();
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
      closedDuringRestore.current?.delete(snapshot.path);
      setSession((current) => {
        const slot = { path: snapshot.path, tab: opened };
        const isOpen = current.slots.some((item) => item.path === snapshot.path);
        return {
          failedPaths: current.failedPaths.filter((path) => path !== snapshot.path),
          slots: isOpen
            ? current.slots.map((item) => (item.path === snapshot.path ? slot : item))
            : [...current.slots, slot],
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
    closedDuringRestore.current?.add(path);
    setSession((current) => {
      const slots = current.slots.filter((slot) => slot.path !== path);
      const tabs = current.slots.filter((slot) => slot.tab);
      const index = tabs.findIndex((slot) => slot.path === path);
      const next = tabs[index + 1] ?? tabs[index - 1];
      return {
        ...current,
        slots,
        activePath: current.activePath === path ? (next?.path ?? "") : current.activePath,
      };
    });
  }

  function reorderTab(path: string, targetPath: string, side: "before" | "after") {
    setSession((current) => {
      const source = current.slots.find((tab) => tab.path === path);
      if (!source || path === targetPath) return current;
      const slots = current.slots.filter((tab) => tab !== source);
      const target = slots.findIndex((tab) => tab.path === targetPath);
      if (target === -1) return current;
      slots.splice(target + (side === "after" ? 1 : 0), 0, source);
      if (slots.every((tab, index) => tab === current.slots[index])) return current;
      return { ...current, slots };
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
    dismissRestoreError: () => setSession((current) => ({ ...current, failedPaths: [] })),
    recents,
    acceptRepo,
    closeTab,
    reorderTab,
    forgetWorktree,
  };
}
