import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ConflictView from "./ConflictView";
import { git } from "./lib/git";
import { fileChange } from "./test/fixtures";

async function setup(result: string, markerSize = 7) {
  vi.spyOn(git, "conflict").mockResolvedValue({
    base: "Title\n=======\nbase\n",
    current: "Title\n=======\ncurrent\n",
    incoming: "Title\n=======\nincoming\n",
    result,
    token: "conflict-state",
    markerSize,
  });
  const action = vi.fn().mockResolvedValue(undefined);
  const file = { ...fileChange("readme"), path: "README.md", conflict: true };
  render(
    <ConflictView
      path="/repo"
      file={file}
      busy={false}
      action={action}
      onEditor={vi.fn()}
      onTools={vi.fn()}
    />,
  );
  const save = await screen.findByRole("button", { name: "Save and stage" });
  return { action, file, save: save as HTMLButtonElement };
}

it("saves a resolved Markdown conflict without deleting its heading underline", async () => {
  const { action, file, save } = await setup(
    "Title\n=======\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n",
  );
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Accept current" }));
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(action).toHaveBeenCalledWith({
    kind: "resolveConflict",
    id: file.id,
    token: "conflict-state",
    text: "Title\n=======\ncurrent\n",
  });
});

it.each([3, 5, 32])("recognizes and resolves configured %i-character markers", async (size) => {
  const current = "<".repeat(size),
    separator = "=".repeat(size),
    incoming = ">".repeat(size);
  const prefix = size > 7 ? "<<<<<<< documented example\n" : "";
  const { action, save } = await setup(
    `${prefix}${current} HEAD\ncurrent\n${separator}\nincoming\n${incoming} topic\n`,
    size,
  );
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Accept current" }));
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ text: `${prefix}current\n` }));
});

it("keeps Markdown underlines inside a diff3 side when accepting it", async () => {
  const { action, save } = await setup(
    "<<<<<<< HEAD\r\nTitle\r\n============\r\ncurrent\r\n||||||| base\r\nold\r\n=======\r\nincoming\r\n>>>>>>> topic\r\n",
  );
  fireEvent.click(screen.getByRole("button", { name: "Accept current" }));
  fireEvent.click(save);
  expect(action).toHaveBeenCalledWith(
    expect.objectContaining({ text: "Title\r\n============\r\ncurrent\r\n" }),
  );
});

it("keeps the outer conflict when a side contains a wider opening marker", async () => {
  const { action, save } = await setup(
    "<<<<<<< HEAD\ncurrent\n=======\n<<<<<<<< example from a patch\nincoming\n>>>>>>> topic\n",
  );
  fireEvent.click(screen.getByRole("button", { name: "Accept current" }));
  fireEvent.click(save);
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ text: "current\n" }));
});

it("recognizes a complete conflict after a standalone wider marker", async () => {
  await setup(
    "<<<<<<<< documented example\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n",
  );
  expect(screen.getByRole("button", { name: "Accept incoming" })).toBeTruthy();
});

it.each([
  "<<<<<<< HEAD\nTitle\n=======\ncurrent\n=======\nincoming\n>>>>>>> topic\n",
  "<<<<<<< HEAD\n<<<<<<<< example\na\n========\nb\n>>>>>>>> end\n=======\nincoming\n>>>>>>> topic\n",
  "<<<<<<< HEAD\ncurrent\n||||||| heading\ntext\n||||||| base\nbase\n=======\nincoming\n>>>>>>> topic\n",
])("leaves an ambiguous conflict for manual resolution", async (text) => {
  const { save } = await setup(text);
  expect(screen.queryByRole("button", { name: "Accept incoming" })).toBeNull();
  expect(save.disabled).toBe(true);
});

it.each([
  "<<<<<<< HEAD\ncurrent\n=======\nincoming\n",
  "current\n=======\nincoming\n>>>>>>> topic\n",
  "||||||| base\nbase\n=======\nincoming\n",
  `${"<".repeat(32)} HEAD\r\ncurrent\r\n`,
])("blocks saving while conflict markers remain: %s", async (text) => {
  const { action, save } = await setup("Title\n=======\nresolved\n");
  expect(save.disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  await waitFor(() => expect(save.disabled).toBe(true));
  fireEvent.click(save);
  expect(action).not.toHaveBeenCalled();
});
