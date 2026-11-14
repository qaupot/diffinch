import { type MouseEvent } from "react";
import { useTranslation } from "./i18n";
import { type MessageKey } from "./i18n/messages";
import { FileCode2, FileText, FolderGit2, Minus, Plus } from "./icons";
import { basename, dirname, type FileChange } from "./lib/git";

const statusLabel: Partial<Record<string, MessageKey>> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typeChanged",
  "?": "untracked",
  U: "conflict",
};

export default function FileRow({
  file,
  inIndex,
  selected,
  preview,
  busy,
  onSelect,
  onStage,
}: {
  file: FileChange;
  inIndex: boolean;
  selected: boolean;
  preview: boolean;
  busy: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  onStage: () => void;
}) {
  const { t } = useTranslation();
  const code = file.conflict ? "U" : inIndex ? file.index : file.worktree;
  const base = basename(file.path);
  const folder = dirname(file.path);
  const label = statusLabel[code];
  const status = label ? t(label) : undefined;
  const stageLabel = t(inIndex ? "unstageFile" : "stageFile", { name: base });
  const Icon = file.submodule
    ? FolderGit2
    : /\.(?:tsx?|jsx?|css|json|rs)$/.test(base)
      ? FileCode2
      : FileText;
  return (
    <div className={`file-row${selected ? " selected" : ""}${preview ? " preview" : ""}`}>
      <button
        className="file-select"
        onClick={onSelect}
        aria-pressed={selected}
        title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
      >
        <Icon className="file-icon" size={17} />
        <span className="file-names">
          <span className="truncate file-name">{base}</span>
          {(folder || file.submodule) && (
            <span className="truncate file-path">
              {file.submodule ? t("submoduleLabel") : folder}
            </span>
          )}
        </span>
        <span
          className={`file-status code-${code === "?" ? "untracked" : code}`}
          title={status}
          aria-label={status}
        >
          {code === "?" ? "U" : code}
        </span>
      </button>
      <button
        className="file-stage"
        disabled={busy}
        onClick={onStage}
        title={stageLabel}
        aria-label={stageLabel}
      >
        {inIndex ? <Minus size={14} /> : <Plus size={14} />}
      </button>
    </div>
  );
}
