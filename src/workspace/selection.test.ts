import { describe, expect, it } from "vitest";
import { fileChange, snapshot } from "../test/fixtures";
import { chooseSelection, selectFile } from "./selection";

describe("repository selection", () => {
  it("retains remaining selected files after a refresh removes one", () => {
    const repo = snapshot();
    repo.status.files = [fileChange("b"), fileChange("c")];
    expect(
      chooseSelection(repo, "changes", selectFile("a", false, new Set(["a", "b"]), "a")),
    ).toEqual(selectFile("b", false));
  });

  it("follows a selected file from unstaged to staged after an action", () => {
    const repo = snapshot();
    repo.status.files = [fileChange("a", "M", ".")];
    expect(chooseSelection(repo, "changes", selectFile("a", false))).toEqual(selectFile("a", true));
  });

  it("does not treat unresolved conflicts as committable staged files", () => {
    const repo = snapshot();
    repo.status.files = [{ ...fileChange("a", "U", "U"), conflict: true }];
    expect(chooseSelection(repo, "changes", null)).toEqual(selectFile("a", false));
    expect(chooseSelection(repo, "history", null)).toEqual({ kind: "changes", id: "unstaged" });
  });

  it("returns no selection when the repository is empty", () => {
    expect(chooseSelection(snapshot(), "changes", selectFile("gone", false))).toBeNull();
    expect(chooseSelection(snapshot(), "history", { kind: "commit", id: "gone" })).toBeNull();
  });
});
