import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { MessageKey } from "../i18n/messages";
import { git, type Action, type DiscardPlan, type Snapshot } from "../lib/git";
import { deferred, fileChange, snapshot } from "../test/fixtures";
import { useCommitDraft } from "./CommitComposer";
import type { WorkspaceNotice } from "./types";
import { useGitActivity } from "./useGitActivity";
import { useGitOperations } from "./useGitOperations";
import { useRepositoryState } from "./useRepositoryState";
import { useWorkspaceDialogs } from "./useWorkspaceDialogs";

vi.mock("../lib/git", async (original) => ({
  ...(await original<typeof import("../lib/git")>()),
  git: {
    action: vi.fn(),
    snapshot: vi.fn(),
    workingState: vi.fn(),
    historyPage: vi.fn(),
    watch: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    discardPlan: vi.fn(),
    cancelTransfer: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  vi.mocked(git.action).mockReset();
  vi.mocked(git.fetch).mockReset();
  vi.mocked(git.discardPlan).mockReset();
  vi.mocked(git.snapshot).mockResolvedValue(snapshot());
});

function setup(initial: Snapshot = snapshot()) {
  return renderHook(
    ({ tab, active }) => {
      const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
      const activity = useGitActivity(false, setNotice);
      const dialogs = useWorkspaceDialogs(() => {});
      const draft = useCommitDraft(false);
      const repository = useRepositoryState({
        tab,
        active,
        restoring: false,
        pauseRefresh: false,
        activity,
        setNotice,
      });
      const operations = useGitOperations({
        repository,
        activity,
        dialogs,
        draft,
        restoring: false,
        acceptRepo: vi.fn(),
        forgetWorktree: vi.fn(),
        closeMenu: vi.fn(),
        onConflict: vi.fn(),
        setNotice,
      });
      return { draft, activity, operations, notice, dialogs, repository };
    },
    { initialProps: { tab: { snapshot: initial }, active: false } },
  );
}

const commit: Action = {
  kind: "commit",
  summary: "A summary",
  description: "A body",
  sign: false,
  amend: null,
};

it.each<Action>([
  { kind: "stage", id: "x" },
  { kind: "unstage", id: "x" },
  { kind: "stageFiles", ids: ["x"] },
  { kind: "unstageFiles", ids: ["x"] },
  { kind: "stageAll" },
  { kind: "unstageAll" },
  { kind: "hunk", id: "x", staged: false, index: 0, token: "token", page: 0 },
])("refreshes the index after $kind while reusing loaded history", async (action) => {
  const initial = snapshot();
  const update = {
    status: { ...initial.status, files: [fileChange("notes", "M", ".")] },
    operation: null,
    pushLease: null,
  };
  vi.mocked(git.snapshot).mockClear();
  vi.mocked(git.workingState).mockResolvedValue(update);
  vi.mocked(git.action).mockResolvedValue("fileStaged");
  const { result } = setup(initial);
  await act(() => result.current.operations.action(action));
  expect(git.snapshot).not.toHaveBeenCalled();
  expect(result.current.repository.repo.status).toEqual(update.status);
  expect(result.current.repository.repo.commits).toBe(initial.commits);
});

it("reloads history after staging if HEAD moved externally", async () => {
  const initial = snapshot(),
    moved = snapshot();
  moved.status.head = "b".repeat(40);
  vi.mocked(git.workingState).mockResolvedValue(moved);
  vi.mocked(git.snapshot).mockClear().mockResolvedValue(moved);
  vi.mocked(git.action).mockResolvedValue("fileStaged");
  const { result } = setup(initial);
  await act(() => result.current.operations.action({ kind: "stageAll" }));
  expect(git.snapshot).toHaveBeenCalledOnce();
  expect(result.current.repository.repo).toBe(moved);
});

it("appends an older page without refreshing metadata or replacing loaded commits", async () => {
  const initial = snapshot();
  const head = {
    id: initial.status.head!,
    shortId: "aaaa",
    parents: [],
    author: "A",
    email: "a@b",
    subject: "New",
    date: "",
  };
  const older = { ...head, id: "b".repeat(40), subject: "Old" };
  initial.commits = [head];
  initial.historyCursor = { roots: [head.id], next: older.id };
  initial.hasOlderCommits = true;
  vi.mocked(git.snapshot).mockClear();
  vi.mocked(git.historyPage).mockResolvedValue({ commits: [older], nextCommit: null });
  const { result } = setup(initial);
  await act(async () => {
    await result.current.repository.extendHistory(161);
  });
  expect(git.historyPage).toHaveBeenCalledWith(initial.path, {
    roots: [head.id],
    offset: 1,
    limit: 160,
  });
  expect(git.snapshot).not.toHaveBeenCalled();
  expect(result.current.repository.repo.commits).toEqual([head, older]);
  expect(result.current.repository.repo.commits[0]).toBe(head);
  expect(result.current.repository.repo.branches).toBe(initial.branches);
  expect(result.current.repository.repo.hasOlderCommits).toBe(false);
});

it("reloads the requested depth when the next history page starts at a different commit", async () => {
  const initial = snapshot();
  initial.hasOlderCommits = true;
  initial.historyCursor = { roots: [initial.status.head!], next: "expected" };
  const shifted = {
    id: "different",
    shortId: "diff",
    parents: [],
    subject: "Older history",
    author: "A",
    email: "",
    date: "",
  };
  vi.mocked(git.historyPage)
    .mockReset()
    .mockResolvedValue({ commits: [shifted], nextCommit: null });
  const fresh = { ...snapshot(), commits: [shifted] };
  vi.mocked(git.snapshot).mockClear().mockResolvedValue(fresh);
  const { result } = setup(initial);
  await act(async () => {
    expect(await result.current.repository.extendHistory(320)).toBe(fresh);
  });
  expect(git.snapshot).toHaveBeenCalledExactlyOnceWith(initial.path, 320, []);
  expect(result.current.repository.repo).toBe(fresh);
});

it("refreshes the reopened tab when an earlier working-state read finishes after staging", async () => {
  const initial = snapshot();
  const reopened = {
    ...initial,
    name: "reopened",
    tags: [{ name: "new-tag", tip: initial.status.head! }],
  };
  const oldRead = deferred<Snapshot>();
  vi.mocked(git.workingState)
    .mockReset()
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValueOnce({
      ...reopened,
      status: { ...reopened.status, files: [fileChange("staged", "M", ".")] },
    });
  vi.mocked(git.action).mockResolvedValue("fileStaged");
  const { result, rerender } = setup(initial);
  let staging!: Promise<void>;
  await act(async () => {
    staging = result.current.operations.action({ kind: "stageAll" });
  });
  expect(git.workingState).toHaveBeenCalledOnce();
  rerender({ tab: { snapshot: reopened }, active: false });
  await act(async () => {
    oldRead.resolve(initial);
    await staging;
  });
  expect(result.current.repository.repo.tags).toBe(reopened.tags);
  expect(result.current.repository.repo.status.files[0].id).toBe("staged");
  expect(git.workingState).toHaveBeenCalledTimes(2);
  expect(git.action).toHaveBeenCalledOnce();
});

it.each(["leave", "return", "switch tabs", "close", "reopen"])(
  "stops a commit jump after %s while its page is loading",
  async (change) => {
    const initial = {
      ...snapshot(),
      hasOlderCommits: true,
      historyCursor: { roots: ["head"], next: "older" },
    };
    const page = deferred<Awaited<ReturnType<typeof git.historyPage>>>();
    vi.mocked(git.historyPage).mockReset().mockReturnValueOnce(page.promise);
    const { result, rerender, unmount } = setup(initial);
    const tab = { snapshot: initial };
    if (change === "switch tabs") rerender({ tab, active: true });
    let jump!: Promise<Snapshot | null>;
    act(() => {
      result.current.repository.setView("history");
      jump = result.current.repository.extendHistory(2000, initial, "target");
    });
    if (change === "leave" || change === "return")
      act(() => result.current.repository.setView("changes"));
    if (change === "return") act(() => result.current.repository.setView("history"));
    if (change === "switch tabs") rerender({ tab, active: false });
    if (change === "close") unmount();
    if (change === "reopen") rerender({ tab: { snapshot: snapshot() }, active: false });
    await act(async () => {
      page.resolve({ commits: [], nextCommit: null });
      expect(await jump).toBeNull();
    });
    expect(git.historyPage).toHaveBeenCalledOnce();
  },
);

it("captures the discard token before confirmation and keeps it after a refresh", async () => {
  const initial = snapshot();
  const file = fileChange("notes");
  initial.status.files = [file];
  const pending = deferred<DiscardPlan>();
  vi.mocked(git.discardPlan).mockReturnValue(pending.promise);
  vi.mocked(git.action).mockRejectedValue({ key: "staleDiscard" });
  const { result } = setup(initial);
  let preparation!: Promise<void>;
  act(() => {
    preparation = result.current.operations.confirmDiscard(file);
  });
  expect(result.current.activity.busy).toBe(true);
  expect(result.current.dialogs.modal).toBeNull();
  expect(git.action).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ id: file.id, token: "reviewed-state" });
    await preparation;
  });
  expect(git.discardPlan).toHaveBeenCalledWith(initial.path, file.id);
  expect(result.current.dialogs.modal).toBe("confirm");
  expect(result.current.activity.busy).toBe(false);
  act(() => result.current.repository.setRepo({ ...initial }));
  const confirmed = result.current.dialogs.confirm!.action;
  expect(confirmed).toEqual({ kind: "discard", id: file.id, token: "reviewed-state" });
  await act(() => result.current.operations.action(confirmed, true));
  expect(git.action).toHaveBeenCalledWith(
    initial.path,
    confirmed,
    expect.any(String),
    expect.any(Function),
  );
  expect(git.discardPlan).toHaveBeenCalledTimes(1);
  expect(result.current.dialogs.modalError?.key).toBe("staleDiscard");
  expect(result.current.dialogs.modal).toBe("confirm");
});

it("does not offer discard when its state cannot be captured", async () => {
  vi.mocked(git.discardPlan).mockRejectedValue({ key: "changeMissing" });
  const { result } = setup();
  await act(() => result.current.operations.confirmDiscard(fileChange("notes")));
  expect(result.current.dialogs.modal).toBeNull();
  expect(result.current.notice?.message.key).toBe("changeMissing");
  expect(result.current.activity.busy).toBe(false);
  expect(git.action).not.toHaveBeenCalled();
});

it("keeps a draft during a delayed commit and clears it only after success", async () => {
  const pending = deferred<MessageKey>();
  vi.mocked(git.action).mockReturnValue(pending.promise);
  const { result } = setup();
  act(() => {
    result.current.draft.setSummary(commit.summary);
    result.current.draft.setDescription(commit.description);
  });
  let operation!: Promise<void>;
  act(() => {
    operation = result.current.operations.action(commit);
  });
  expect(result.current.activity.busy).toBe(true);
  expect(result.current.draft.summary).toBe(commit.summary);
  await act(async () => {
    pending.resolve("commitCreated");
    await operation;
  });
  expect(result.current.draft.summary).toBe("");
  expect(result.current.draft.description).toBe("");
  expect(result.current.activity.busy).toBe(false);
});

it("preserves the draft when a hook or signing operation rejects the commit", async () => {
  vi.mocked(git.action).mockRejectedValue({ key: "gitOutput", detail: "Hook rejected commit" });
  const { result } = setup();
  act(() => {
    result.current.draft.setSummary(commit.summary);
    result.current.draft.setDescription(commit.description);
  });
  await act(() => result.current.operations.action(commit));
  expect(result.current.draft.summary).toBe(commit.summary);
  expect(result.current.draft.description).toBe(commit.description);
  expect(result.current.notice?.error).toBe(true);
  expect(result.current.activity.busy).toBe(false);
});

it("cancels a long commit, preserves its draft, and refreshes without retrying", async () => {
  const pending = deferred<MessageKey>();
  vi.mocked(git.action).mockImplementation((_path, _action, _id, progress) => {
    progress?.(0);
    return pending.promise;
  });
  const { result } = setup();
  act(() => result.current.draft.setSummary("Keep this draft"));
  let operation!: Promise<void>;
  act(() => {
    operation = result.current.operations.action(commit);
  });
  expect(result.current.activity.transfer?.ready).toBe(true);
  act(() => result.current.activity.cancelTransfer());
  expect(git.cancelTransfer).toHaveBeenCalledWith(result.current.activity.transfer?.id);
  await act(async () => {
    pending.reject({ key: "operationInterrupted" });
    await operation;
  });
  expect(result.current.draft.summary).toBe("Keep this draft");
  expect(result.current.activity.busy).toBe(false);
  expect(result.current.notice?.message.key).toBe("operationInterrupted");
  expect(git.snapshot).toHaveBeenCalled();
  expect(git.action).toHaveBeenCalledTimes(1);
});

it("follows rewritten history instead of selecting an old commit retained by another ref", async () => {
  const initial = snapshot();
  const old = {
    id: initial.status.head!,
    shortId: "aaaaaaa",
    parents: [],
    subject: "Original",
    author: "Original",
    email: "old@example.invalid",
    date: "2026-11-15T12:00:00Z",
  };
  initial.commits = [old];
  const updated = snapshot();
  const rewritten = { ...old, id: "b".repeat(40), shortId: "bbbbbbb", author: "Updated" };
  updated.status.head = rewritten.id;
  updated.commits = [rewritten, old];
  vi.mocked(git.action).mockResolvedValue("commitAuthorChanged");
  vi.mocked(git.snapshot).mockResolvedValue(updated);
  const { result } = setup(initial);
  act(() => {
    result.current.repository.setView("history");
    result.current.repository.setSelection({ kind: "commit", id: old.id });
    result.current.dialogs.showModal("changeAuthor");
    result.current.draft.setSummary("Keep my pending commit");
  });
  await act(() =>
    result.current.operations.action(
      {
        kind: "changeAuthor",
        branch: "main",
        head: old.id,
        id: old.id,
        name: "Updated",
        email: old.email,
      },
      true,
    ),
  );
  expect(result.current.repository.workspaceSelection).toEqual({
    kind: "commit",
    id: rewritten.id,
  });
  expect(result.current.dialogs.modal).toBeNull();
  expect(result.current.draft.summary).toBe("Keep my pending commit");
  expect(result.current.notice?.message.key).toBe("commitAuthorChanged");
});

it.each<Action>([
  { kind: "fetch" },
  { kind: "fetchPrune" },
  { kind: "pull" },
  { kind: "pullRebase", target: { branch: "main", head: "a".repeat(40) } },
  { kind: "push" },
  { kind: "publish", remote: "upstream" },
])(
  "opens credentials after an authentication failure during $kind without retrying",
  async (next) => {
    const initial = snapshot();
    initial.remotes = [
      { name: "origin", url: "https://github.com/example/repo.git" },
      { name: "upstream", url: "https://github.com/upstream/repo.git" },
    ];
    vi.mocked(git.action).mockRejectedValue({ key: "authenticationRequired" });
    vi.mocked(git.fetch).mockRejectedValue({ key: "authenticationRequired" });
    vi.mocked(git.snapshot).mockResolvedValue(initial);
    const { result } = setup(initial);
    if (next.kind === "publish")
      act(() => result.current.dialogs.showModal("publish", { remote: "upstream" }));
    await act(() => result.current.operations.action(next, next.kind === "publish"));
    expect(result.current.dialogs.modal).toBe("credentials");
    expect(result.current.dialogs.values).toEqual({
      authenticationRequired: true,
      ...(next.kind === "publish" ? { remote: "upstream" } : {}),
    });
    expect(result.current.dialogs.modalError).toBeNull();
    expect(result.current.activity.busy).toBe(false);
    expect(vi.mocked(git.action).mock.calls.length + vi.mocked(git.fetch).mock.calls.length).toBe(
      1,
    );
  },
);

it("keeps other remote errors in the original dialog", async () => {
  const initial = snapshot();
  initial.remotes = [{ name: "origin", url: "https://github.com/example/repo.git" }];
  vi.mocked(git.action).mockRejectedValue({ key: "gitOutput", detail: "non-fast-forward" });
  const { result } = setup(initial);
  act(() => result.current.dialogs.showModal("publish", { remote: "origin" }));
  await act(() => result.current.operations.action({ kind: "publish", remote: "origin" }, true));
  expect(result.current.dialogs.modal).toBe("publish");
  expect(result.current.dialogs.modalError?.values?.detail).toBe("non-fast-forward");
});
