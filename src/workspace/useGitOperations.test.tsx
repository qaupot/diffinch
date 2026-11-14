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
  const tab = { snapshot: initial };
  return renderHook(() => {
    const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
    const activity = useGitActivity(false, setNotice);
    const dialogs = useWorkspaceDialogs(() => {});
    const draft = useCommitDraft(false);
    const repository = useRepositoryState({
      tab,
      active: false,
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
  });
}

const commit: Action = {
  kind: "commit",
  summary: "A summary",
  description: "A body",
  sign: false,
  amend: null,
};

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
    result.current.repository.viewRef.current = "history";
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
