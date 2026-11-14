import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import FileHistoryView from "./FileHistoryView";
import { git, type FileInspectionResult, type FileRevision } from "./lib/git";

beforeAll(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

const old: FileRevision = {
  id: "a".repeat(40),
  shortId: "aaaaaaa",
  parents: [],
  subject: "Original file",
  author: "Avery",
  email: "avery@example.invalid",
  date: "2026-11-16T12:00:00Z",
  path: "old.txt",
  previousPath: null,
  deleted: false,
};
const renamed: FileRevision = {
  ...old,
  id: "b".repeat(40),
  shortId: "bbbbbbb",
  subject: "Rename file",
  path: "new.txt",
  previousPath: "old.txt",
};

it("browses clean files, follows historical paths, pages blame, and opens the working file", async () => {
  vi.spyOn(git, "cancelTransfer").mockResolvedValue(undefined);
  const inspect = vi
    .spyOn(git, "inspectFile")
    .mockImplementation(async (_path, request, _id, progress): Promise<FileInspectionResult> => {
      progress(0);
      switch (request.kind) {
        case "catalog":
          return { kind: "catalog", data: { revision: renamed.id, files: ["new.txt"] } };
        case "history":
          return { kind: "history", data: { commits: [renamed, old], hasMore: false } };
        case "diff":
          return { kind: "diff", data: { text: "", truncated: false, hunkToken: null } };
        case "blame":
          return {
            kind: "blame",
            data: {
              page: request.page,
              totalLines: 301,
              hasMore: request.page === 0,
              lines: [
                {
                  id: old.id,
                  author: old.author,
                  email: old.email,
                  timestamp: 1_794_830_400,
                  summary: old.subject,
                  originalLine: 1,
                  line: request.page === 0 ? 1 : 301,
                  text: request.page === 0 ? "first source line" : "last source line",
                },
              ],
            },
          };
      }
    });
  const action = vi.fn().mockResolvedValue(undefined);
  const onCommit = vi.fn();
  render(
    <FileHistoryView
      path="/repo"
      head={renamed.id}
      busy={false}
      split={false}
      setSplit={vi.fn()}
      action={action}
      onTools={vi.fn()}
      onCommit={onCommit}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "new.txt" }));
  await screen.findByRole("button", { name: /Original file/ });
  fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
  expect(action).toHaveBeenCalledWith({
    kind: "openEditor",
    file: "new.txt",
    editor: { program: "code", args: [] },
  });
  fireEvent.click(screen.getByRole("button", { name: /Original file/ }));
  fireEvent.click(screen.getByRole("button", { name: "Blame" }));
  await screen.findByText("first source line");
  expect(
    inspect.mock.calls.some(
      (call) =>
        call[1].kind === "blame" && call[1].file === "old.txt" && call[1].revision === old.id,
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next lines" }));
  await screen.findByText("last source line");
  expect(screen.queryByText("first source line")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "aaaaaaaa" }));
  expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: old.id }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next lines" }).disabled).toBe(
      true,
    ),
  );
});
