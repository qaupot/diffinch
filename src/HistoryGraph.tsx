import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "./i18n";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Copy,
  Crosshair,
  Ellipsis,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Tag as TagIcon,
  X,
} from "./icons";
import { commitAuthor } from "./lib/commits";
import {
  historyLimit,
  shortcut,
  staged,
  unstaged,
  type Branch,
  type Commit,
  type Selection,
  type Snapshot,
  type Stash,
  type Tag,
} from "./lib/git";
import { historyEntries, layoutGraph } from "./lib/graph";
import { isComposing } from "./lib/keyboard";
import { useVirtualRows } from "./lib/virtual";

const rowHeight = 42;
const laneGap = 16;
const laneX = (lane: number) => 13 + lane * laneGap;
const laneColor = (color: number) => `var(--lane-${color % 7})`;

export type CommitCommand =
  | "branch"
  | "tag"
  | "copy"
  | "cherryPick"
  | "revert"
  | "changeAuthor"
  | "interactiveRebase"
  | "interactiveRebaseFromRoot";
type BranchCommand = "switch" | "merge" | "rebase" | "delete";
type Reference =
  | { kind: "head"; name: string }
  | { kind: "branch"; branch: Branch; name: string }
  | { kind: "tag"; name: string }
  | { kind: "stash"; name: string; subject: string };
type Jump = { id: string; label: string };
type Props = {
  id: string;
  repo: Snapshot;
  filtered: boolean;
  query: string;
  searchInput: RefObject<HTMLInputElement | null>;
  selectedId?: string;
  scrollRequest: number;
  busy: boolean;
  loadingHistory: boolean;
  diffId: string;
  diffVisible: boolean;
  onToggleDiff: () => void;
  onQuery: (query: string) => void;
  onSelect: (selection: Exclude<Selection, { kind: "file" }>) => void;
  onJump: (target: Jump) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onCommitCommand: (command: CommitCommand, commit: Commit) => void;
  onBranchCommand: (command: BranchCommand, branch: Branch) => void;
  onDeleteTag: (name: string) => void;
  onDropStash: (stash: Stash) => void;
};

function addRef(refs: Map<string, Reference[]>, tip: string, ref: Reference) {
  const list = refs.get(tip);
  if (list) list.push(ref);
  else refs.set(tip, [ref]);
}

function tagOption(tag: Tag) {
  return { key: `tag/${tag.name}`, target: { id: tag.tip, label: tag.name } };
}

function branchOption(branch: Branch) {
  return {
    key: `${branch.remote ? "remote" : "local"}/${branch.name}`,
    target: { id: branch.tip, label: branch.name },
  };
}

function GraphCell({
  row,
  width,
  height,
  uncommitted = false,
}: {
  row: ReturnType<typeof layoutGraph>["rows"][number];
  width: number;
  height: number;
  uncommitted?: boolean;
}) {
  const rowHeight = height;
  const center = height / 2;
  const x = laneX(row.lane);
  return (
    <span className="graph-cell">
      <svg
        className="commit-lanes"
        width={width}
        height={rowHeight}
        aria-hidden="true"
        focusable="false"
      >
        <g fill="none" strokeWidth="2">
          {row.through.map(({ lane, color, older }) => (
            <path
              key={lane}
              d={`M${laneX(lane)} 0v${rowHeight}`}
              stroke={laneColor(color)}
              strokeDasharray={older ? "4 3" : undefined}
            />
          ))}
          {row.incoming && <path d={`M${x} 0v${center}`} stroke={laneColor(row.color)} />}
          {row.parents.map(({ to, color, older }, index) => {
            const target = laneX(to);
            return (
              <path
                key={index}
                d={
                  row.lane === to
                    ? `M${x} ${center}V${rowHeight}`
                    : `M${x} ${center}C${x} ${(height * 34) / 42} ${target} ${(height * 24) / 42} ${target} ${rowHeight}`
                }
                stroke={laneColor(color)}
                strokeDasharray={older || uncommitted ? "4 3" : undefined}
              />
            );
          })}
        </g>
        <circle
          className="commit-node"
          cx={x}
          cy={center}
          r={row.parents.length > 1 || uncommitted ? 5 : 4}
          fill={row.parents.length > 1 || uncommitted ? "var(--graph-row)" : laneColor(row.color)}
          stroke={laneColor(row.color)}
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}

export default function HistoryGraph({
  id,
  repo,
  filtered,
  query,
  searchInput,
  selectedId,
  scrollRequest,
  busy,
  loadingHistory,
  onQuery,
  onSelect,
  onJump,
  onLoadMore,
  onRefresh,
  onCommitCommand,
  onBranchCommand,
  onDeleteTag,
  onDropStash,
  diffId,
  diffVisible,
  onToggleDiff,
}: Props) {
  const { t, dateTime } = useTranslation();
  const {
    commits,
    branches,
    tags,
    stashes,
    status: { head },
  } = repo;
  const [menu, setMenu] = useState<{ id: string; x?: number; y?: number } | null>(null);
  const [branchTarget, setBranchTarget] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const stagedCount = repo.status.files.filter(staged).length;
  const unstagedCount = repo.status.files.filter(unstaged).length;
  const entries = useMemo(
    () => historyEntries(commits, head, stagedCount, unstagedCount),
    [commits, head, stagedCount, unstagedCount],
  );
  const rows = useVirtualRows(entries.length, rowHeight, 28);
  const focusSelection = useRef(false);
  const graph = useMemo(() => layoutGraph(entries), [entries]);
  const refs = useMemo(() => {
    const map = new Map<string, Reference[]>();
    if (head) addRef(map, head, { kind: "head", name: "HEAD" });
    const current = branches.find((branch) => branch.current);
    if (current) addRef(map, current.tip, { kind: "branch", name: current.name, branch: current });
    for (const branch of branches) {
      if (!branch.current) addRef(map, branch.tip, { kind: "branch", name: branch.name, branch });
    }
    for (const tag of tags) addRef(map, tag.tip, { kind: "tag", name: tag.name });
    for (const stash of stashes)
      addRef(map, stash.tip, { kind: "stash", name: stash.id, subject: stash.subject });
    return map;
  }, [head, branches, tags, stashes]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      new Set(
        needle
          ? commits
              .filter((commit) =>
                [
                  commit.subject,
                  commit.author,
                  commit.email,
                  commit.id,
                  ...(refs.get(commit.id) ?? []).flatMap((ref) =>
                    ref.kind === "stash" ? [ref.name, ref.subject] : [ref.name],
                  ),
                ].some((value) => value.toLowerCase().includes(needle)),
              )
              .map(({ id }) => id)
          : [],
      ),
    [commits, needle, refs],
  );
  const matchIds = useMemo(() => [...matches], [matches]);
  const jumpOptions = useMemo(
    () => [
      branches.filter((branch) => !branch.remote).map(branchOption),
      branches.filter((branch) => branch.remote).map(branchOption),
      tags.map(tagOption),
      stashes.map((stash) => ({
        key: `stash/${stash.id}`,
        target: { id: stash.tip, label: `${stash.id}: ${stash.subject}` },
      })),
    ],
    [branches, tags, stashes],
  );

  const width = laneX(graph.width - 1) + 13;
  const menuCommit = menu ? commits.find(({ id }) => id === menu.id) : undefined;
  const actionableBranches = menuCommit
    ? (refs.get(menuCommit.id) ?? []).flatMap((ref) =>
        ref.kind === "branch" && !ref.branch.current ? [ref.branch] : [],
      )
    : [];
  const actionBranch =
    actionableBranches.find((branch) => branchOption(branch).key === branchTarget) ??
    actionableBranches[0];
  const canChange = !busy && !repo.operation;
  const canRebase = canChange && !!repo.path && !!repo.status.branch && !!head;

  const revealSelection = useEffectEvent(() => {
    rows.reveal(entries.findIndex((entry) => entry.id === selectedId));
  });
  useLayoutEffect(() => {
    revealSelection();
  }, [selectedId, scrollRequest, rows.rowHeight]);
  useLayoutEffect(() => {
    if (focusSelection.current && selectedRow.current) {
      selectedRow.current.focus({ preventScroll: true });
      focusSelection.current = false;
    }
  }, [selectedId, rows.start, rows.end]);

  useEffect(() => {
    if (!menu) return;
    menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function outside(event: PointerEvent) {
      if (
        !menuPanel.current?.contains(event.target as Node) &&
        !menuButton.current?.contains(event.target as Node)
      )
        setMenu(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenu(null);
      focusReturn.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  function nextMatch(direction: number) {
    if (!matchIds.length) return;
    const index = matchIds.indexOf(selectedId ?? "");
    const next =
      index === -1
        ? direction > 0
          ? 0
          : matchIds.length - 1
        : (index + direction + matchIds.length) % matchIds.length;
    onSelect({ kind: "commit", id: matchIds[next] });
    if (matchIds[next] === selectedId)
      rows.reveal(entries.findIndex((entry) => entry.id === selectedId));
  }

  function openMenu(id: string, trigger: HTMLElement, x?: number, y?: number) {
    focusReturn.current = trigger;
    setBranchTarget("");
    setMenu({ id, x, y });
  }

  function selectEntry(entry: (typeof entries)[number]) {
    setMenu(null);
    onSelect(
      entry.kind === "changes"
        ? { kind: "changes", id: entry.id }
        : { kind: "commit", id: entry.id },
    );
  }

  function runCommand(run: () => void) {
    setMenu(null);
    focusReturn.current?.focus();
    run();
  }

  return (
    <section id={id} className="inspector graph-inspector" aria-label={t("commitGraph")}>
      <div className="inspector-heading">
        <div>
          <h2>{t("commitGraph")}</h2>
          <p>
            {t(
              repo.hasOlderCommits
                ? "loadedCommits"
                : commits.length === 1
                  ? "oneCommit"
                  : "commits",
              { count: commits.length },
            )}
          </p>
        </div>
        <div className="inspector-controls">
          <button
            type="button"
            className="icon-button"
            title={t(diffVisible ? "hideDiffPanel" : "showDiffPanel")}
            aria-label={t(diffVisible ? "hideDiffPanel" : "showDiffPanel")}
            aria-expanded={diffVisible}
            aria-controls={diffVisible ? diffId : undefined}
            onClick={onToggleDiff}
          >
            {diffVisible ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button
            className="icon-button"
            disabled={!head || busy}
            onClick={() => {
              if (head) onJump({ id: head, label: "HEAD" });
            }}
            title={t("jumpToHead")}
            aria-label={t("jumpToHead")}
          >
            <Crosshair size={16} />
          </button>
          <button
            className="icon-button"
            title={t("refresh", { shortcut: `${shortcut}R` })}
            disabled={busy || !repo.path}
            onClick={onRefresh}
          >
            <RefreshCw size={15} />
          </button>
          <div className="dropdown-anchor">
            <button
              ref={menuButton}
              className="icon-button"
              disabled={!commits.some(({ id }) => id === selectedId)}
              title={t("commitActions")}
              aria-label={t("commitActions")}
              aria-expanded={!!menu}
              onClick={(event) =>
                menu ? setMenu(null) : selectedId && openMenu(selectedId, event.currentTarget)
              }
            >
              <Ellipsis size={19} />
            </button>
            {menu && menuCommit && (
              <div
                ref={menuPanel}
                className={`dropdown graph-menu${menu.x === undefined ? "" : " graph-menu-context"}`}
                style={
                  menu.x === undefined
                    ? undefined
                    : {
                        left: `clamp(8px, ${menu.x}px, calc(100vw - 223px))`,
                        top: `clamp(8px, ${menu.y}px, calc(100vh - min(375px, 70vh)))`,
                      }
                }
              >
                <div className="menu-label">{menuCommit.shortId}</div>
                <button
                  disabled={!canChange}
                  onClick={() => runCommand(() => onCommitCommand("branch", menuCommit))}
                >
                  <GitBranch size={15} />
                  {t("createBranchHere")}
                </button>
                <button
                  disabled={busy}
                  onClick={() => runCommand(() => onCommitCommand("tag", menuCommit))}
                >
                  <TagIcon size={15} />
                  {t("createTagHere")}
                </button>
                <button onClick={() => runCommand(() => onCommitCommand("copy", menuCommit))}>
                  <Copy size={15} />
                  {t("copyCommitSha")}
                </button>
                <button
                  disabled={!canChange || !head || menuCommit.parents.length > 1}
                  onClick={() => runCommand(() => onCommitCommand("cherryPick", menuCommit))}
                >
                  <GitCommitHorizontal size={15} />
                  {t("cherryPickMenu")}
                </button>
                <button
                  disabled={!canChange || !head || menuCommit.parents.length > 1}
                  onClick={() => runCommand(() => onCommitCommand("revert", menuCommit))}
                >
                  <GitCommitHorizontal size={15} />
                  {t("revert")}
                </button>
                <button
                  disabled={!canRebase}
                  onClick={() => runCommand(() => onCommitCommand("changeAuthor", menuCommit))}
                >
                  <GitCommitHorizontal size={15} />
                  {t("changeCommitAuthorMenu")}
                </button>
                <button
                  disabled={!canRebase || head === menuCommit.id}
                  onClick={() => runCommand(() => onCommitCommand("interactiveRebase", menuCommit))}
                >
                  <GitMerge size={15} />
                  {t("interactiveRebaseFrom")}
                </button>
                {menuCommit.parents.length === 0 && (
                  <button
                    disabled={!canRebase}
                    onClick={() =>
                      runCommand(() => onCommitCommand("interactiveRebaseFromRoot", menuCommit))
                    }
                  >
                    <GitMerge size={15} />
                    {t("interactiveRebaseFromRoot")}
                  </button>
                )}
                {actionBranch && (
                  <>
                    {actionableBranches.length > 1 ? (
                      <select
                        aria-label={t("branchForActions")}
                        value={branchOption(actionBranch).key}
                        onChange={(event) => setBranchTarget(event.target.value)}
                      >
                        {actionableBranches.map((branch) => (
                          <option key={branchOption(branch).key} value={branchOption(branch).key}>
                            {t(branch.remote ? "namedRemoteBranch" : "namedLocalBranch", {
                              name: branch.name,
                            })}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="menu-label truncate" title={actionBranch.name}>
                        {actionBranch.name}
                      </div>
                    )}
                    <button
                      disabled={!canChange}
                      onClick={() => runCommand(() => onBranchCommand("switch", actionBranch))}
                    >
                      <GitBranch size={15} />
                      {t("switchToBranch")}
                    </button>
                    <button
                      disabled={!canChange || !repo.status.branch}
                      onClick={() => runCommand(() => onBranchCommand("merge", actionBranch))}
                    >
                      <GitMerge size={15} />
                      {t("mergeIntoCurrent")}
                    </button>
                    <button
                      disabled={!canChange || !repo.status.branch}
                      onClick={() => runCommand(() => onBranchCommand("rebase", actionBranch))}
                    >
                      <GitMerge size={15} />
                      {t("rebaseCurrent")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => runCommand(() => onBranchCommand("delete", actionBranch))}
                    >
                      <X size={15} />
                      {t("deleteNamed", { name: actionBranch.name })}
                    </button>
                  </>
                )}
                {tags
                  .filter((tag) => tag.tip === menuCommit.id)
                  .map((tag) => (
                    <button
                      key={`tag/${tag.name}`}
                      disabled={busy}
                      onClick={() => runCommand(() => onDeleteTag(tag.name))}
                    >
                      <X size={15} />
                      {t("deleteNamedTag", { name: tag.name })}
                    </button>
                  ))}
                {stashes
                  .filter((stash) => stash.tip === menuCommit.id)
                  .map((stash) => (
                    <button
                      key={`stash/${stash.id}`}
                      disabled={busy}
                      onClick={() => runCommand(() => onDropStash(stash))}
                    >
                      <X size={15} />
                      {t("dropNamedStash", { name: stash.id })}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="graph-tools">
        <div className="search-box graph-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t("findCommit")}
            aria-label={t("findCommit")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isComposing(event.nativeEvent)) {
                event.preventDefault();
                nextMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {needle && (
            <>
              <span className="graph-match-count" role="status">
                {t(matches.size === 1 ? "oneMatch" : "matches", { count: matches.size })}
              </span>
              <button
                className="icon-button"
                title={t("previousMatch")}
                aria-label={t("previousMatch")}
                disabled={!matches.size}
                onClick={() => nextMatch(-1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon-button"
                title={t("nextMatch")}
                aria-label={t("nextMatch")}
                disabled={!matches.size}
                onClick={() => nextMatch(1)}
              >
                <ChevronRight size={15} />
              </button>
            </>
          )}
        </div>
        <label className="graph-jump">
          <GitBranch size={14} aria-hidden="true" />
          <select
            aria-label={t("jumpToReference")}
            value=""
            disabled={busy || (!branches.length && !tags.length && !stashes.length)}
            onChange={(event) => {
              const option = jumpOptions.flat().find(({ key }) => key === event.target.value);
              if (option) onJump(option.target);
            }}
          >
            <option value="" disabled>
              {t("jumpToRef")}
            </option>
            {jumpOptions.map(
              (group, index) =>
                group.length > 0 && (
                  <optgroup
                    key={index}
                    label={
                      [t("localBranches"), t("remoteBranches"), t("tags"), t("stashes")][index]
                    }
                  >
                    {group.map(({ key, target }) => (
                      <option key={key} value={key}>
                        {target.label}
                      </option>
                    ))}
                  </optgroup>
                ),
            )}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </label>
      </div>

      <div
        ref={rows.ref}
        onScroll={rows.measure}
        className="graph-scroll"
        aria-label={t("commitsLabel")}
      >
        <div className="graph-table" style={{ "--graph-lanes": `${width}px` } as CSSProperties}>
          <div data-virtual-sticky className="graph-columns" aria-hidden="true">
            <span />
            <span>{t("commit")}</span>
            <span>{t("author")}</span>
            <span>{t("dateTime")}</span>
          </div>
          <div className="graph-spacer" style={{ height: rows.before }} aria-hidden="true" />
          {entries.slice(rows.start, rows.end).map((entry, offset) => {
            const index = rows.start + offset;
            const commit = entry.kind === "commit" ? entry : null;
            const active = selectedId === entry.id;
            const refList = refs.get(entry.id) ?? [];
            const subject =
              entry.kind === "changes"
                ? t(entry.id === "staged" ? "stagedChanges" : "currentChanges")
                : entry.subject || t("noSubject");
            const count =
              entry.kind === "changes"
                ? t(entry.count === 1 ? "oneFileChanged" : "filesChanged", { count: entry.count })
                : "";
            const date = commit ? dateTime(commit.date) : "";
            return (
              <button
                data-virtual-row
                key={entry.id}
                ref={active ? selectedRow : undefined}
                type="button"
                className={`graph-row${index % 2 ? " striped" : ""}${commit ? "" : " graph-changes"}${matches.has(entry.id) ? " graph-match" : ""}`}
                aria-pressed={active}
                aria-label={
                  commit
                    ? `${subject}, ${commit.shortId}, ${commitAuthor(commit)}, ${date}${refList.length ? `, ${refList.map(({ name }) => name).join(", ")}` : ""}`
                    : `${subject}, ${count}`
                }
                onClick={() => selectEntry(entry)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  selectEntry(entry);
                  if (!commit) return;
                  openMenu(
                    commit.id,
                    event.currentTarget,
                    event.clientX || undefined,
                    event.clientY,
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    selectEntry(entry);
                    if (!commit) return;
                    openMenu(commit.id, event.currentTarget);
                  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const adjacent = entries[index + (event.key === "ArrowDown" ? 1 : -1)];
                    if (adjacent) {
                      focusSelection.current = true;
                      selectEntry(adjacent);
                    }
                  }
                }}
              >
                <GraphCell
                  row={graph.rows[index]}
                  width={width}
                  height={rows.rowHeight}
                  uncommitted={!commit}
                />
                <span className="graph-summary">
                  <span className="graph-subject truncate" title={subject}>
                    {subject}
                  </span>
                  <span className="graph-meta">
                    {commit ? (
                      <code>{commit.shortId}</code>
                    ) : (
                      <span className="graph-change-count">{count}</span>
                    )}
                    {refList.map((ref) => {
                      const Icon =
                        ref.kind === "tag"
                          ? TagIcon
                          : ref.kind === "stash"
                            ? Archive
                            : ref.kind === "head"
                              ? Crosshair
                              : ref.branch.remote
                                ? Cloud
                                : GitBranch;
                      return (
                        <span
                          key={
                            ref.kind === "branch"
                              ? branchOption(ref.branch).key
                              : `${ref.kind}/${ref.name}`
                          }
                          className={`graph-ref graph-ref-${ref.kind}${ref.kind === "branch" && ref.branch.remote ? " graph-ref-remote" : ""}`}
                          title={ref.kind === "stash" ? `${ref.name}: ${ref.subject}` : ref.name}
                        >
                          <Icon size={10} />
                          <span className="truncate">{ref.name}</span>
                        </span>
                      );
                    })}
                  </span>
                </span>
                <span
                  className="graph-author truncate"
                  title={commit ? commitAuthor(commit) : undefined}
                >
                  {commit?.author ?? t(entry.id === "staged" ? "staged" : "unstaged")}
                </span>
                {commit ? <time dateTime={commit.date}>{date}</time> : <span />}
              </button>
            );
          })}
          <div className="graph-spacer" style={{ height: rows.after }} aria-hidden="true" />
        </div>
        {!entries.length && (
          <div className="graph-empty">
            <GitCommitHorizontal size={24} />
            <strong>{t(filtered ? "noVisibleCommits" : "noCommits")}</strong>
            <p>{t(filtered ? "showBranchesHint" : "firstCommitGraph")}</p>
          </div>
        )}
        {repo.hasOlderCommits && (
          <div className="graph-more">
            {commits.length >= historyLimit ? (
              <span>{t("showingLatestCommits", { count: historyLimit })}</span>
            ) : (
              <button className="plain-button" disabled={busy} onClick={onLoadMore}>
                <ArrowDown size={14} />
                {loadingHistory ? t("loadingCommits") : t("loadOlderCommits")}
              </button>
            )}
            <button
              className="icon-button"
              disabled={!head || busy}
              title={t("backToHead")}
              aria-label={t("backToHead")}
              onClick={() => {
                if (head) onJump({ id: head, label: "HEAD" });
              }}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
