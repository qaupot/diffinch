import { useMemo, useState } from "react";
import DiffView from "./DiffView";
import { useTranslation } from "./i18n";
import { basename, type Action, type BlameLine, type FileRevision } from "./lib/git";
import { readEditor } from "./lib/external-tools";
import { useVirtualRows } from "./lib/virtual";
import { useFileInspection } from "./useFileInspection";
import OperationProgress from "./workspace/OperationProgress";

export default function FileHistoryView({
  path,
  head,
  initialFile,
  busy,
  split,
  setSplit,
  action,
  onTools,
  onCommit,
}: {
  path: string;
  head: string | null;
  initialFile?: string;
  busy: boolean;
  split: boolean;
  setSplit: (value: boolean) => void;
  action: (next: Action) => Promise<void>;
  onTools: () => void;
  onCommit: (line: BlameLine) => void;
}) {
  const { t, dateTime } = useTranslation();
  const [revisionInput, setRevisionInput] = useState("HEAD");
  const [revision, setRevision] = useState<string | null>(null);
  const [input, setInput] = useState(initialFile ?? "");
  const [file, setFile] = useState(initialFile ?? "");
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = useFileInspection<"catalog">(
    path,
    head ? { kind: "catalog", revision: revision ?? head } : null,
  );
  const history = useFileInspection<"history">(
    path,
    file && catalog.data
      ? {
          kind: "history",
          revision: catalog.data.revision,
          file,
          limit,
        }
      : null,
  );
  const files = useMemo(
    () =>
      (catalog.data?.files ?? []).filter((file) =>
        file.toLowerCase().includes(input.toLowerCase()),
      ),
    [catalog.data, input],
  );
  const rows = useVirtualRows(files.length, 32);
  const commits = history.data?.commits ?? [];
  const current = commits.find((commit) => commit.id === selected) ?? commits[0];
  function chooseFile(next: string) {
    setFile(next);
    setInput(next);
    setLimit(100);
    setSelected(null);
  }
  return (
    <section className="file-history-view" aria-label={t("fileHistory")}>
      <header className="file-history-header">
        <div>
          <h1>{t("fileHistory")}</h1>
          <p className="muted">{t("fileHistoryHelp")}</p>
        </div>
        <button type="button" className="plain-button" onClick={onTools}>
          {t("externalTools")}
        </button>
      </header>
      <form
        className="file-history-search"
        onSubmit={(event) => {
          event.preventDefault();
          setRevision(revisionInput.trim() || "HEAD");
          catalog.retry();
          chooseFile(input);
        }}
      >
        <label>
          {t("fileHistoryRevision")}
          <input value={revisionInput} onChange={(event) => setRevisionInput(event.target.value)} />
        </label>
        <label>
          {t("historyPath")}
          <input value={input} onChange={(event) => setInput(event.target.value)} />
        </label>
        <button className="plain-button" disabled={busy || !head}>
          {t("browseFileHistory")}
        </button>
      </form>
      <OperationProgress activity={catalog.activity} />
      {!head && <p className="muted">{t("noCommits")}</p>}
      {catalog.error && (
        <p className="tool-error" role="alert">
          {t(catalog.error.key, catalog.error.values)}{" "}
          <button onClick={catalog.retry}>{t("retryFileInspection")}</button>
        </p>
      )}
      <div className="file-history-columns">
        <aside className="file-catalog">
          <h2>{t("committedFiles")}</h2>
          <div className="file-catalog-list" ref={rows.ref} onScroll={rows.measure}>
            <div style={{ height: rows.before }} aria-hidden="true" />
            {files.slice(rows.start, rows.end).map((name) => (
              <button
                type="button"
                data-virtual-row
                key={name}
                className={file === name ? "selected" : ""}
                aria-pressed={file === name}
                title={name}
                onClick={() => chooseFile(name)}
              >
                {name}
              </button>
            ))}
            <div style={{ height: rows.after }} aria-hidden="true" />
          </div>
        </aside>
        <aside className="file-revisions">
          <h2 title={file}>{file ? basename(file) : t("fileHistory")}</h2>
          {file && (
            <button
              type="button"
              className="plain-button"
              disabled={busy}
              onClick={() => void action({ kind: "openEditor", file, editor: readEditor() })}
            >
              {t("openInEditor")}
            </button>
          )}
          <OperationProgress activity={history.activity} />
          {history.error && (
            <p role="alert">
              {t(history.error.key, history.error.values)}{" "}
              <button onClick={history.retry}>{t("retryFileInspection")}</button>
            </p>
          )}
          {history.data && !commits.length && <p>{t("noFileHistory")}</p>}
          <div className="file-revisions-list">
            {commits.map((commit) => (
              <button
                type="button"
                key={commit.id}
                aria-pressed={current?.id === commit.id}
                className={current?.id === commit.id ? "selected" : ""}
                onClick={() => setSelected(commit.id)}
              >
                <strong>{commit.subject}</strong>
                <small>
                  {commit.shortId} · {commit.author}
                </small>
                <small>{dateTime(commit.date)}</small>
                {commit.previousPath && (
                  <small>
                    {commit.previousPath} → {commit.path}
                  </small>
                )}
              </button>
            ))}
            {history.data?.hasMore &&
              (limit < 2000 ? (
                <button
                  className="plain-button"
                  disabled={history.pending}
                  onClick={() => setLimit((value) => Math.min(2000, value + 100))}
                >
                  {t("loadFileHistory")}
                </button>
              ) : (
                <p>{t("fileHistoryLimit")}</p>
              ))}
          </div>
        </aside>
        {current ? (
          <FileRevisionDetails
            key={`${current.id}:${current.path}`}
            path={path}
            revision={current}
            split={split}
            setSplit={setSplit}
            onCommit={onCommit}
          />
        ) : (
          <div className="file-history-empty" />
        )}
      </div>
    </section>
  );
}

function FileRevisionDetails({
  path,
  revision,
  split,
  setSplit,
  onCommit,
}: {
  path: string;
  revision: FileRevision;
  split: boolean;
  setSplit: (value: boolean) => void;
  onCommit: (line: BlameLine) => void;
}) {
  const { t, dateTime } = useTranslation();
  const [mode, setMode] = useState<"diff" | "blame">("diff");
  const [page, setPage] = useState(0);
  const [diffPage, setDiffPage] = useState(0);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const diff = useFileInspection<"diff">(
    path,
    mode === "diff"
      ? {
          kind: "diff",
          revision: revision.id,
          file: revision.path,
          previousPath: revision.previousPath,
          options: { page: diffPage, ignoreWhitespace },
        }
      : null,
  );
  const blame = useFileInspection<"blame">(
    path,
    mode === "blame" && !revision.deleted
      ? {
          kind: "blame",
          revision: revision.id,
          file: revision.path,
          page,
        }
      : null,
    "loadingBlame",
  );
  return (
    <section className="file-revision-details">
      <div className="file-revision-tabs segmented">
        <button aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>
          {t("filePatch")}
        </button>
        <button
          aria-pressed={mode === "blame"}
          disabled={revision.deleted}
          onClick={() => setMode("blame")}
        >
          {t("blame")}
        </button>
      </div>
      {revision.deleted && <p className="muted">{t("fileDeletedAtRevision")}</p>}
      <OperationProgress activity={mode === "diff" ? diff.activity : blame.activity} />
      {mode === "diff" && diff.error && (
        <button className="plain-button" onClick={diff.retry}>
          {t("retryFileInspection")}
        </button>
      )}
      {mode === "diff" ? (
        <DiffView
          title={revision.path}
          subtitle={`${revision.shortId} · ${revision.subject}`}
          diff={diff.data ?? null}
          pending={diff.pending}
          error={diff.error ?? null}
          split={split}
          setSplit={setSplit}
          busy={false}
          selection={{ kind: "commit", id: revision.id }}
          page={diffPage}
          loadMore={() => setDiffPage((value) => value + 1)}
          ignoreWhitespace={ignoreWhitespace}
          setIgnoreWhitespace={(value) => {
            setIgnoreWhitespace(value);
            setDiffPage(0);
          }}
        />
      ) : (
        <>
          {blame.error && (
            <p className="tool-error" role="alert">
              {t(blame.error.key, blame.error.values)}{" "}
              <button onClick={blame.retry}>{t("retryFileInspection")}</button>
            </p>
          )}
          {blame.data && (
            <>
              <div className="blame-pagination">
                <button
                  className="plain-button"
                  disabled={!page || blame.pending}
                  onClick={() => setPage(page - 1)}
                >
                  {t("previousBlamePage")}
                </button>
                <span>
                  {t("blamePage", {
                    start: blame.data.lines[0]?.line ?? 0,
                    end: blame.data.lines.at(-1)?.line ?? 0,
                    total: blame.data.totalLines,
                  })}
                </span>
                <button
                  className="plain-button"
                  disabled={!blame.data.hasMore || blame.pending}
                  onClick={() => setPage(page + 1)}
                >
                  {t("nextBlamePage")}
                </button>
              </div>
              <div className="blame-scroll">
                <table className="blame-table" aria-label={t("blame")}>
                  <tbody>
                    {blame.data.lines.map((line) => (
                      <tr key={line.line}>
                        <td>
                          <button
                            className="text-button"
                            title={`${line.summary}\n${line.author} <${line.email}>\n${dateTime(new Date(line.timestamp * 1000).toISOString())}\n${line.id}`}
                            onClick={() => onCommit(line)}
                          >
                            {line.id.slice(0, 8)}
                          </button>
                          <span>{line.author}</span>
                        </td>
                        <td className="blame-line-number">{line.line}</td>
                        <td>
                          <pre>{line.text || " "}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
