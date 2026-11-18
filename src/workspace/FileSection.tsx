import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import FileRow from "../FileRow";
import { useTranslation } from "../i18n";
import { ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal } from "../icons";
import { canDiscard, mac, shortcut, type Action, type FileChange } from "../lib/git";
import { selectFile } from "./selection";
import type { WorkspaceSelection } from "./types";

export default function FileSection({
  id,
  kind,
  files,
  expanded,
  onToggle,
  query,
  selection,
  onSelect,
  onDiscard,
  busy,
  inFlight,
  action,
}: {
  id: string;
  kind: "unstaged" | "staged";
  files: FileChange[];
  expanded: boolean;
  onToggle: () => void;
  query: string;
  selection: WorkspaceSelection | null;
  onSelect: (selection: WorkspaceSelection) => void;
  onDiscard?: (file: FileChange) => void;
  busy: boolean;
  inFlight: RefObject<boolean>;
  action: (action: Action) => Promise<void>;
}) {
  const { t } = useTranslation();
  const fileCursorToReveal = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    fileCursorToReveal.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    fileCursorToReveal.current = null;
  }, [selection]);
  const inIndex = kind === "staged";
  const filtered = expanded
    ? files.filter((item) => item.path.toLowerCase().includes(query.toLowerCase()))
    : [];
  const current = selection?.kind === "file" && selection.staged === inIndex ? selection : null;
  const visibleIds = filtered.map((item) => item.id);
  const selectedIds = visibleIds.filter((id) => current?.ids.has(id));
  const applyLabel = t(inIndex ? "unstageSelectedFiles" : "stageSelectedFiles", {
    count: selectedIds.length,
  });
  const applyShortcut = `${shortcut}⇧↵`;

  function select(id: string, extend = false, toggle = false) {
    const anchor = current?.anchor ?? id;
    const start = visibleIds.indexOf(anchor);
    if (extend && start >= 0) {
      const end = visibleIds.indexOf(id);
      const range = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      onSelect(
        selectFile(
          id,
          inIndex,
          new Set(toggle ? [...(current?.ids ?? []), ...range] : range),
          anchor,
        ),
      );
    } else if (toggle) {
      const ids = new Set(current?.ids);
      if (ids.delete(id)) {
        const preview =
          current && ids.has(current.id)
            ? current.id
            : (visibleIds.find((candidate) => ids.has(candidate)) ??
              ids.values().next().value ??
              id);
        onSelect(selectFile(preview, inIndex, ids, id));
      } else {
        ids.add(id);
        onSelect(selectFile(id, inIndex, ids));
      }
    } else {
      onSelect(selectFile(id, inIndex));
    }
  }

  function applySelected(group: HTMLElement | null) {
    if (busy || inFlight.current || !selectedIds.length) return;
    group?.querySelector<HTMLButtonElement>(".group-toggle")?.focus();
    if (selectedIds.length === 1)
      void action({ kind: inIndex ? "unstage" : "stage", id: selectedIds[0] });
    else void action({ kind: inIndex ? "unstageFiles" : "stageFiles", ids: selectedIds });
  }

  function handleKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (!visibleIds.length || event.altKey || event.nativeEvent.isComposing) return;
    const modifier = mac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "a" && !event.shiftKey) {
      event.preventDefault();
      const id = current && visibleIds.includes(current.id) ? current.id : visibleIds[0];
      onSelect(selectFile(id, inIndex, new Set(visibleIds)));
    } else if (modifier && event.shiftKey && key === "enter") {
      event.preventDefault();
      if (!event.repeat) applySelected(event.currentTarget);
    } else if (key === "escape" && selectedIds.length) {
      event.preventDefault();
      if (current) onSelect(selectFile(current.id, inIndex, new Set()));
    } else if (key === "arrowup" || key === "arrowdown" || key === " ") {
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".file-row"));
      const target = event.target as HTMLElement;
      const index = rows.findIndex((row) => row.contains(target));
      if (key === " ") {
        if (index < 0 || !target.matches(".file-select")) return;
        event.preventDefault();
        if (!event.repeat) select(visibleIds[index], event.shiftKey, true);
      } else {
        event.preventDefault();
        const step = key === "arrowdown" ? 1 : -1;
        const next =
          index < 0 && step < 0
            ? rows.length - 1
            : Math.min(Math.max(index + step, 0), rows.length - 1);
        const row = rows[next];
        row?.querySelector<HTMLButtonElement>(".file-select")?.focus({ preventScroll: true });
        if (!modifier || event.shiftKey) {
          fileCursorToReveal.current = row;
          select(visibleIds[next], event.shiftKey, modifier);
        } else {
          row?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    }
  }

  return (
    <section
      id={id}
      className={`file-group scope-${kind}`}
      data-expanded={expanded}
      data-empty={!filtered.length}
      aria-label={t(inIndex ? "stagedFiles" : "unstagedFiles")}
      onKeyDown={handleKey}
    >
      <header className="group-header">
        <button className="group-toggle" aria-expanded={expanded} onClick={() => onToggle()}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {inIndex ? <GitCommitHorizontal size={15} /> : <FileCode2 size={15} />}
          <span>{t(kind)}</span>
          <span className="group-count">{files.length}</span>
        </button>
        <div className="group-actions">
          {selectedIds.length > 1 && (
            <button
              className="text-button"
              disabled={busy}
              onClick={(event) => applySelected(event.currentTarget.closest("section"))}
              title={t("shortcutLabel", { label: applyLabel, shortcut: applyShortcut })}
              aria-keyshortcuts={mac ? "Meta+Shift+Enter" : "Control+Shift+Enter"}
            >
              {applyLabel}
            </button>
          )}
          <button
            className="text-button"
            disabled={busy || !files.length}
            onClick={() => action({ kind: inIndex ? "unstageAll" : "stageAll" })}
          >
            {t(inIndex ? "unstageAll" : "stageAll")}
          </button>
        </div>
      </header>
      {expanded && (
        <div className="file-group-content">
          {filtered.length ? (
            filtered.map((item) => (
              <FileRow
                key={item.id}
                file={item}
                inIndex={inIndex}
                selected={current?.ids.has(item.id) ?? false}
                preview={current?.id === item.id}
                busy={busy}
                onSelect={(event) => {
                  event.currentTarget.focus();
                  select(item.id, event.shiftKey, mac ? event.metaKey : event.ctrlKey);
                }}
                onStage={() => action({ kind: inIndex ? "unstage" : "stage", id: item.id })}
                onDiscard={onDiscard && canDiscard(item) ? () => onDiscard(item) : undefined}
              />
            ))
          ) : (
            <p className="empty-list">
              {query ? t("noMatchingFiles") : inIndex ? t("noStagedChanges") : t("cleanWorktree")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
