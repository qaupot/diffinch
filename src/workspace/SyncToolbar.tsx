import FindMenu from "../FindMenu";
import PopupMenu from "../PopupMenu";
import { useTranslation } from "../i18n";
import { ArrowDown, ArrowUp, Ellipsis, GitMerge, RefreshCw } from "../icons";
import { branchRef } from "../lib/branches";
import type { Action, Snapshot } from "../lib/git";
import type { WorkspaceMenu } from "./types";
import type { WorkspaceDialogs } from "./useWorkspaceDialogs";

export default function SyncToolbar({
  repo,
  busy,
  menu,
  setMenu,
  openFind,
  findFiles,
  action,
  submitPush,
  submitForcePush,
  dialogs,
}: {
  repo: Snapshot;
  busy: boolean;
  menu: WorkspaceMenu;
  setMenu: (menu: WorkspaceMenu) => void;
  openFind: () => void;
  findFiles: () => void;
  action: (action: Action) => Promise<void>;
  submitPush: () => void;
  submitForcePush: () => void;
  dialogs: Pick<WorkspaceDialogs, "ask" | "showModal">;
}) {
  const { t } = useTranslation();
  const { ask, showModal } = dialogs;
  const branch = repo.status.branch;
  const canRebase = !!branch && !!repo.status.head && !repo.operation;
  const rebaseTargets = repo.branches.filter((item) => !item.current);
  return (
    <div className="sync-controls">
      <FindMenu
        open={menu === "find"}
        onOpen={(open) => setMenu(open ? "find" : null)}
        onFind={openFind}
        onFiles={findFiles}
      />
      <button
        className="toolbar-button"
        disabled={busy || !repo.remotes.length}
        onClick={() => action({ kind: "fetch" })}
        title={t("fetchAll")}
      >
        <RefreshCw size={15} />
        <span>{t("fetch")}</span>
      </button>
      <button
        className="toolbar-button"
        disabled={busy || !repo.status.upstream || !!repo.operation}
        onClick={() => action({ kind: "pull" })}
        title={t("pullFastForward")}
      >
        <ArrowDown size={16} />
        <span>{t("pull")}</span>
        {repo.status.behind > 0 && <small>{repo.status.behind}</small>}
      </button>
      <button
        className="toolbar-button push"
        disabled={busy || !branch || !repo.status.head || !!repo.operation}
        onClick={submitPush}
        title={repo.status.upstream ? t("pushCurrent") : t("publishThis")}
      >
        <ArrowUp size={16} />
        <span>{repo.status.upstream ? t("push") : t("publish")}</span>
        {repo.status.ahead > 0 && <small>{repo.status.ahead}</small>}
      </button>
      <PopupMenu
        open={menu === "git"}
        onOpenChange={(open) => setMenu(open ? "git" : null)}
        label={t("gitActions")}
        panelClassName="sync-menu"
        trigger={<Ellipsis size={16} />}
      >
        <button
          disabled={busy || !repo.remotes.length}
          onClick={() => action({ kind: "fetchPrune" })}
        >
          <RefreshCw size={15} />
          {t("fetchPrune")}
        </button>
        <button
          disabled={busy || !canRebase || !repo.status.upstream}
          onClick={() =>
            ask({
              title: "pullRebaseQuestion",
              message: {
                key: "rebaseDescription",
                values: { source: branch!, target: repo.status.upstream! },
              },
              label: "pullRebase",
              action: { kind: "pullRebase", target: { branch, head: repo.status.head } },
            })
          }
        >
          <ArrowDown size={15} />
          {t("pullRebase")}
        </button>
        <button
          disabled={busy || !canRebase || !rebaseTargets.length}
          onClick={() => {
            const target =
              rebaseTargets.find((item) => item.name === repo.status.upstream) ?? rebaseTargets[0];
            if (target) showModal("rebase", { target: branchRef(target) });
          }}
        >
          <GitMerge size={15} />
          {t("rebaseOntoBranch")}
        </button>
        <hr className="menu-rule" />
        <button
          disabled={busy || !!repo.operation || !repo.pushLease}
          title={!repo.pushLease ? t("forcePushRequiresFetch") : undefined}
          onClick={submitForcePush}
        >
          <ArrowUp size={15} />
          {t("forcePushWithLease")}…
        </button>
      </PopupMenu>
    </div>
  );
}
