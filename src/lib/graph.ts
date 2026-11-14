import type { Commit } from "./git";

type HistoryEntry =
  | (Commit & { kind: "commit" })
  | { kind: "changes"; id: "unstaged" | "staged"; parents: string[]; count: number };

export function historyEntries(
  commits: Commit[],
  headId: string | null,
  stagedCount: number,
  unstagedCount: number,
): HistoryEntry[] {
  const head = headId ? [headId] : [];
  return [
    ...(unstagedCount
      ? [
          {
            kind: "changes" as const,
            id: "unstaged" as const,
            parents: stagedCount ? ["staged"] : head,
            count: unstagedCount,
          },
        ]
      : []),
    ...(stagedCount
      ? [{ kind: "changes" as const, id: "staged" as const, parents: head, count: stagedCount }]
      : []),
    ...commits.map((commit) => ({ ...commit, kind: "commit" as const })),
  ];
}

type Lane = { target: string; color: number; older: boolean };
type Stroke = { from: number; to: number; color: number; older: boolean };
type GraphRow = {
  lane: number;
  color: number;
  incoming: boolean;
  through: (Lane & { lane: number })[];
  parents: Stroke[];
};

export function layoutGraph(commits: readonly Pick<Commit, "id" | "parents">[]) {
  const visible = new Set(commits.map(({ id }) => id));
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  let width = 1;

  function openLane() {
    const index = lanes.indexOf(null);
    return index === -1 ? lanes.length : index;
  }

  const rows: GraphRow[] = commits.map((commit) => {
    const pending = lanes.findIndex((lane) => lane?.target === commit.id);
    const incoming = pending !== -1;
    const lane = incoming ? pending : openLane();
    const color = lanes[lane]?.color ?? nextColor++;
    const through = lanes.flatMap((entry, index) =>
      entry && index !== lane ? [{ ...entry, lane: index }] : [],
    );
    lanes[lane] = null;

    const parents = commit.parents.map((target, index) => {
      const existing = lanes.findIndex((entry) => entry?.target === target);
      const to = existing !== -1 ? existing : index === 0 ? lane : openLane();
      const parent = lanes[to] ?? {
        target,
        color: index === 0 ? color : nextColor++,
        older: !visible.has(target),
      };
      lanes[to] = parent;
      return { from: lane, to, color: parent.color, older: parent.older };
    });

    width = Math.max(width, lanes.length);
    while (lanes.at(-1) === null) lanes.pop();
    return { lane, color, incoming, through, parents };
  });
  return { rows, width };
}
