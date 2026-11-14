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

beforeEach(() => vi.mocked(git.snapshot).mockReset());

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
    await act(async () => {
      b.resolve(snapshot("/b"));
    });
    expect(result.current.activePath).toBeNull();
    await act(async () => {
      a.resolve(snapshot("/a"));
    });
    await waitFor(() => expect(result.current.activePath).toBe("/b"));
    expect(result.current.tabs.map(({ snapshot }) => snapshot.path)).toEqual(["/a", "/b"]);
    expect(git.snapshot).toHaveBeenCalledTimes(2);
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
