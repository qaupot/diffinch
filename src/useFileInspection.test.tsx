import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { git, type FileInspectionResult } from "./lib/git";
import { deferred } from "./test/fixtures";
import { useFileInspection } from "./useFileInspection";

beforeEach(() => {
  vi.spyOn(git, "cancelTransfer").mockResolvedValue(undefined);
});

it("cancels stale reads and ignores their results when the file changes", async () => {
  const first = deferred<FileInspectionResult>();
  const second = deferred<FileInspectionResult>();
  const inspect = vi
    .spyOn(git, "inspectFile")
    .mockImplementationOnce((_path, _request, _id, progress) => {
      progress(0);
      return first.promise;
    })
    .mockImplementationOnce((_path, _request, _id, progress) => {
      progress(0);
      return second.promise;
    });
  const { result, rerender, unmount } = renderHook(
    ({ file }) =>
      useFileInspection<"history">("/repo", {
        kind: "history",
        revision: "a".repeat(40),
        file,
        limit: 100,
      }),
    { initialProps: { file: "first.txt" } },
  );
  rerender({ file: "second.txt" });
  expect(git.cancelTransfer).toHaveBeenCalledWith(inspect.mock.calls[0][2]);
  await act(async () => second.resolve({ kind: "history", data: { commits: [], hasMore: false } }));
  expect(result.current.data?.hasMore).toBe(false);
  await act(async () => first.resolve({ kind: "history", data: { commits: [], hasMore: true } }));
  expect(result.current.data?.hasMore).toBe(false);
  expect(result.current.pending).toBe(false);
  unmount();
  expect(git.cancelTransfer).toHaveBeenCalledTimes(1);
});

it("cancels after registration if a view was closed before the first progress event", async () => {
  const pending = deferred<FileInspectionResult>();
  const inspect = vi.spyOn(git, "inspectFile").mockReturnValue(pending.promise);
  const { unmount } = renderHook(() =>
    useFileInspection<"catalog">("/repo", { kind: "catalog", revision: "HEAD" }),
  );
  unmount();
  expect(git.cancelTransfer).not.toHaveBeenCalled();
  act(() => {
    for (const percent of [0, 25, 50]) inspect.mock.calls[0][3](percent);
  });
  expect(git.cancelTransfer).toHaveBeenCalledTimes(1);
  expect(git.cancelTransfer).toHaveBeenCalledWith(inspect.mock.calls[0][2]);
  await act(async () => pending.reject({ key: "operationInterrupted" }));
});

it("can retry a failed request without changing the selected file", async () => {
  const inspect = vi
    .spyOn(git, "inspectFile")
    .mockRejectedValueOnce({ key: "operationInterrupted" })
    .mockResolvedValueOnce({
      kind: "catalog",
      data: { revision: "a".repeat(40), files: ["file.txt"] },
    });
  const { result } = renderHook(() =>
    useFileInspection<"catalog">("/repo", { kind: "catalog", revision: "HEAD" }),
  );
  await waitFor(() => expect(result.current.error?.key).toBe("operationInterrupted"));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.data?.files).toEqual(["file.txt"]));
  expect(inspect).toHaveBeenCalledTimes(2);
});
