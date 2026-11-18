import { useMemo, type CSSProperties } from "react";
import ContextMenuRow from "./ContextMenuRow";
import { useTranslation } from "./i18n";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  Folder,
  GitBranch,
  GitFork,
  KeyRound,
  Plus,
  Server,
} from "./icons";
import { branchRef, branchTree, folderBranches, type BranchFolder } from "./lib/branches";
import type { Branch, Snapshot } from "./lib/git";
import { useSidebarExpansion } from "./useSidebarExpansion";

type Props = {
  path: string;
  branches: Branch[];
  remotes: Snapshot["remotes"];
  hidden: string[];
  allSelected: boolean;
  busy: boolean;
  canCreate: boolean;
  onVisibility: (branches: Branch[], visible: boolean) => void;
  onSelectAll: () => void;
  onSelect: (branch: Branch) => void;
  onCreate: () => void;
  onDelete: (branch: Branch) => void;
  onCredentials?: (remote: string) => void;
};

export default function BranchSidebar({
  path,
  branches,
  remotes,
  hidden,
  allSelected,
  busy,
  canCreate,
  onVisibility,
  onSelectAll,
  onSelect,
  onCreate,
  onDelete,
  onCredentials,
}: Props) {
  const { t } = useTranslation();
  const { isExpanded, toggle } = useSidebarExpansion(`diffinch.branchFolders:${path || "example"}`);
  const trees = useMemo(() => {
    const remote = branchTree(
      branches.filter((branch) => branch.remote),
      remotes.map(({ name }) => name),
    );
    for (const { name } of remotes) {
      if (!remote.folders.some((folder) => folder.path === name))
        remote.folders.push({ name, path: name, folders: [], branches: [] });
    }
    remote.folders.sort((a, b) => a.name.localeCompare(b.name));
    return { local: branchTree(branches.filter((branch) => !branch.remote)), remote };
  }, [branches, remotes]);
  const excluded = new Set(hidden);

  function visibility(items: Branch[], label: string) {
    const count = items.filter((branch) => !excluded.has(branchRef(branch))).length;
    const allVisible = count === items.length;
    return (
      <button
        className={`icon-button branch-visibility${count ? "" : " branch-hidden"}`}
        aria-label={t("branchVisibility", { name: label })}
        title={t(allVisible ? "hideFromGraph" : "showInGraph", { name: label })}
        aria-pressed={allVisible ? true : count ? "mixed" : false}
        disabled={busy || !items.length}
        onClick={() => onVisibility(items, !allVisible)}
      >
        {count ? <Eye size={14} /> : <EyeOff size={14} />}
        {count > 0 && !allVisible && <span className="branch-visibility-mixed" />}
      </button>
    );
  }

  function renderFolder(folder: BranchFolder, scope: string, depth: number): React.ReactNode {
    return (
      <>
        {folder.branches.map((branch) => (
          <ContextMenuRow
            key={branchRef(branch)}
            className={`branch-tree-row${branch.current ? " active-branch" : ""}`}
            style={{ "--branch-depth": depth } as CSSProperties}
            disabled={busy}
            actionLabel={t("deleteNamed", { name: branch.name })}
            onAction={!branch.current ? () => onDelete(branch) : undefined}
          >
            <button
              className={`branch-tree-select${excluded.has(branchRef(branch)) ? " branch-hidden" : ""}`}
              disabled={busy}
              title={`${branch.name}${branch.current ? ` · ${t("currentBranch")}` : ""}`}
              aria-label={t("showInGraph", { name: branch.name })}
              onClick={() => onSelect(branch)}
            >
              {branch.remote ? <Cloud size={14} /> : <GitBranch size={14} />}
              <span className="truncate">{branch.name.split("/").at(-1)}</span>
              {branch.current && <span className="branch-dot" aria-label={t("currentBranch")} />}
            </button>
            {visibility([branch], branch.name)}
          </ContextMenuRow>
        ))}
        {folder.folders.map((child) => {
          const key = `${scope}/${child.path}`;
          const expanded = isExpanded(key);
          const descendants = folderBranches(child);
          const remote = scope === "remote" && depth === 0;
          const Icon = remote ? Server : Folder;
          return (
            <div key={key} className={remote ? "branch-remote-group" : "branch-folder"}>
              <div className="branch-tree-row" style={{ "--branch-depth": depth } as CSSProperties}>
                <button
                  className="branch-tree-select branch-folder-toggle"
                  aria-expanded={expanded}
                  aria-label={t(remote ? "branchRemoteGroup" : "branchFolder", {
                    name: child.path,
                  })}
                  title={child.path}
                  onClick={() => toggle(key)}
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Icon size={13} />
                  <span className="truncate">{child.name}</span>
                  <span className="branch-folder-count">{descendants.length}</span>
                </button>
                {remote && onCredentials && remotes.some(({ name }) => name === child.path) && (
                  <button
                    className="icon-button branch-credentials"
                    disabled={busy}
                    title={t("remoteCredentials", { name: child.path })}
                    aria-label={t("remoteCredentials", { name: child.path })}
                    onClick={() => onCredentials(child.path)}
                  >
                    <KeyRound size={14} />
                  </button>
                )}
                {visibility(descendants, child.path)}
              </div>
              {expanded && (
                <div className="branch-folder-content">{renderFolder(child, scope, depth + 1)}</div>
              )}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <section className="branch-sidebar" aria-label={t("branches")}>
      <div className="section-line">
        <h2 className="section-label">{t("branches")}</h2>
        <button
          className="icon-button"
          disabled={busy || !canCreate}
          onClick={onCreate}
          title={t("newBranch")}
          aria-label={t("newBranch")}
        >
          <Plus size={15} />
        </button>
      </div>
      <p className="branch-sidebar-hint">{t("branchVisibilityHint")}</p>
      <button
        className={`nav-item branch-all${allSelected ? " current" : ""}`}
        aria-pressed={allSelected}
        title={t("showAllBranches")}
        disabled={busy}
        onClick={onSelectAll}
      >
        <GitFork size={15} />
        <span>{t("branchSectionAll")}</span>
        <span className="branch-folder-count" aria-hidden="true">
          {branches.length}
        </span>
      </button>
      {Object.entries(trees).map(([scope, tree]) => {
        const remote = scope === "remote";
        const label = t(remote ? "remoteBranches" : "localBranches");
        const expanded = isExpanded(scope);
        const items = folderBranches(tree);
        const Icon = remote ? Cloud : GitBranch;
        return (
          <section className={`branch-section scope-${scope}`} key={scope} aria-label={label}>
            <div className="branch-tree-row branch-section-heading">
              <button
                className="branch-tree-select"
                aria-expanded={expanded}
                onClick={() => toggle(scope)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Icon size={14} />
                <span className="truncate">
                  {t(remote ? "branchSectionRemote" : "branchSectionLocal")}
                </span>
                <span className="branch-folder-count">{items.length}</span>
              </button>
              {visibility(items, label)}
            </div>
            {expanded && (
              <div className="branch-section-content">
                {tree.folders.length || tree.branches.length ? (
                  renderFolder(tree, scope, 0)
                ) : (
                  <p className="branch-sidebar-empty">
                    {t(remote ? "noRemoteBranches" : "noLocalBranches")}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
