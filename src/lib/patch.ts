export type DiffLine = {
  kind: "insert" | "delete" | "context" | "meta";
  text: string;
  index: number;
  old?: number;
  next?: number;
};
type Hunk = { label: string; lines: DiffLine[]; index: number };
export type PatchFile = { label: string; hunks: Hunk[]; meta: string[] };
const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(text: string) {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunk: Hunk | undefined;
  let old = 0;
  let next = 0;
  let insertions = 0;
  let deletions = 0;
  let index = 0;

  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("diff --cc ") ||
      line.startsWith("diff --combined ")
    ) {
      file = { label: line, hunks: [], meta: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file && line) {
      file = { label: "", hunks: [], meta: [] };
      files.push(file);
    }
    const match = line.match(header);
    if (file && match) {
      old = Number(match[1]);
      next = Number(match[2]);
      hunk = { label: line, lines: [], index: index++ };
      file.hunks.push(hunk);
    } else if (hunk && line.startsWith("+")) {
      hunk.lines.push({
        kind: "insert",
        index: hunk.lines.length,
        text: line.slice(1),
        next: next++,
      });
      insertions++;
    } else if (hunk && line.startsWith("-")) {
      hunk.lines.push({
        kind: "delete",
        index: hunk.lines.length,
        text: line.slice(1),
        old: old++,
      });
      deletions++;
    } else if (hunk && line.startsWith(" ")) {
      hunk.lines.push({
        kind: "context",
        index: hunk.lines.length,
        text: line.slice(1),
        old: old++,
        next: next++,
      });
    } else if (hunk) {
      hunk.lines.push({ kind: "meta", index: hunk.lines.length, text: line });
    } else if (file && line.startsWith("+++ ") && line !== "+++ /dev/null") {
      file.label = line.slice(4).replace(/^b\//, "");
    } else if (file && line.startsWith("--- ") && line !== "--- /dev/null") {
      file.label = line.slice(4).replace(/^a\//, "");
    } else if (
      file &&
      line &&
      !line.startsWith("index ") &&
      line !== "--- /dev/null" &&
      line !== "+++ /dev/null"
    ) {
      file.meta.push(line);
    }
  }
  return { files, insertions, deletions };
}

export function splitLines(lines: DiffLine[]) {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  function flush() {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      rows.push({ left: left[index], right: right[index] });
    }
    left.length = 0;
    right.length = 0;
  }

  for (const line of lines) {
    if (line.kind === "delete") left.push(line);
    else if (line.kind === "insert") right.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

// Use a bounded word diff. For very long lines, mark the changed middle.
export function changedWords(text: string, other: string): [number, number][] {
  if (text === other) return [];
  const tokens = (line: string) => [...line.matchAll(/[\p{L}\p{N}_]+|\s+|[^\s]/gu)];
  if (text.length + other.length > 2000) return [[0, text.length]];
  const left = tokens(text);
  const right = tokens(other);
  if (left.length * right.length > 4096) {
    let start = 0;
    let end = left.length;
    let otherEnd = right.length;
    while (start < end && start < otherEnd && left[start][0] === right[start][0]) start++;
    while (start < end && start < otherEnd && left[end - 1][0] === right[otherEnd - 1][0]) {
      end--;
      otherEnd--;
    }
    return start < end ? [[left[start].index, left[end]?.index ?? text.length]] : [];
  }
  const scores = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let a = left.length - 1; a >= 0; a--) {
    for (let b = right.length - 1; b >= 0; b--) {
      scores[a][b] =
        left[a][0] === right[b][0]
          ? 1 + scores[a + 1][b + 1]
          : Math.max(scores[a + 1][b], scores[a][b + 1]);
    }
  }
  const changed: [number, number][] = [];
  let a = 0;
  let b = 0;
  while (a < left.length) {
    if (b < right.length && left[a][0] === right[b][0]) {
      a++;
      b++;
    } else if (b < right.length && scores[a][b + 1] > scores[a + 1][b]) b++;
    else {
      const start = left[a++].index;
      const end = left[a]?.index ?? text.length;
      const previous = changed.at(-1);
      if (previous?.[1] === start) previous[1] = end;
      else changed.push([start, end]);
    }
  }
  return changed;
}
