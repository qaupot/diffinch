import { useTranslation } from "./i18n";
import { FolderGit2, X } from "./icons";
import type { Worktree } from "./lib/git";

export default function WorktreesView({
  worktrees,
  busy,
  onOpen,
  onRemove,
}: {
  worktrees: Worktree[];
  busy: boolean;
  onOpen: (path: string) => void;
  onRemove: (worktree: Worktree) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="details-list">
      {worktrees.map((item) => (
        <div className="detail-row worktree-row" key={item.path}>
          <span className="file-tile">
            <FolderGit2 size={17} />
          </span>
          <div className="detail-description">
            <strong>{item.bare ? t("bareRepository") : (item.branch ?? t("detachedHead"))}</strong>
            <small className="worktree-path">{item.path}</small>
            <small className="worktree-state">
              {item.head && <code>{item.head.slice(0, 8)}</code>}
              {item.main && <span>{t("mainWorktree")}</span>}
              {item.current && <span>{t("currentWorktree")}</span>}
              {item.locked !== null && (
                <span title={item.locked}>
                  {t("lockedWorktree")}
                  {item.locked && `: ${item.locked}`}
                </span>
              )}
              {item.prunable !== null && <span title={item.prunable}>{t("missingWorktree")}</span>}
            </small>
          </div>
          <button
            className="plain-button"
            disabled={busy || item.bare || item.prunable !== null || item.current}
            onClick={() => onOpen(item.path)}
          >
            {t("openWorktree")}
          </button>
          {!item.main && !item.current && !item.bare && (
            <button
              className="icon-button"
              disabled={busy || item.locked !== null}
              title={t("removeWorktree")}
              aria-label={t("removeNamedWorktree", { path: item.path })}
              onClick={() => onRemove(item)}
            >
              <X size={17} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
