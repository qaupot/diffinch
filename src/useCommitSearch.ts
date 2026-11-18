import { useEffect, useEffectEvent, useState } from "react";
import { errorMessage, type LocalizedMessage } from "./i18n";
import { git, type CommitSearch, type SearchCommit, type Snapshot } from "./lib/git";

function searchDemo(repo: Snapshot, query: string, matchCase: boolean): CommitSearch {
  const needle = matchCase ? query : query.toLowerCase();
  const commits = repo.commits
    .map((commit): SearchCommit => ({
      ...commit,
      description: commit.description ?? "",
      references: [
        repo.status.head === commit.id ? "HEAD" : "",
        ...repo.branches.filter(({ tip }) => tip === commit.id).map(({ name }) => name),
        ...repo.tags.filter(({ tip }) => tip === commit.id).map(({ name }) => name),
        ...repo.stashes.filter(({ tip }) => tip === commit.id).map(({ id }) => id),
      ]
        .filter(Boolean)
        .join(", "),
    }))
    .filter((commit) =>
      [
        commit.subject,
        commit.description,
        commit.id,
        commit.author,
        commit.email,
        commit.references,
      ].some((value) => (matchCase ? value : value.toLowerCase()).includes(needle)),
    );
  return { commits: commits.slice(0, 200), hasMore: commits.length > 200 };
}

export function useCommitSearch(
  repo: Snapshot,
  query: string,
  matchCase: boolean,
  composing: boolean,
  onSelect: (commit: SearchCommit | null) => void,
) {
  const [result, setResult] = useState<CommitSearch | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [pending, setPending] = useState(false);
  // Ref changes can add matches or change reference labels. Working-tree edits
  // should not restart a full-history scan or clear the selected result.
  const historyKey = JSON.stringify([
    repo.status.head,
    repo.status.branch,
    repo.branches.map(({ name, remote, tip }) => [name, remote, tip]),
    repo.tags.map(({ name, tip }) => [name, tip]),
    repo.stashes.map(({ id, tip }) => [id, tip]),
  ]);
  const select = useEffectEvent(onSelect);
  const search = useEffectEvent((text: string, caseSensitive: boolean, signal: AbortSignal) =>
    repo.path
      ? git.searchCommits(repo.path, text, "all", caseSensitive, signal)
      : searchDemo(repo, text, caseSensitive),
  );

  useEffect(() => {
    setResult(null);
    setError(null);
    select(null);
    const text = query.trim();
    setPending(!!text && !composing);
    if (!text || composing) return;

    const controller = new AbortController();
    const { signal } = controller;
    const timer = window.setTimeout(async () => {
      try {
        const next = await search(text, matchCase, signal);
        if (signal.aborted) return;
        setResult(next);
        select(next.commits[0] ?? null);
      } catch (error) {
        if (!signal.aborted) setError(errorMessage(error));
      } finally {
        if (!signal.aborted) setPending(false);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [repo.path, historyKey, query, matchCase, composing]);

  return { result, error, pending };
}
