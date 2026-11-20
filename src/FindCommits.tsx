import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "./i18n";
import { ArrowDown, ArrowUp, GitCommitHorizontal, Search, X } from "./icons";
import { commitAuthor } from "./lib/commits";
import type { SearchCommit, Snapshot } from "./lib/git";
import { isComposing } from "./lib/keyboard";
import { useCommitSearch } from "./useCommitSearch";

export default function FindCommits({
  id,
  repo,
  request,
  searchInput,
  selected,
  onSelect,
  initialQuery = "",
}: {
  id: string;
  repo: Snapshot;
  request: number;
  searchInput: RefObject<HTMLInputElement | null>;
  selected: SearchCommit | null;
  onSelect: (commit: SearchCommit | null) => void;
  initialQuery?: string;
}) {
  const { t, dateTime } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const [matchCase, setMatchCase] = useState(false);
  const [composing, setComposing] = useState(false);
  const { result, error, pending } = useCommitSearch(repo, query, matchCase, composing, onSelect);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const resultList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [request, searchInput]);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  function nextMatch(direction: number, focus = false) {
    if (!result?.commits.length) return;
    const index = result.commits.findIndex(({ id }) => id === selected?.id);
    const next = (index + direction + result.commits.length) % result.commits.length;
    onSelect(result.commits[next]);
    if (focus) resultList.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  return (
    <section id={id} className="inspector find-inspector" aria-label={t("findCommits")}>
      <div className="inspector-heading">
        <div>
          <h2>{t("findCommits")}</h2>
          <p>{t("searchRepositoryHistory")}</p>
        </div>
        <Search size={18} />
      </div>
      <div className="find-form">
        <div className="search-box">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            placeholder={t("searchCommitsPlaceholder")}
            aria-label={t("findCommit")}
            aria-describedby={`${id}-search-hint`}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (isComposing(event.nativeEvent)) {
                if (event.key === "Enter") event.preventDefault();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
              }
              if (event.key === "Enter" && result) {
                event.preventDefault();
                nextMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="icon-button"
              aria-label={t("clearSearch")}
              title={t("clearSearch")}
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="find-options">
          <p id={`${id}-search-hint`} className="muted">
            {t("searchCommitsHint")}
          </p>
          <label className="check-line">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => setMatchCase(event.target.checked)}
            />
            {t("matchCase")}
          </label>
        </div>
      </div>
      <div className="find-status" role="status" aria-live="polite">
        <span>
          {result
            ? t(
                result.hasMore
                  ? "searchMoreMatches"
                  : result.commits.length === 1
                    ? "oneMatch"
                    : "matches",
                { count: result.commits.length },
              )
            : t(pending ? "searchingCommits" : "searchStartHint")}
        </span>
        {!!result?.commits.length && (
          <div>
            <button
              className="icon-button"
              title={t("previousMatch")}
              aria-label={t("previousMatch")}
              onClick={() => nextMatch(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-button"
              title={t("nextMatch")}
              aria-label={t("nextMatch")}
              onClick={() => nextMatch(1)}
            >
              <ArrowDown size={14} />
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="modal-error find-error" role="alert">
          {t(error.key, error.values)}
        </p>
      )}
      <div
        className="find-results"
        ref={resultList}
        aria-label={t("searchResults")}
        aria-busy={pending}
      >
        {result?.commits.map((commit) => (
          <button
            type="button"
            key={commit.id}
            ref={selected?.id === commit.id ? selectedRow : undefined}
            className="find-result"
            aria-pressed={selected?.id === commit.id}
            onClick={() => onSelect(commit)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                nextMatch(event.key === "ArrowDown" ? 1 : -1, true);
              }
            }}
          >
            <span className="find-result-title">
              <GitCommitHorizontal size={15} />
              <strong>{commit.subject || t("noSubject")}</strong>
            </span>
            {commit.description && (
              <span className="find-result-description">{commit.description}</span>
            )}
            <span className="find-result-meta">
              <code>{commit.shortId}</code>
              <span className="truncate" title={commitAuthor(commit)}>
                {commitAuthor(commit)}
              </span>
              <time dateTime={commit.date}>{dateTime(commit.date)}</time>
            </span>
          </button>
        ))}
        {result && !result.commits.length && (
          <div className="graph-empty">
            <Search size={24} />
            <strong>{t("noSearchResults")}</strong>
            <p>{t("searchNoResultsHint")}</p>
          </div>
        )}
      </div>
      {selected && (
        <section className="commit-message" aria-label={t("commitDescription")}>
          <strong>{selected.subject || t("noSubject")}</strong>
          <code>{selected.id}</code>
          <span>
            {selected.author}
            {selected.email && ` <${selected.email}>`}
          </span>
          {selected.references && <span className="muted">{selected.references}</span>}
          {selected.description && <p>{selected.description}</p>}
        </section>
      )}
    </section>
  );
}
