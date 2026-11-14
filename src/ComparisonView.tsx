import { useEffect, useId, useState, type FormEvent } from "react";
import DiffView from "./DiffView";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import { basename, git, type Comparison, type Diff, type Snapshot } from "./lib/git";
import { useVirtualRows } from "./lib/virtual";

export default function ComparisonView({
  repo,
  split,
  setSplit,
  revision,
}: {
  repo: Snapshot;
  split: boolean;
  setSplit: (split: boolean) => void;
  revision: number;
}) {
  const { t } = useTranslation();
  const refsId = useId();
  const [base, setBase] = useState(repo.status.upstream ?? "");
  const [target, setTarget] = useState("HEAD");
  const [fromMergeBase, setFromMergeBase] = useState(true);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareError, setCompareError] = useState<LocalizedMessage | null>(null);
  const [comparing, setComparing] = useState(false);
  const [selected, setSelected] = useState(0);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState<{
    diff: Diff | null;
    error: LocalizedMessage | null;
    key: string;
    selection: string;
  } | null>(null);
  const files = comparison?.files ?? [];
  const current = files[selected];
  const rows = useVirtualRows(files.length, 36);
  const selectionKey = JSON.stringify([
    comparison?.base,
    comparison?.target,
    current?.id,
    ignoreWhitespace,
  ]);
  const key = JSON.stringify([selectionKey, page]);
  const display = loaded?.key === key ? loaded : null;
  const entry = current?.id;
  const path = repo.path;
  const imageRevision = loaded?.diff?.images?.length ? revision : 0;

  useEffect(() => {
    if (!comparison || !entry) return;
    let current = true;
    git.compareFile(path, comparison, entry, { page, ignoreWhitespace }).then(
      (diff) => {
        if (current) setLoaded({ diff, error: null, key, selection: selectionKey });
      },
      (error: unknown) => {
        if (current)
          setLoaded({ diff: null, error: errorMessage(error), key, selection: selectionKey });
      },
    );
    return () => {
      current = false;
    };
  }, [comparison, entry, path, page, ignoreWhitespace, key, selectionKey, imageRevision]);

  async function compare(event: FormEvent) {
    event.preventDefault();
    if (!base.trim() || !target.trim() || comparing) return;
    setComparing(true);
    setCompareError(null);
    try {
      const next = await git.compare(path, base.trim(), target.trim(), fromMergeBase);
      setComparison(next);
      setSelected(0);
      setPage(0);
      setLoaded(null);
      rows.ref.current?.scrollTo(0, 0);
    } catch (error) {
      setCompareError(errorMessage(error));
    } finally {
      setComparing(false);
    }
  }

  return (
    <div className="comparison">
      <form className="compare-form" onSubmit={compare}>
        <label>
          {t("compareBase")}
          <input
            list={refsId}
            required
            value={base}
            onChange={(event) => setBase(event.target.value)}
          />
        </label>
        <label>
          {t("compareTarget")}
          <input
            list={refsId}
            required
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <datalist id={refsId}>
          <option value="HEAD" />
          {repo.branches.map((branch) => (
            <option
              key={branch.name + branch.remote}
              value={`refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`}
            />
          ))}
          {repo.tags.map((tag) => (
            <option key={tag.name} value={`refs/tags/${tag.name}`} />
          ))}
        </datalist>
        <label className="check-line">
          <input
            type="checkbox"
            checked={fromMergeBase}
            onChange={(event) => setFromMergeBase(event.target.checked)}
          />
          {t("compareMergeBase")}
        </label>
        <button className="primary-button" disabled={comparing}>
          {t(comparing ? "working" : "compare")}
        </button>
      </form>
      {compareError && (
        <p className="compare-error" role="alert">
          {t(compareError.key, compareError.values)}
        </p>
      )}
      {comparison && (
        <p className="compare-summary">
          <code>
            {comparison.base.slice(0, 12)} → {comparison.target.slice(0, 12)}
          </code>
          <span>
            {t(files.length === 1 ? "oneFileChanged" : "filesChanged", { count: files.length })}
          </span>
        </p>
      )}
      <div className="comparison-panes">
        <div
          className="compare-files"
          ref={rows.ref}
          onScroll={rows.measure}
          aria-label={t("comparisonFiles")}
        >
          <div style={{ height: rows.before }} aria-hidden="true" />
          {files.slice(rows.start, rows.end).map((file, offset) => {
            const index = rows.start + offset;
            return (
              <button
                data-virtual-row
                className="compare-file"
                key={file.id}
                aria-pressed={selected === index}
                title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
                onClick={() => {
                  setSelected(index);
                  setPage(0);
                }}
              >
                <span className="truncate">{file.path}</span>
                {file.additions === null || file.deletions === null ? (
                  <small>{t("binaryFile")}</small>
                ) : (
                  <>
                    <small className="positive">+{file.additions}</small>
                    <small className="negative">−{file.deletions}</small>
                  </>
                )}
              </button>
            );
          })}
          <div style={{ height: rows.after }} aria-hidden="true" />
        </div>
        <DiffView
          title={current ? basename(current.path) : t("compare")}
          subtitle={
            current?.originalPath ? `${current.originalPath} → ${current.path}` : current?.path
          }
          diff={loaded?.selection === selectionKey ? loaded.diff : null}
          error={display?.error ?? null}
          pending={!!current && !display}
          busy={comparing}
          selection={current ? { kind: "commit", id: current.id } : null}
          split={split}
          setSplit={setSplit}
          page={page}
          loadMore={() => setPage((page) => page + 1)}
          ignoreWhitespace={ignoreWhitespace}
          setIgnoreWhitespace={(value) => {
            setIgnoreWhitespace(value);
            setPage(0);
          }}
        />
      </div>
    </div>
  );
}
