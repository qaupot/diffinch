import { useEffect, useMemo, useState } from "react";
import { useTranslation, type LocalizedMessage } from "./i18n";
import { Columns2, FileCode2, FileDiff, Image, List, Minus, Plus } from "./icons";
import ImagePreview from "./ImagePreview";
import { maxDiffPage, type Action, type Diff, type Selection } from "./lib/git";
import { isComposing } from "./lib/keyboard";
import { changedWords, parsePatch, splitLines, type DiffLine } from "./lib/patch";
import { syntaxPatternForFile } from "./lib/syntax";
import { useVirtualRows } from "./lib/virtual";

type LineRow = { kind: "line"; hunk: number; syntax?: RegExp; left?: DiffLine; right?: DiffLine };
type Row =
  LineRow | { kind: "file" | "meta"; text: string } | { kind: "hunk"; text: string; index: number };
const rowHeight = 28;

function Code({
  text,
  syntax,
  needle,
  words,
}: {
  text: string;
  syntax?: RegExp;
  needle: string;
  words?: [number, number][];
}) {
  if (!needle && !words?.length) {
    if (!syntax || text.length > 1600) return text;
    return text.split(syntax).map((part, index) =>
      index % 2 ? (
        <span
          key={index}
          className={
            /^\/[/*]/.test(part)
              ? "syntax-comment"
              : /^["'`@$]/.test(part)
                ? "syntax-string"
                : "syntax-keyword"
          }
        >
          {part}
        </span>
      ) : (
        part
      ),
    );
  }
  const matches: [number, number][] = [];
  if (needle) {
    const haystack = text.toLowerCase();
    for (
      let index = haystack.indexOf(needle);
      index >= 0;
      index = haystack.indexOf(needle, index + needle.length)
    ) {
      matches.push([index, index + needle.length]);
    }
  }
  const ranges = [
    ...(words ?? []).map(([start, end]) => ({ start, end, type: "word" })),
    ...matches.map(([start, end]) => ({ start, end, type: "match" })),
  ];
  const events = ranges
    .flatMap(({ start, end, type }) => [
      { at: start, type, change: 1 },
      { at: end, type, change: -1 },
    ])
    .sort((left, right) => left.at - right.at);
  let word = 0;
  let match = 0;
  let start = 0;
  const parts = events.map(({ at, type, change }) => {
    const part =
      at > start &&
      (match ? (
        <mark key={start} className="diff-match">
          {text.slice(start, at)}
        </mark>
      ) : word ? (
        <span key={start} className="diff-word">
          {text.slice(start, at)}
        </span>
      ) : (
        text.slice(start, at)
      ));
    start = at;
    if (type === "word") word += change;
    else match += change;
    return part;
  });
  return (
    <>
      {parts}
      {text.slice(start)}
    </>
  );
}

function Line({
  line,
  syntax,
  side,
  needle,
  words,
  selected,
  onToggle,
}: {
  line?: DiffLine;
  syntax?: RegExp;
  side?: "left" | "right";
  needle: string;
  words?: [number, number][];
  selected?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  if (!line) return <div className="diff-line empty-line" />;
  const mark = line.kind === "insert" ? "+" : line.kind === "delete" ? "−" : "";
  return (
    <div className={`diff-line ${line.kind}${selected ? " diff-line-selected" : ""}`}>
      {side !== "right" && <span className="line-number">{line.old}</span>}
      {side !== "left" && <span className="line-number">{line.next}</span>}
      {onToggle ? (
        <button
          type="button"
          className="line-mark line-picker"
          aria-label={t("selectDiffLine", { line: line.old ?? line.next ?? 0 })}
          aria-pressed={selected}
          onClick={onToggle}
        >
          {mark}
        </button>
      ) : (
        <span className="line-mark">{mark}</span>
      )}
      <code>
        <Code
          text={line.text}
          syntax={line.kind !== "meta" ? syntax : undefined}
          needle={needle}
          words={words}
        />
      </code>
    </div>
  );
}

type Props = {
  fileTools?: React.ReactNode;
  id?: string;
  title: string;
  subtitle?: string;
  diff: Diff | null;
  pending: boolean;
  error: LocalizedMessage | null;
  split: boolean;
  busy: boolean;
  selection: Selection | null;
  setSplit: (split: boolean) => void;
  action?: (action: Action) => void;
  page: number;
  loadMore: () => void;
  ignoreWhitespace: boolean;
  setIgnoreWhitespace?: (ignore: boolean) => void;
};

export default function DiffView({
  fileTools,
  id,
  title,
  subtitle,
  diff,
  pending,
  error,
  split,
  busy,
  selection,
  setSplit,
  action,
  page,
  loadMore,
  ignoreWhitespace,
  setIgnoreWhitespace,
}: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [wordDiff, setWordDiff] = useState(true);
  const [picked, setPicked] = useState<{ token?: string; hunk?: number; lines: number[] }>({
    lines: [],
  });
  const [previewMode, setPreviewMode] = useState<{ key: string; images: boolean } | null>(null);
  const previewKey = JSON.stringify(selection);
  const selectionId = selection?.id;
  const staged =
    selection?.kind === "file"
      ? selection.staged
      : selection?.kind === "changes" && selection.id === "staged";
  const patch = useMemo(() => parsePatch(diff?.text ?? ""), [diff?.text]);
  const isFileSelection = selection?.kind === "file";
  const fileSelection = selection?.kind === "file" ? selection : null;
  const hunkToken = diff?.hunkToken;
  const images = diff?.images ?? [];
  const showImages =
    images.length > 0 &&
    (previewMode?.key === previewKey
      ? previewMode.images
      : patch.files.length <= 1 || !patch.files.some((file) => file.hunks.length));
  const { rows, wordChanges, width } = useMemo(() => {
    const rows: Row[] = [];
    const wordChanges = new Map<DiffLine, DiffLine>();
    let width = 0;
    for (const file of patch.files) {
      const syntax = syntaxPatternForFile(file.label || title);
      if (!isFileSelection && file.label) rows.push({ kind: "file", text: file.label });
      for (const text of file.meta) rows.push({ kind: "meta", text });
      for (const hunk of file.hunks) {
        rows.push({ kind: "hunk", text: hunk.label, index: hunk.index });
        for (const line of hunk.lines)
          width = Math.max(width, line.text.length + (line.text.match(/\t/g)?.length ?? 0) * 3);
        for (const pair of splitLines(hunk.lines)) {
          if (pair.left?.kind === "delete" && pair.right?.kind === "insert") {
            wordChanges.set(pair.left, pair.right);
            wordChanges.set(pair.right, pair.left);
          }
          if (split) rows.push({ kind: "line", hunk: hunk.index, syntax, ...pair });
        }
        if (!split)
          for (const line of hunk.lines)
            rows.push({ kind: "line", hunk: hunk.index, syntax, left: line });
      }
    }
    return { rows, wordChanges, width };
  }, [patch, split, isFileSelection, title]);
  const viewport = useVirtualRows(rows.length, rowHeight);
  const { ref: scroll, measure } = viewport;
  const needle = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    return rows.reduce<number[]>((indexes, row, index) => {
      if (
        row.kind === "line" &&
        [row.left, row.right].some((line) => line?.text.toLowerCase().includes(needle))
      )
        indexes.push(index);
      return indexes;
    }, []);
  }, [rows, needle]);

  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
    measure();
  }, [selection?.kind, selectionId, staged, showImages, scroll, measure]);

  function find(direction: -1 | 1) {
    if (!matches.length) return;
    const next =
      matchIndex < 0 || matchIndex >= matches.length
        ? direction > 0
          ? 0
          : matches.length - 1
        : (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
    viewport.reveal(matches[next]);
  }

  function renderLine(row: LineRow, line?: DiffLine, side?: "left" | "right") {
    const counterpart = line && wordChanges.get(line);
    const canToggle =
      fileSelection &&
      hunkToken &&
      !pending &&
      line &&
      (line.kind === "insert" || line.kind === "delete");
    const selectedLines =
      picked.token === hunkToken && picked.hunk === row.hunk ? picked.lines : [];
    return (
      <Line
        line={line}
        side={side}
        syntax={row.syntax}
        needle={needle}
        words={
          wordDiff && line && counterpart ? changedWords(line.text, counterpart.text) : undefined
        }
        selected={line && selectedLines.includes(line.index)}
        onToggle={
          canToggle
            ? () => {
                setPicked({
                  token: hunkToken,
                  hunk: row.hunk,
                  lines: selectedLines.includes(line.index)
                    ? selectedLines.filter((index) => index !== line.index)
                    : [...selectedLines, line.index],
                });
              }
            : undefined
        }
      />
    );
  }

  const hunkCount = patch.files.reduce((count, file) => count + file.hunks.length, 0);
  const pickedHunk =
    picked.token === hunkToken && picked.lines.length > 0 ? picked.hunk : undefined;
  return (
    <main id={id} className="review">
      <div className="review-header">
        <div className="review-heading">
          <span className="file-tile">
            {showImages ? <Image size={20} /> : <FileCode2 size={20} />}
          </span>
          <div className="truncate">
            <h1 title={title}>{title}</h1>
            {subtitle && (
              <p className="truncate" title={subtitle}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <div className="review-controls">
          {fileTools}
          {!showImages && patch.insertions + patch.deletions > 0 && (
            <div
              className="diff-totals"
              aria-label={t("diffTotals", { added: patch.insertions, deleted: patch.deletions })}
            >
              <span className="positive">+{patch.insertions}</span>
              <span className="negative">−{patch.deletions}</span>
            </div>
          )}
          {!showImages && (
            <div className="segmented" aria-label={t("diffLayout")}>
              <button
                aria-pressed={!split}
                onClick={() => setSplit(false)}
                title={t("unifiedDiff")}
                aria-label={t("unifiedDiff")}
              >
                <List size={15} />
                <span>{t("unified")}</span>
              </button>
              <button
                aria-pressed={split}
                onClick={() => setSplit(true)}
                title={t("splitDiff")}
                aria-label={t("splitDiff")}
              >
                <Columns2 size={15} />
                <span>{t("split")}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {images.length > 0 && (
        <div className="preview-mode">
          <div className="segmented" aria-label={t("fileView")}>
            <button
              type="button"
              aria-pressed={showImages}
              onClick={() => setPreviewMode({ key: previewKey, images: true })}
            >
              <Image size={14} />
              {t("imagePreviews", { count: images.length })}
            </button>
            <button
              type="button"
              aria-pressed={!showImages}
              onClick={() => setPreviewMode({ key: previewKey, images: false })}
            >
              <FileDiff size={14} />
              {t("textDiff")}
            </button>
          </div>
        </div>
      )}
      {!showImages && (
        <div className="diff-tools">
          <label>
            <input
              type="checkbox"
              checked={wordDiff}
              onChange={(event) => setWordDiff(event.target.checked)}
            />
            {t("wordDiff")}
          </label>
          {setIgnoreWhitespace && (
            <label>
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(event) => setIgnoreWhitespace(event.target.checked)}
              />
              {t("ignoreWhitespace")}
            </label>
          )}
          <input
            type="search"
            value={search}
            placeholder={t("searchDiff")}
            aria-label={t("searchDiff")}
            onChange={(event) => {
              setSearch(event.target.value);
              setMatchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (isComposing(event.nativeEvent)) return;
                find(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {needle && <span role="status">{t("matchingLines", { count: matches.length })}</span>}
          <button
            type="button"
            className="plain-button"
            disabled={!matches.length}
            aria-label={t("previousDiffMatch")}
            onClick={() => find(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="plain-button"
            disabled={!matches.length}
            aria-label={t("nextDiffMatch")}
            onClick={() => find(1)}
          >
            ↓
          </button>
          {fileSelection && hunkToken && action && pickedHunk !== undefined && (
            <button
              type="button"
              className="plain-button"
              disabled={busy || pending}
              onClick={() =>
                action({
                  kind: "hunk",
                  id: fileSelection.id,
                  staged: fileSelection.staged,
                  index: pickedHunk,
                  token: hunkToken,
                  page,
                  lines: picked.lines,
                })
              }
            >
              {t(staged ? "unstageLines" : "stageLines", { count: picked.lines.length })}
            </button>
          )}
        </div>
      )}
      <div
        className={`review-scroll${showImages ? "" : " virtual-diff"}`}
        ref={scroll}
        onScroll={viewport.measure}
        aria-busy={pending}
      >
        {error ? (
          <div className="review-empty">
            <FileDiff size={27} />
            <strong>{t("diffFailed")}</strong>
            <p>{t(error.key, error.values)}</p>
          </div>
        ) : pending && !diff ? (
          <div className="review-empty">
            <span className="spinner" />
            {t("loadingDiff")}
          </div>
        ) : showImages ? (
          <ImagePreview images={images} />
        ) : !rows.length ? (
          <div className="review-empty">
            <FileDiff size={29} />
            <strong>{selection ? t("noTextChanges") : t("nothingToReview")}</strong>
            <p>{selection ? t("noPatch") : t("selectDiff")}</p>
          </div>
        ) : (
          <div
            className={`virtual-patch ${split ? "split" : "unified"}`}
            style={{ minWidth: `calc(${width * (split ? 2 : 1)}ch + ${split ? 120 : 110}px)` }}
          >
            <div style={{ height: viewport.before }} aria-hidden="true" />
            {rows.slice(viewport.start, viewport.end).map((row, offset) => {
              const index = viewport.start + offset;
              if (row.kind === "line")
                return (
                  <div
                    data-virtual-row
                    key={index}
                    className={`virtual-diff-row${split ? " split-row" : ""}${matches[matchIndex] === index ? " current-diff-match" : ""}`}
                  >
                    {renderLine(row, row.left, split ? "left" : undefined)}
                    {split && renderLine(row, row.right, "right")}
                  </div>
                );
              if (row.kind !== "hunk")
                return (
                  <div
                    data-virtual-row
                    key={index}
                    className={`virtual-diff-row diff-${row.kind}-row`}
                    title={row.text}
                  >
                    {row.text}
                  </div>
                );
              return (
                <div data-virtual-row key={index} className="virtual-diff-row hunk-heading">
                  <code title={row.text}>{row.text}</code>
                  {fileSelection && hunkToken && action && (
                    <div className="hunk-actions">
                      <button
                        className="hunk-action"
                        disabled={busy || pending}
                        onClick={() =>
                          action({
                            kind: "hunk",
                            id: fileSelection.id,
                            staged: fileSelection.staged,
                            index: row.index,
                            token: hunkToken,
                            page,
                          })
                        }
                      >
                        {staged ? <Minus size={13} /> : <Plus size={13} />}
                        {t(staged ? "unstageHunk" : "stageHunk")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ height: viewport.after }} aria-hidden="true" />
          </div>
        )}
        {!showImages && diff?.truncated && (
          <div className="diff-limit">
            {t("truncatedDiff")}
            {(page < maxDiffPage || pending) && (
              <button type="button" className="plain-button" disabled={pending} onClick={loadMore}>
                {t(pending ? "loadingDiff" : "loadMoreDiff")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="review-footer">
        <span className={`footer-dot${staged ? " staged-dot" : ""}`} />
        {selection?.kind === "file" || selection?.kind === "changes"
          ? t(staged ? "stagedChanges" : "workingTree")
          : selection?.kind === "commit"
            ? t("commitDiff")
            : t("diffLayout")}
        <span className="footer-separator" />
        {showImages
          ? t("imagePreviews", { count: images.length })
          : t(hunkCount === 1 ? "oneHunk" : "hunks", { count: hunkCount })}
        <span className="footer-spacer" />
        {t(showImages ? "imagePreview" : split ? "splitView" : "unifiedView")}
      </div>
    </main>
  );
}
