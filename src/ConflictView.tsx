import { useEffect, useMemo, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import { GitMerge } from "./icons";
import { git, type Action, type Conflict, type FileChange } from "./lib/git";

function conflictSections(text: string, markerSize: number) {
  const sections = [];
  const blocks = new Map<
    number,
    {
      start: number;
      currentStart: number;
      base?: number;
      separator?: { start: number; end: number };
    } | null
  >();
  for (const match of text.matchAll(/^(<+|\|+|=+|>+)( [^\r\n]*)?\r?(?:\n|$)/gm)) {
    const marker = match[1];
    const width = marker.length;
    if (width < markerSize) continue;
    const start = match.index;
    const end = start + match[0].length;
    const block = blocks.get(width);
    if (marker[0] === "<") {
      blocks.set(width, block === undefined ? { start, currentStart: end } : null);
    } else if (marker[0] === ">") {
      if (block?.separator) {
        sections.push({
          start: block.start,
          end,
          current: text.slice(block.currentStart, block.base ?? block.separator.start),
          incoming: text.slice(block.separator.end, start),
        });
      }
      blocks.delete(width);
    } else if (block && marker[0] === "|") {
      if (block.base !== undefined || block.separator) blocks.set(width, null);
      else block.base = start;
    } else if (block && marker[0] === "=" && !match[2]) {
      if (block.separator) blocks.set(width, null);
      else block.separator = { start, end };
    }
  }

  // A literal marker of another width can occur inside either side. If two
  // complete interpretations overlap, leave both for manual resolution.
  let previousEnd = 0;
  return sections
    .sort((a, b) => a.start - b.start)
    .filter((section, index, all) => {
      const separate =
        previousEnd <= section.start && section.end <= (all[index + 1]?.start ?? Infinity);
      previousEnd = Math.max(previousEnd, section.end);
      return separate;
    });
}

export default function ConflictView({
  path,
  file,
  busy,
  action,
  onEditor,
  onTools,
}: {
  path: string;
  file: FileChange;
  busy: boolean;
  action: (action: Action) => Promise<void>;
  onEditor: () => void;
  onTools: () => void;
}) {
  const { t } = useTranslation();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [revision, reload] = useState(0);
  const markerSize = conflict?.markerSize ?? 7;
  const sections = useMemo(() => conflictSections(result, markerSize), [result, markerSize]);
  // A standalone separator can be a Markdown heading, not a conflict marker.
  const hasMarkers = new RegExp(
    /^(?:<{7,}|\|{7,}|>{7,})(?: |\r?$)/.source.replaceAll("{7,}", `{${markerSize},}`),
    "m",
  ).test(result);
  useEffect(() => {
    let active = true;
    git
      .conflict(path, file.id)
      .then((conflict) => {
        if (!active) return;
        setConflict(conflict);
        setResult(conflict.result);
      })
      .catch((error: unknown) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [path, file.id, revision]);

  function refresh() {
    setConflict(null);
    setError(null);
    reload((revision) => revision + 1);
  }

  return (
    <main className="review conflict-review">
      <div className="review-header">
        <div className="review-heading">
          <span className="file-tile">
            <GitMerge size={20} />
          </span>
          <div className="truncate">
            <h1>{t("resolveConflictTitle")}</h1>
            <p title={file.path} className="truncate">
              {file.path}
            </p>
          </div>
        </div>
        <button className="plain-button" disabled={busy || (!conflict && !error)} onClick={refresh}>
          {t("reloadConflict")}
        </button>
      </div>
      <div className="review-scroll">
        <div className="conflict-external-tools">
          <button
            className="plain-button"
            disabled={busy || (!!conflict && result !== conflict.result)}
            onClick={onEditor}
          >
            {t("openInEditor")}
          </button>
          <button
            className="plain-button"
            disabled={busy || (!!conflict && result !== conflict.result)}
            onClick={() => void action({ kind: "mergeTool", id: file.id }).then(refresh)}
          >
            {t("openInMergeTool")}
          </button>
          <button className="plain-button" onClick={onTools}>
            {t("externalTools")}
          </button>
          {conflict && result !== conflict.result && (
            <p role="status">{t("mergeToolDraftWarning")}</p>
          )}
        </div>
        {error ? (
          <p role="alert">{t(error.key, error.values)}</p>
        ) : !conflict ? (
          <p role="status">{t("working")}</p>
        ) : (
          <>
            <div className="conflict-sides">
              {(["base", "current", "incoming"] as const).map((side) => (
                <details key={side} open>
                  <summary>
                    {t(
                      side === "base"
                        ? "compareBase"
                        : side === "current"
                          ? "conflictCurrent"
                          : "conflictIncoming",
                    )}
                  </summary>
                  <pre>{conflict[side] ?? t("conflictMissingSide")}</pre>
                </details>
              ))}
            </div>
            {sections.length > 0 && (
              <ol className="conflict-sections" aria-label={t("conflictingSections")}>
                {sections.map((section, index) => (
                  <li key={section.start}>
                    <span>{t("conflictSection", { count: index + 1 })}</span>
                    {(["current", "incoming"] as const).map((side) => (
                      <button
                        type="button"
                        key={side}
                        className="plain-button"
                        disabled={busy}
                        onClick={() =>
                          setResult(
                            result.slice(0, section.start) +
                              section[side] +
                              result.slice(section.end),
                          )
                        }
                      >
                        {t(side === "current" ? "acceptCurrent" : "acceptIncoming")}
                      </button>
                    ))}
                  </li>
                ))}
              </ol>
            )}
            <label className="conflict-result">
              <span>{t("conflictResult")}</span>
              <textarea
                spellCheck={false}
                value={result}
                disabled={busy}
                onChange={(event) => {
                  const input = event.target.value;
                  setResult(
                    conflict.result.includes("\r\n") &&
                      !conflict.result.replaceAll("\r\n", "").includes("\n")
                      ? input.replaceAll("\n", "\r\n")
                      : input,
                  );
                }}
              />
            </label>
            <div className="conflict-actions">
              {hasMarkers && <span role="status">{t("unresolvedConflict")}</span>}
              <button
                className="primary-button"
                disabled={busy || hasMarkers}
                onClick={() =>
                  void action({
                    kind: "resolveConflict",
                    id: file.id,
                    token: conflict.token,
                    text: result,
                  })
                }
              >
                {t("saveAndStage")}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
