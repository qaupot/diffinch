import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FindCommits from "./FindCommits";
import { git, type CommitSearch, type SearchCommit } from "./lib/git";
import { deferred, fileChange, snapshot } from "./test/fixtures";

const commit: SearchCommit = {
  id: "abcdef123456",
  shortId: "abcdef1",
  parents: [],
  subject: "Fix [toolbar].*",
  description: "Keep keyboard shortcuts visible",
  author: "Avery Chen",
  email: "avery@example.invalid",
  date: "2026-11-13T11:34:00+09:00",
  references: "main, release/search",
};
const matches: CommitSearch = { commits: [commit], hasMore: false };
const empty: CommitSearch = { commits: [], hasMore: false };

it("opens a blame commit through its initial search query", async () => {
  vi.spyOn(git, "searchCommits").mockResolvedValue(matches);
  const onSelect = vi.fn();
  render(
    <FindCommits
      id="blame-search"
      repo={snapshot()}
      request={0}
      searchInput={createRef<HTMLInputElement>()}
      selected={null}
      onSelect={onSelect}
      initialQuery={commit.id}
    />,
  );
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(git.searchCommits).toHaveBeenCalledWith(snapshot().path, commit.id, "all", false);
  expect(onSelect).toHaveBeenLastCalledWith(commit);
});

function setup(path = "/repository") {
  const repo = snapshot(path);
  repo.commits = [commit];
  repo.branches = [{ name: "main", tip: commit.id, current: true, remote: false, upstream: "" }];
  repo.tags = [{ name: "release/search", tip: commit.id }];
  const props = {
    id: "find",
    repo,
    request: 0,
    searchInput: createRef<HTMLInputElement>(),
    selected: null,
    onSelect: vi.fn(),
  };
  const view = render(<FindCommits {...props} />);
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Find a commit" });
  return { ...view, props, input };
}

async function type(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  await act(() => vi.advanceTimersByTimeAsync(250));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("uses one input to find literal text across every commit field as you type", async () => {
  const { input, props, rerender } = setup("");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.activeElement).toBe(input);
  for (const query of [
    "[toolbar].*",
    "SHORTCUTS",
    "abcdef",
    "Avery",
    "@example",
    "main",
    "release/search",
  ]) {
    await type(input, query);
    expect(screen.getByRole("status").textContent).toBe("1 match");
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: commit.id }));
  }
  rerender(<FindCommits {...props} request={1} />);
  expect(input.value).toBe("release/search");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(screen.getByRole("status").textContent).toBe("1 match");

  await type(input, "avery");
  fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
  await act(() => vi.advanceTimersByTimeAsync(250));
  // The lowercase email still matches when case sensitivity is enabled.
  expect(screen.getByRole("status").textContent).toBe("1 match");
  await type(input, "AVERY");
  expect(screen.getByText("No matching commits")).toBeTruthy();
});

it("debounces rapid typing and always searches all fields", async () => {
  const search = vi.spyOn(git, "searchCommits").mockResolvedValue(matches);
  const { input } = setup();
  fireEvent.change(input, { target: { value: "old" } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  fireEvent.change(input, { target: { value: "toolbar" } });
  await act(() => vi.advanceTimersByTimeAsync(249));
  expect(search).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(search).toHaveBeenCalledExactlyOnceWith("/repository", "toolbar", "all", false);
  expect(screen.getByRole("status").textContent).toBe("1 match");
});

it("waits for an active scan, skips superseded queries, and ignores stale results", async () => {
  const first = deferred<CommitSearch>();
  const latest = deferred<CommitSearch>();
  const search = vi
    .spyOn(git, "searchCommits")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  const { input, props } = setup();
  await type(input, "first");
  await type(input, "skipped");
  await type(input, "latest");
  expect(search).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(matches));
  expect(search).toHaveBeenCalledTimes(2);
  expect(search).toHaveBeenLastCalledWith("/repository", "latest", "all", false);
  expect(props.onSelect).not.toHaveBeenCalledWith(commit);
  expect(screen.queryByText(commit.subject)).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Searching…");
  await act(async () => latest.resolve(empty));
  expect(screen.getByText("No matching commits")).toBeTruthy();
});

it("clears pending searches and ignores their failures", async () => {
  const first = deferred<CommitSearch>();
  const search = vi
    .spyOn(git, "searchCommits")
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(matches);
  const { input, props } = setup();
  await type(input, "first");
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await act(async () => first.reject(new Error("old search failed")));
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Type to search all commit fields.");
  expect(props.onSelect).toHaveBeenLastCalledWith(null);
  await type(input, "new");
  expect(search).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toBe("1 match");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("");
  expect(props.onSelect).toHaveBeenLastCalledWith(null);
});

it("waits for text composition to finish before searching", async () => {
  const search = vi.spyOn(git, "searchCommits").mockResolvedValue(empty);
  const { input } = setup();
  fireEvent.compositionStart(input);
  await type(input, "검색");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(search).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(search).toHaveBeenCalledExactlyOnceWith("/repository", "검색", "all", false);
});

it("discards results after leaving Find", async () => {
  const pending = deferred<CommitSearch>();
  vi.spyOn(git, "searchCommits").mockReturnValue(pending.promise);
  const { input, props, unmount } = setup();
  await type(input, "toolbar");
  unmount();
  props.onSelect.mockClear();
  await act(async () => pending.resolve(matches));
  expect(props.onSelect).not.toHaveBeenCalled();
});

it.each(["head", "current branch", "branch", "tag", "stash"] as const)(
  "refreshes an existing search when the %s changes",
  async (change) => {
    const search = vi
      .spyOn(git, "searchCommits")
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(matches);
    const { input, props, rerender } = setup();
    await type(input, "toolbar");
    expect(screen.getByText("No matching commits")).toBeTruthy();

    const repo = structuredClone(props.repo);
    if (change === "head") repo.status.head = "b".repeat(40);
    if (change === "current branch") repo.status.branch = null;
    if (change === "branch") repo.branches[0].tip = "b".repeat(40);
    if (change === "tag") repo.tags.push({ name: "new-tag", tip: commit.id });
    if (change === "stash")
      repo.stashes.push({ id: "stash@{0}", tip: commit.id, subject: "Saved" });
    rerender(<FindCommits {...props} repo={repo} />);
    await act(() => vi.advanceTimersByTimeAsync(250));

    expect(search).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toBe("1 match");
    expect(props.onSelect).toHaveBeenLastCalledWith(commit);
  },
);

it("keeps search results and selection when only working files change", async () => {
  const search = vi.spyOn(git, "searchCommits").mockResolvedValue(matches);
  const { input, props, rerender } = setup();
  await type(input, "toolbar");
  props.onSelect.mockClear();
  const repo = structuredClone(props.repo);
  repo.status.files = [fileChange("edited")];
  rerender(<FindCommits {...props} repo={repo} />);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(search).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("1 match");
  expect(props.onSelect).not.toHaveBeenCalled();
});
