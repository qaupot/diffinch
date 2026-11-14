import { describe, expect, it } from "vitest";
import { changedWords, parsePatch, splitLines } from "./patch";

describe("patch parsing", () => {
  it("counts blank context lines and preserves selectable line indexes", () => {
    const patch = parsePatch(
      "diff --git a/notes b/notes\n--- a/notes\n+++ b/notes\n@@ -1,5 +1,5 @@\n one\n \n-old\n+new\n \n end\n",
    );
    expect(patch.insertions).toBe(1);
    expect(patch.deletions).toBe(1);
    expect(
      patch.files[0].hunks[0].lines.filter(
        (line) => line.kind === "insert" || line.kind === "delete",
      ),
    ).toEqual([
      { kind: "delete", index: 2, text: "old", old: 3 },
      { kind: "insert", index: 3, text: "new", next: 3 },
    ]);
    expect(patch.files[0].hunks[0].lines.at(-1)).toMatchObject({ old: 5, next: 5 });
  });

  it("handles added files, missing final newlines, and multiple hunks", () => {
    const patch = parsePatch(
      "diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+first\n\\ No newline at end of file\ndiff --git a/old b/renamed\n--- a/old\n+++ b/renamed\n@@ -8 +8 @@\n-before\n+after\n@@ -20 +20 @@\n-previous\n+next\n",
    );
    expect(patch.files.map(({ label }) => label)).toEqual(["new", "renamed"]);
    expect(patch.files.flatMap(({ hunks }) => hunks.map(({ index }) => index))).toEqual([0, 1, 2]);
    expect(patch.files[0].hunks[0].lines[1]).toMatchObject({ kind: "meta", index: 1 });
    expect(patch).toMatchObject({ insertions: 3, deletions: 2 });
  });

  it("keeps unmatched additions aligned after a replacement", () => {
    const patch = parsePatch("@@ -1 +1,2 @@\n-old\n+new\n+extra\n");
    const rows = splitLines(patch.files[0].hunks[0].lines);
    expect(rows[0]).toMatchObject({ left: { text: "old" }, right: { text: "new" } });
    expect(rows[1]).toEqual({
      left: undefined,
      right: { kind: "insert", index: 2, text: "extra", next: 2 },
    });
  });

  it("bounds word comparisons and handles Unicode without marking unchanged text", () => {
    expect(changedWords("안녕 world", "안녕 world")).toEqual([]);
    expect(changedWords("안녕 earth", "안녕 world")).toEqual([[3, 8]]);
    expect(changedWords("x".repeat(3000), "y")).toEqual([[0, 3000]]);
  });
});
