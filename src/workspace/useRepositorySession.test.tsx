import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../lib/git";
import { deferred, snapshot } from "../test/fixtures";
import { useRepositorySession } from "./useRepositorySession";

vi.mock("../lib/git", async (original) => ({
  ...(await original<typeof import("../lib/git")>()),
  native: true,
  git: { snapshot: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(git.snapshot).mockReset();
});

describe("repository sessions", () => {
  it("ignores stale reorder targets and closes the neighbor in the reordered list", () => {
    const { result } = renderHook(useRepositorySession);
    act(() => {
      for (const path of ["/a", "/b", "/c"]) result.current.acceptRepo(snapshot(path));
    });
    act(() => {
      result.current.reorderTab("/c", "/a", "before");
      result.current.reorderTab("/missing", "/a", "after");
      result.current.reorderTab("/c", "/missing", "after");
      result.current.reorderTab("/a", "/a", "before");
    });
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(["/c", "/a", "/b"]);
    expect(result.current.activePath).toBe("/c");
    act(() => result.current.closeTab("/c"));
    expect(result.current.activePath).toBe("/a");
  });

  it("restores once in Strict Mode, preserving order when requests finish out of order", async () => {
    localStorage.setItem(
      "diffinch.session",
      JSON.stringify({ paths: ["/a", "/b", "/a"], activePath: "/b" }),
    );
    const a = deferred<ReturnType<typeof snapshot>>();
    const b = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(git.snapshot).mockImplementation((path) => (path === "/a" ? a.promise : b.promise));
    const { result } = renderHook(useRepositorySession, {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    expect(result.current.activePath).toBeNull();
    expect(vi.mocked(git.snapshot).mock.calls.map(([path]) => path)).toEqual(["/b"]);
    await act(async () => {
      b.resolve(snapshot("/b"));
    });
    expect(result.current.activePath).toBe("/b");
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(["/b"]);
    expect(JSON.parse(localStorage.getItem("diffinch.session")!).paths).toEqual(["/a", "/b"]);
    await act(async () => {
      a.resolve(snapshot("/a"));
    });
    await waitFor(() => expect(result.current.activePath).toBe("/b"));
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(["/a", "/b"]);
    expect(git.snapshot).toHaveBeenCalledTimes(2);
  });

  it("preserves tab edits made while a background restore is pending", async () => {
    localStorage.setItem(
      "diffinch.session",
      JSON.stringify({ paths: ["/a", "/b", "/c"], activePath: "/a" }),
    );
    const pending = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(git.snapshot).mockImplementation(async (path) =>
      path === "/c" ? pending.promise : snapshot(path),
    );
    const { result } = renderHook(useRepositorySession);
    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    act(() => {
      result.current.acceptRepo(snapshot("/new"));
      result.current.closeTab("/a");
      result.current.reorderTab("/new", "/b", "before");
    });
    await act(async () => pending.resolve(snapshot("/c")));
    expect(result.current.activePath).toBe("/new");
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(["/new", "/b", "/c"]);
  });

  it("opens the active tab first and limits concurrent background restores", async () => {
    const paths = ["/a", "/b", "/c", "/d", "/e"];
    localStorage.setItem("diffinch.session", JSON.stringify({ paths, activePath: "/e" }));
    const requests = paths.map(() => deferred<ReturnType<typeof snapshot>>());
    vi.mocked(git.snapshot).mockImplementation((path) => requests[paths.indexOf(path)].promise);
    const { result } = renderHook(useRepositorySession);
    expect(git.snapshot).toHaveBeenCalledTimes(1);
    await act(async () => requests[4].resolve(snapshot("/e")));
    expect(result.current.activePath).toBe("/e");
    expect(vi.mocked(git.snapshot).mock.calls.map(([path]) => path)).toEqual(["/e", "/a", "/b"]);
    await act(async () => requests[1].resolve(snapshot("/b")));
    expect(git.snapshot).toHaveBeenCalledTimes(4);
    await act(async () => requests[2].resolve(snapshot("/c")));
    expect(git.snapshot).toHaveBeenCalledTimes(5);
    await act(async () => {
      requests[0].resolve(snapshot("/a"));
      requests[3].resolve(snapshot("/d"));
    });
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(paths);
  });

  it("ignores a failed restore if the user has since opened that tab", async () => {
    localStorage.setItem(
      "diffinch.session",
      JSON.stringify({ paths: ["/a", "/b"], activePath: "/a" }),
    );
    const pending = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(git.snapshot).mockImplementation(async (path) =>
      path === "/a" ? snapshot(path) : pending.promise,
    );
    const { result } = renderHook(useRepositorySession);
    await waitFor(() => expect(git.snapshot).toHaveBeenCalledTimes(2));
    act(() => result.current.acceptRepo(snapshot("/b")));
    await act(async () => pending.reject(new Error("unavailable")));
    expect(result.current.activePath).toBe("/b");
    expect(result.current.restoreError).toBeNull();
  });

  it("keeps a tab closed when a saved alias resolves to the same repository", async () => {
    localStorage.setItem(
      "diffinch.session",
      JSON.stringify({ paths: ["/a", "/alias"], activePath: "/a" }),
    );
    const alias = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(git.snapshot).mockImplementation(async (path) =>
      path === "/a" ? snapshot(path) : alias.promise,
    );
    const { result } = renderHook(useRepositorySession);
    await waitFor(() => expect(result.current.activePath).toBe("/a"));
    act(() => result.current.closeTab("/a"));
    await act(async () => alias.resolve(snapshot("/a")));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activePath).toBe("");
    expect(JSON.parse(localStorage.getItem("diffinch.session")!).paths).toEqual([]);
  });

  it("keeps available tabs and reports a missing saved repository", async () => {
    localStorage.setItem(
      "diffinch.session",
      JSON.stringify({ paths: ["/missing", "/ok"], activePath: "/missing" }),
    );
    vi.mocked(git.snapshot).mockImplementation(async (path) => {
      if (path === "/missing") throw { key: "gitIoFailed" };
      return snapshot(path);
    });
    const { result } = renderHook(useRepositorySession);
    await waitFor(() => expect(result.current.activePath).toBe("/ok"));
    expect(result.current.restoreError).toEqual({
      key: "restoreOneFailed",
      values: { path: "/missing" },
    });
  });

  it("does not steal focus when a background open finishes after the user changes tabs", () => {
    const { result } = renderHook(useRepositorySession);
    act(() => {
      result.current.acceptRepo(snapshot("/a"));
    });
    act(() => {
      result.current.acceptRepo(snapshot("/b"));
    });
    act(() => {
      result.current.acceptRepo(snapshot("/cloned"), undefined, "/a");
    });
    expect(result.current.activePath).toBe("/b");
    act(() => result.current.closeTab("/b"));
    expect(result.current.activePath).toBe("/cloned");
    expect(JSON.parse(localStorage.getItem("diffinch.session")!)).toEqual({
      paths: ["/a", "/cloned"],
      activePath: "/cloned",
    });
  });
});
