import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { version as appVersion } from "../../package.json";
import BranchSidebar from "../BranchSidebar";
import ConflictView from "../ConflictView";
import DiffView from "../DiffView";
import ExternalTools from "../dialogs/ExternalTools";
import { readEditor } from "../lib/external-tools";
import FindCommits from "../FindCommits";
import HistoryGraph, { type CommitCommand } from "../HistoryGraph";
import Notice from "../Notice";
import PaneDivider, { type PaneAxis } from "../PaneDivider";
import PopupMenu from "../PopupMenu";
import ReferenceRow from "../ReferenceRow";
import ReferenceSidebar from "../ReferenceSidebar";
import RepositoryNavigation from "../RepositoryNavigation";
import SidebarDivider from "../SidebarDivider";
import WorktreesView from "../WorktreesView";
import { errorMessage, useTranslation } from "../i18n";
import { type Locale, type MessageKey } from "../i18n/messages";
import {
  Archive,
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Code2,
  Crosshair,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  GitMerge,
  History,
  KeyRound,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Tag,
  X,
} from "../icons";
import { branchRef } from "../lib/branches";
import { commitAuthor } from "../lib/commits";
import {
  basename,
  dirname,
  git,
  historyLimit,
  historyPageSize,
  mac,
  native,
  shortcut,
  staged,
  unstaged,
  type Action,
  type Branch,
  type Commit,
  type SearchCommit,
  type Snapshot,
  type Stash,
} from "../lib/git";
import OperationProgress, { OperationContext } from "./OperationProgress";
import CommitComposer, { useCommitDraft } from "./CommitComposer";
import FileSection from "./FileSection";
import SyncToolbar from "./SyncToolbar";
import WorkspaceDialogHost from "./WorkspaceDialogHost";
import WorkspaceTitlebar from "./WorkspaceTitlebar";
import { chooseSelection } from "./selection";
import type { RepositoryTab, Theme, View, WorkspaceMenu, WorkspaceNotice } from "./types";
import { useGitActivity } from "./useGitActivity";
import { useGitOperations } from "./useGitOperations";
import { useRepositoryDiff } from "./useRepositoryDiff";
import { useRepositoryState } from "./useRepositoryState";
import { useWorkspaceDialogs } from "./useWorkspaceDialogs";

const ComparisonView = lazy(() => import("../ComparisonView"));
const FileHistoryView = lazy(() => import("../FileHistoryView"));
const RepositoryTools = lazy(() => import("../RepositoryTools"));

const nav = [
  { id: "changes", icon: FileCode2 },
  { id: "history", icon: History },
  { id: "find", icon: Search },
  { id: "compare", icon: GitMerge },
  { id: "fileHistory", icon: FileCode2 },
  { id: "branches", icon: GitBranch },
  { id: "worktrees", icon: FolderGit2 },
  { id: "stashes", icon: Archive },
  { id: "tags", icon: Tag },
  { id: "remotes", icon: Cloud },
  { id: "submodules", icon: FolderGit2 },
  { id: "subtrees", icon: GitMerge },
  { id: "lfs", icon: Archive },
] as const;
const operationLabel = {
  merge: "operationMerge",
  rebase: "operationRebase",
  "cherry-pick": "operationCherryPick",
  revert: "operationRevert",
} as const;

export default function RepositoryWorkspace({
  tab,
  active,
  restoring,
  acceptRepo,
  forgetWorktree,
  repositoryTabs,
  recents,
  split,
  setLayout,
  saveChangesWidth,
  saveSidebarWidth,
  saveFileSplit,
  saveHistorySize,
  theme,
  setTheme,
  locale,
  setLocale,
  onAbout,
}: {
  tab: RepositoryTab;
  active: boolean;
  restoring: boolean;
  acceptRepo: (snapshot: Snapshot, message?: MessageKey, sourcePath?: string) => void;
  forgetWorktree: (path: string) => void;
  repositoryTabs: React.ReactNode;
  recents: string[];
  split: boolean;
  setLayout: (split: boolean) => void;
  saveChangesWidth: (width: number | null) => void;
  saveFileSplit: (ratio: number | null) => void;
  saveSidebarWidth: (width: number | null) => void;
  saveHistorySize: (size: number | null, axis: PaneAxis) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onAbout: () => void;
}) {
  const { t, dateTime } = useTranslation();
  const changesId = useId();
  const sidebarId = useId();
  const historyId = useId();
  const diffId = useId();
  const [historyDiffVisible, setHistoryDiffVisible] = useState(false);
  const [toolsVisible, setToolsVisible] = useState(false);
  const [historyFile, setHistoryFile] = useState<string | undefined>();
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const activity = useGitActivity(restoring, setNotice);
  const { busy, inFlight, setBusy } = activity;
  const [query, setQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [findRequest, setFindRequest] = useState(0);
  const [findQuery, setFindQuery] = useState("");
  const [foundCommit, setFoundCommit] = useState<SearchCommit | null>(null);
  const [groups, setGroups] = useState({ unstaged: true, staged: true });
  const [menu, setMenu] = useState<WorkspaceMenu>(null);
  const dialogs = useWorkspaceDialogs(() => setMenu(null));
  const { modal, setRebaseDraft, setAuthorDraft, showModal, ask, openRemoteDelete } = dialogs;
  const draft = useCommitDraft(tab.snapshot.settings.signCommits);
  const { summary, setSummary, description, setDescription, sign, amend } = draft;
  const [scrollRequest, setScrollRequest] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const repository = useRepositoryState({
    tab,
    active,
    restoring,
    pauseRefresh: modal === "deleteRemoteRef",
    activity,
    setNotice,
  });
  const {
    repo,
    hiddenBranches,
    graphRepo,
    view,
    setView,
    viewRef,
    workspaceSelection,
    setSelection,
    diffRevision,
    loadingHistory,
    historyDepth,
    refresh,
    extendHistory,
    changeBranchVisibility,
    updateBranchVisibility,
  } = repository;

  const { openRepo, action, cloneRepository, confirmDiscard } = useGitOperations({
    repository,
    activity,
    dialogs,
    draft,
    restoring,
    acceptRepo,
    forgetWorktree,
    closeMenu: () => setMenu(null),
    onConflict: () => navigate("changes"),
    setNotice,
  });

  const isEmpty = !repo.path;
  const diffVisible =
    view === "changes" || view === "find" || (view === "history" && historyDiffVisible);
  const {
    selection,
    selectionKey,
    page,
    setDiffPage,
    currentDiff,
    previewDiff,
    file,
    conflictFile,
    ignoreWhitespace,
    setIgnoreWhitespace,
  } = useRepositoryDiff(repository, active, diffVisible, foundCommit);
  const branch = repo.status.branch;
  const onIndex = repo.status.files.filter(staged);
  const inWorktree = repo.status.files.filter(unstaged);
  const commit =
    view === "find"
      ? foundCommit
      : selection?.kind === "commit"
        ? graphRepo.commits.find((candidate) => candidate.id === selection.id)
        : undefined;
  const localBranches = repo.branches.filter((item) => !item.remote);
  const remoteBranches = repo.branches.filter((item) => item.remote);
  const canRebase = !!branch && !!repo.status.head && !repo.operation;
  const canCommit =
    !!summary.trim() &&
    !busy &&
    (onIndex.length > 0 || amend !== null) &&
    !repo.operation &&
    !repo.status.files.some((change) => change.conflict);

  useEffect(() => {
    if (!active) setMenu(null);
  }, [active]);

  async function showAllBranches() {
    if (restoring || inFlight.current) return;
    const result = hiddenBranches.length
      ? await updateBranchVisibility([])
      : { snapshot: graphRepo };
    if (!result) return;
    navigate("history");
    setSelection((current) => chooseSelection(result.snapshot, "history", current));
    setScrollRequest((request) => request + 1);
  }

  async function jumpToCommit({
    id,
    label,
    branch: targetBranch,
  }: {
    id: string;
    label: string;
    branch?: Branch;
  }) {
    if (inFlight.current) return;
    let snapshot = graphRepo;
    let hidden = hiddenBranches;
    const target =
      targetBranch ?? (label === "HEAD" ? repo.branches.find((item) => item.current) : undefined);
    if (target && hidden.includes(branchRef(target))) {
      const revealed = await changeBranchVisibility([target], true);
      if (!revealed) return;
      snapshot = revealed.snapshot;
      hidden = revealed.hidden;
    }
    navigate("history");
    if (
      !snapshot.commits.some((commit) => commit.id === id) &&
      snapshot.hasOlderCommits &&
      historyDepth.current < historyLimit
    ) {
      const extended = await extendHistory(historyLimit, hidden);
      if (!extended || viewRef.current !== "history") return;
      snapshot = extended;
    }
    if (snapshot.commits.some((commit) => commit.id === id)) {
      setSelection({ kind: "commit", id });
      setScrollRequest((request) => request + 1);
    } else {
      setNotice({ message: { key: "commitNotLoaded", values: { ref: label } }, error: true });
    }
  }

  function navigate(next: View) {
    viewRef.current = next;
    setView(next);
    setQuery("");
    setSearchVisible(false);
    setMenu(null);
    if (next === "changes" || next === "history")
      setSelection((current) =>
        chooseSelection(next === "history" ? graphRepo : repo, next, current),
      );
  }

  function openFind() {
    setFindQuery("");
    navigate("find");
    setFindRequest((request) => request + 1);
  }

  function findFiles() {
    navigate("changes");
    setSearchVisible(true);
    window.setTimeout(() => searchInput.current?.focus(), 0);
  }

  function showSettings() {
    showModal("settings", repo.settings);
  }

  async function changeAmend(checked: boolean) {
    if (inFlight.current) return;
    if (!checked) {
      draft.setAmend(null);
      return;
    }
    if (!repo.status.head || repo.operation) return;
    const target = { branch: repo.status.branch, head: repo.status.head };
    draft.setAmend(target);
    if (summary.trim() || description.trim()) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const message = await git.commitMessage(repo.path, target.head);
      const [firstLine, ...rest] = message.split("\n");
      setSummary((current) => current || firstLine);
      setDescription((current) => current || rest.join("\n").trim());
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function performCommit() {
    if (!canCommit) return;
    if (amend && (amend.head !== repo.status.head || amend.branch !== repo.status.branch)) {
      setNotice({ message: { key: "staleAmendDraft" }, error: true });
      return;
    }
    const next: Action = {
      kind: "commit",
      summary,
      description,
      sign,
      amend,
    };
    if (amend) {
      ask({
        title: "amendQuestion",
        message: { key: "amendDescription" },
        label: "amendCommit",
        action: next,
      });
    } else {
      void action(next);
    }
  }

  function switchBranch(item: Branch) {
    setMenu(null);
    if (!item.current) void action({ kind: "switchBranch", name: item.name, remote: item.remote });
  }

  function deleteBranch(item: Branch) {
    if (item.current) return;
    if (item.remote) {
      const remote = repo.remotes
        .map(({ name }) => name)
        .sort((a, b) => b.length - a.length)
        .find((name) => item.name.startsWith(`${name}/`));
      openRemoteDelete(
        "branch",
        remote ? { remote, name: item.name.slice(remote.length + 1) } : undefined,
      );
      return;
    }
    ask({
      title: "deleteBranchQuestion",
      message: { key: "deleteBranchDescription", values: { name: item.name } },
      label: "deleteBranch",
      destructive: true,
      action: { kind: "deleteBranch", name: item.name },
    });
  }

  function deleteTag(name: string) {
    ask({
      title: "deleteTagQuestion",
      message: { key: "deleteTagDescription", values: { name } },
      label: "deleteTag",
      destructive: true,
      action: { kind: "deleteTag", name },
    });
  }

  function dropStash(item: Stash) {
    ask({
      title: "dropStashQuestion",
      message: { key: "dropStashDescription", values: { id: item.id, subject: item.subject } },
      label: "dropStash",
      destructive: true,
      action: { kind: "dropStash", id: item.id, tip: item.tip },
    });
  }

  function branchCommand(command: "switch" | "merge" | "rebase" | "delete", item: Branch) {
    if (command === "delete") {
      deleteBranch(item);
      return;
    }
    if (command === "switch") {
      switchBranch(item);
      return;
    }
    const merge = command === "merge";
    ask({
      title: merge ? "mergeQuestion" : "rebaseQuestion",
      message: merge
        ? { key: "mergeDescription", values: { source: item.name, target: branch ?? "HEAD" } }
        : { key: "rebaseDescription", values: { source: branch ?? "HEAD", target: item.name } },
      label: merge ? "mergeBranch" : "rebaseBranch",
      action: {
        kind: command,
        name: item.name,
        remote: item.remote,
        tip: item.tip,
        target: { branch, head: repo.status.head },
      },
    });
  }

  async function commitCommand(command: CommitCommand, item: Commit) {
    if (command === "changeAuthor") {
      if (!canRebase || restoring || inFlight.current) return;
      setNotice(null);
      inFlight.current = true;
      setBusy(true);
      try {
        setAuthorDraft(await git.authorPlan(repo.path, item.id));
        showModal("changeAuthor");
      } catch (error) {
        setNotice({ message: errorMessage(error), error: true });
      } finally {
        setBusy(false);
        inFlight.current = false;
      }
      return;
    }
    if (command === "interactiveRebase" || command === "interactiveRebaseFromRoot") {
      if (!canRebase || restoring || inFlight.current) return;
      setNotice(null);
      inFlight.current = true;
      setBusy(true);
      try {
        const plan = await git.rebasePlan(
          repo.path,
          item.id,
          command === "interactiveRebaseFromRoot",
        );
        setRebaseDraft({ plan, label: item.shortId });
        showModal("interactiveRebase");
      } catch (error) {
        setNotice({ message: errorMessage(error), error: true });
      } finally {
        setBusy(false);
        inFlight.current = false;
      }
      return;
    }
    if (command === "branch" || command === "tag") {
      showModal(command, {
        start: item.id,
        startLabel: item.subject ? `${item.shortId} · ${item.subject}` : item.shortId,
        checkout: false,
      });
      return;
    }
    if (command === "copy") {
      try {
        await navigator.clipboard.writeText(item.id);
        setNotice({ message: { key: "commitShaCopied" }, error: false });
      } catch {
        setNotice({
          message: { key: "commitShaCopyFailed", values: { id: item.id } },
          error: true,
        });
      }
      return;
    }
    const picking = command === "cherryPick";
    ask({
      title: picking ? "cherryPickQuestion" : "revertQuestion",
      message: picking
        ? { key: "cherryPickDescription", values: { id: item.shortId, target: branch ?? "HEAD" } }
        : { key: "revertDescription", values: { id: item.shortId } },
      label: picking ? "cherryPick" : "revertCommit",
      action: { kind: command, id: item.id, target: { branch, head: repo.status.head } },
    });
  }

  function submitPush() {
    if (repo.status.upstream) {
      void action({ kind: "push" });
    } else if (repo.remotes.length > 0) {
      showModal("publish", {
        remote:
          repo.remotes.find((remote) => remote.name === "origin")?.name ?? repo.remotes[0].name,
      });
    } else {
      showModal("remote", { name: "origin" });
    }
  }

  function submitForcePush() {
    const lease = repo.pushLease;
    if (!lease || !repo.status.upstream) return;
    ask({
      title: "forcePushQuestion",
      message: {
        key: "forcePushDescription",
        values: {
          branch: lease.branch,
          remote: lease.remote,
          target: lease.target.slice("refs/heads/".length),
          id: lease.expected.slice(0, 12),
        },
      },
      label: "forcePushWithLease",
      destructive: true,
      action: { kind: "forcePush", lease },
    });
  }

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      // App-level dialogs (including About) must also block repository actions.
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && !modal) {
        setMenu(null);
        setNotice(null);
      }
      if (event.defaultPrevented || !(mac ? event.metaKey : event.ctrlKey) || event.altKey || modal)
        return;
      const key = event.key.toLowerCase();
      if (isEmpty && key !== "o") return;
      if (key === "o") {
        event.preventDefault();
        void openRepo("open");
      } else if (key === "r") {
        event.preventDefault();
        void refresh();
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        openFind();
      } else if (key === "f") {
        event.preventDefault();
        if (view === "history" || view === "find") {
          searchInput.current?.focus();
          searchInput.current?.select();
        } else if (view === "changes") {
          setSearchVisible(true);
          window.setTimeout(() => searchInput.current?.focus(), 0);
        } else openFind();
      } else if (key === "enter" && !event.shiftKey && view === "changes") {
        event.preventDefault();
        performCommit();
      } else if (key === ",") {
        event.preventDefault();
        showSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const detailsView =
    view !== "changes" &&
    view !== "history" &&
    view !== "compare" &&
    view !== "find" &&
    view !== "fileHistory";
  const operation = repo.operation ? t(operationLabel[repo.operation]) : null;
  const fileCount = repo.status.files.length;
  const changesSelection = selection?.kind === "changes" ? selection : null;
  const changesCount = changesSelection?.id === "staged" ? onIndex.length : inWorktree.length;
  const displayName = changesSelection
    ? t(changesSelection.id === "staged" ? "stagedChanges" : "currentChanges")
    : file
      ? basename(file.path)
      : commit?.subject ||
        (view === "find" ? t("findCommits") : view === "history" ? t("commitGraph") : t("changes"));
  const displaySubtitle = file
    ? file.originalPath
      ? `${file.originalPath} → ${file.path}`
      : file.path
    : commit
      ? `${commit.shortId} · ${commitAuthor(commit)} · ${dateTime(commit.date)}`
      : changesSelection
        ? t(changesCount === 1 ? "oneFileChanged" : "filesChanged", { count: changesCount })
        : undefined;
  const loadingView = (
    <div className="review-empty" role="status">
      <p>{t("working")}</p>
    </div>
  );
  return (
    <div
      className={`workspace ${native && mac ? "native-mac" : ""}`}
      hidden={!active}
      onClick={() => {
        if (menu) setMenu(null);
      }}
    >
      <WorkspaceTitlebar
        repositoryName={isEmpty ? null : repo.name}
        view={view}
        theme={theme}
        setTheme={setTheme}
        locale={locale}
        setLocale={setLocale}
        onManual={() => showModal("manual")}
        onAbout={onAbout}
        onSettings={showSettings}
      />

      {active && (
        <div className="repository-tabs">
          <div className="repository-tab-controls" role="group" aria-label={t("openRepositories")}>
            {repositoryTabs}
            <PopupMenu
              open={menu === "repo"}
              onOpenChange={(open) =>
                setMenu((current) => (open ? "repo" : current === "repo" ? null : current))
              }
              label={t("addRepository")}
              className="repository-add"
              buttonClassName="icon-button"
              panelClassName="repo-menu"
              trigger={<Plus size={17} />}
            >
              <button disabled={busy} onClick={() => openRepo("open")}>
                <Folder size={15} />
                {t("openRepository")}
                <span className="menu-shortcut">{shortcut}O</span>
              </button>
              <button disabled={busy} onClick={() => showModal("clone")}>
                <ArrowDown size={15} />
                {t("cloneRepository")}
              </button>
              <button disabled={busy} onClick={() => openRepo("init")}>
                <Plus size={15} />
                {t("initRepository")}
              </button>
              {recents.length > 0 && (
                <>
                  <div className="menu-label">{t("recentRepositories")}</div>
                  {recents.map((path) => (
                    <button
                      key={path}
                      disabled={busy}
                      title={path}
                      onClick={() => openRepo("open", path)}
                    >
                      <FolderGit2 size={15} />
                      <span className="truncate">{basename(path.replaceAll("\\", "/"))}</span>
                    </button>
                  ))}
                </>
              )}
            </PopupMenu>
          </div>
          {!isEmpty && (
            <SyncToolbar
              repo={repo}
              busy={busy}
              menu={menu}
              setMenu={setMenu}
              openFind={openFind}
              findFiles={findFiles}
              action={action}
              submitPush={submitPush}
              submitForcePush={submitForcePush}
              dialogs={dialogs}
            />
          )}
        </div>
      )}

      {operation && (
        <div className="operation-bar">
          <GitMerge size={16} />
          <span>{t("operationInProgress", { operation })}</span>
          <button
            className="plain-button"
            disabled={busy || repo.status.files.some((file) => file.conflict)}
            onClick={() => action({ kind: "continueOperation" })}
          >
            {t("continue")}
          </button>
          {repo.operation === "rebase" && (
            <button
              className="plain-button"
              disabled={busy}
              onClick={() =>
                ask({
                  title: "skipRebaseQuestion",
                  message: { key: "skipRebaseDescription" },
                  label: "skipRebase",
                  destructive: true,
                  action: { kind: "skipRebase" },
                })
              }
            >
              {t("skipRebase")}
            </button>
          )}
          <button
            className="plain-button"
            disabled={busy}
            onClick={() =>
              ask({
                title: { key: "abortOperationQuestion", values: { operation } },
                message: { key: "abortOperationDescription" },
                label: "abortOperation",
                destructive: true,
                action: { kind: "abortOperation" },
              })
            }
          >
            {t("abort")}
          </button>
        </div>
      )}

      <OperationProgress activity={activity} />

      {isEmpty ? (
        <main className="repository-start" aria-busy={restoring}>
          <div className="repository-start-content">
            <FolderGit2 size={36} className="muted" aria-hidden="true" />
            <h1>{t(restoring ? "restoreRepositories" : "noRepositoryOpen")}</h1>
            {!restoring && (
              <>
                <p className="muted">{t("openRepositoryHelp")}</p>
                <div className="repository-start-actions">
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => openRepo("open")}
                  >
                    <Folder size={16} />
                    {t("openRepository")}
                    <kbd>{shortcut}O</kbd>
                  </button>
                  <button
                    className="plain-button"
                    disabled={busy}
                    onClick={() => showModal("clone")}
                  >
                    <ArrowDown size={16} />
                    {t("cloneRepository")}
                  </button>
                  <button className="plain-button" disabled={busy} onClick={() => openRepo("init")}>
                    <Plus size={16} />
                    {t("initRepository")}
                  </button>
                </div>
                {recents.length > 0 && (
                  <section
                    className="repository-start-recents"
                    aria-label={t("recentRepositories")}
                  >
                    <h2>{t("recentRepositories")}</h2>
                    {recents.map((path) => (
                      <button
                        key={path}
                        disabled={busy}
                        title={path}
                        onClick={() => openRepo("open", path)}
                      >
                        <FolderGit2 size={16} />
                        <span>
                          <strong className="truncate">
                            {basename(path.replaceAll("\\", "/"))}
                          </strong>
                          <span className="truncate muted">{path}</span>
                        </span>
                      </button>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        </main>
      ) : (
        <div
          className={`body ${detailsView || view === "compare" || view === "fileHistory" ? "details-layout" : view === "history" && !historyDiffVisible ? "graph-only-layout" : view === "history" || view === "find" ? "history-layout" : "changes-layout"}`}
        >
          <aside id={sidebarId} className="sidebar" aria-label={t("repositoryNavigation")}>
            <div className="sidebar-branch">
              <PopupMenu
                open={menu === "branch"}
                onOpenChange={(open) =>
                  setMenu((current) => (open ? "branch" : current === "branch" ? null : current))
                }
                label={branch ?? t("detachedHead")}
                buttonClassName="toolbar-button branch-picker"
                panelClassName="branch-menu"
                trigger={
                  <>
                    <GitBranch size={16} />
                    <span className="truncate">{branch ?? t("detachedHead")}</span>
                    <ChevronDown size={13} className="muted" />
                  </>
                }
              >
                {(
                  [
                    {
                      scope: "local",
                      items: localBranches,
                      label: "localBranches",
                      Icon: GitBranch,
                    },
                    {
                      scope: "remote",
                      items: remoteBranches,
                      label: "remoteBranches",
                      Icon: Cloud,
                    },
                  ] as const
                ).map(({ scope, items, label, Icon }) => (
                  <section
                    key={scope}
                    className={`branch-menu-section scope-${scope}`}
                    aria-label={t(label)}
                  >
                    <div className="menu-label">
                      <Icon size={14} />
                      <span>{t(label)}</span>
                      <span className="group-count">{items.length}</span>
                    </div>
                    {items.map((item) => (
                      <button key={item.name} disabled={busy} onClick={() => switchBranch(item)}>
                        <Icon size={14} />
                        <span className="truncate">{item.name}</span>
                        {item.current && <Check size={14} className="menu-shortcut" />}
                      </button>
                    ))}
                    {!items.length && (
                      <p className="branch-sidebar-empty">
                        {t(scope === "remote" ? "noRemoteBranches" : "noLocalBranches")}
                      </p>
                    )}
                  </section>
                ))}
                <hr className="menu-rule" />
                <button
                  disabled={busy || !repo.status.head}
                  onClick={() => showModal("branch", { checkout: true })}
                >
                  <Plus size={15} />
                  {t("newBranch")}
                </button>
              </PopupMenu>
            </div>
            <div className="sidebar-scroll">
              <h2 className="section-label">{t("workspace")}</h2>
              <nav>
                {nav.slice(0, 5).map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    className={`nav-item ${view === id ? "current" : ""}`}
                    aria-current={view === id ? "page" : undefined}
                    title={t(id)}
                    onClick={() => navigate(id)}
                  >
                    <Icon size={17} />
                    <span>{t(id)}</span>
                    {id === "changes" && (
                      <span className="nav-count">{inWorktree.length + onIndex.length}</span>
                    )}
                  </button>
                ))}
              </nav>
              <RepositoryNavigation path={repo.path}>
                {nav.slice(5).map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    className={`nav-item ${view === id ? "current" : ""}`}
                    aria-current={view === id ? "page" : undefined}
                    title={t(id)}
                    onClick={() => navigate(id)}
                  >
                    <Icon size={17} />
                    <span>{t(id)}</span>
                  </button>
                ))}
              </RepositoryNavigation>
              <div className="sidebar-rule" />
              <BranchSidebar
                path={repo.path}
                branches={repo.branches}
                remotes={repo.remotes}
                hidden={hiddenBranches}
                busy={busy}
                canCreate={!!repo.status.head}
                allSelected={
                  view === "history" && graphRepo.branches.length === repo.branches.length
                }
                onSelectAll={() => {
                  void showAllBranches();
                }}
                onVisibility={(items, visible) => {
                  void changeBranchVisibility(items, visible);
                }}
                onSelect={(item) => {
                  void jumpToCommit({ id: item.tip, label: item.name, branch: item });
                }}
                onCreate={() => showModal("branch", { checkout: true })}
                onDelete={deleteBranch}
                onCredentials={(remote) => showModal("credentials", { remote })}
              />
              <ReferenceSidebar
                repo={repo}
                busy={busy}
                onCreate={(kind) =>
                  showModal(kind, kind === "stash" ? { includeUntracked: true } : {})
                }
                onSelect={(target) => void jumpToCommit(target)}
                onDeleteTag={deleteTag}
                onDropStash={dropStash}
              />
            </div>
            <div className="sidebar-bottom">
              <button className="nav-item" title={t("repositorySettings")} onClick={showSettings}>
                <Settings2 size={17} />
                <span>{t("repositorySettings")}</span>
              </button>
            </div>
            <SidebarDivider controls={sidebarId} onResize={saveSidebarWidth} />
          </aside>

          {view === "compare" && (
            <Suspense fallback={loadingView}>
              <ComparisonView
                repo={repo}
                split={split}
                setSplit={setLayout}
                revision={diffRevision}
              />
            </Suspense>
          )}
          {view === "fileHistory" && (
            <Suspense fallback={loadingView}>
              <FileHistoryView
                path={repo.path}
                head={repo.status.head}
                initialFile={historyFile}
                busy={busy}
                split={split}
                setSplit={setLayout}
                action={action}
                onTools={() => setToolsVisible(true)}
                onCommit={(line) => {
                  setFindQuery(line.id);
                  navigate("find");
                }}
              />
            </Suspense>
          )}
          {!detailsView && view !== "compare" && view !== "fileHistory" && (
            <>
              {view === "find" ? (
                <FindCommits
                  id={historyId}
                  repo={repo}
                  request={findRequest}
                  searchInput={searchInput}
                  selected={foundCommit}
                  initialQuery={findQuery}
                  onSelect={setFoundCommit}
                />
              ) : view === "history" ? (
                <HistoryGraph
                  id={historyId}
                  repo={graphRepo}
                  filtered={graphRepo.branches.length !== repo.branches.length}
                  query={query}
                  searchInput={searchInput}
                  selectedId={changesSelection?.id ?? commit?.id}
                  scrollRequest={scrollRequest}
                  busy={busy}
                  loadingHistory={loadingHistory}
                  onQuery={setQuery}
                  onSelect={setSelection}
                  diffId={diffId}
                  diffVisible={historyDiffVisible}
                  onToggleDiff={() => setHistoryDiffVisible((visible) => !visible)}
                  onJump={jumpToCommit}
                  onLoadMore={() =>
                    extendHistory(Math.min(historyDepth.current + historyPageSize, historyLimit))
                  }
                  onRefresh={refresh}
                  onCommitCommand={commitCommand}
                  onBranchCommand={branchCommand}
                  onDeleteTag={deleteTag}
                  onDropStash={dropStash}
                />
              ) : (
                <section
                  id={changesId}
                  className="inspector changes-inspector"
                  aria-label={t("workingTreeFiles")}
                >
                  <div className="inspector-heading">
                    <div>
                      <h2>{t("changes")}</h2>
                      <p>
                        {t(fileCount === 1 ? "oneFileChanged" : "filesChanged", {
                          count: fileCount,
                        })}
                      </p>
                    </div>
                    <div className="inspector-controls">
                      <button
                        className="icon-button"
                        title={t("filter", { shortcut: `${shortcut}F` })}
                        aria-pressed={searchVisible}
                        onClick={() => {
                          setSearchVisible(!searchVisible);
                          setQuery("");
                          if (!searchVisible)
                            window.setTimeout(() => searchInput.current?.focus(), 0);
                        }}
                      >
                        <ListFilter size={18} />
                      </button>
                      <button
                        className="icon-button"
                        title={t("refresh", { shortcut: `${shortcut}R` })}
                        disabled={busy}
                        onClick={() => refresh()}
                      >
                        <RefreshCw size={15} className={busy ? "spin" : ""} />
                      </button>
                    </div>
                  </div>
                  {searchVisible && (
                    <label className="search-box">
                      <Search size={15} />
                      <input
                        ref={searchInput}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("filterFiles")}
                        aria-label={t("filterFiles")}
                      />
                    </label>
                  )}
                  <div className="inspector-scroll">
                    <div className="file-groups" data-resizable={groups.unstaged && groups.staged}>
                      <FileSection
                        id={`${changesId}-unstaged`}
                        kind="unstaged"
                        files={inWorktree}
                        expanded={groups.unstaged}
                        onToggle={() =>
                          setGroups((current) => ({ ...current, unstaged: !current.unstaged }))
                        }
                        query={query}
                        selection={workspaceSelection}
                        onSelect={setSelection}
                        busy={busy}
                        inFlight={inFlight}
                        action={action}
                      />
                      {groups.unstaged && groups.staged && (
                        <PaneDivider
                          controls={`${changesId}-unstaged ${changesId}-staged`}
                          label={t("fileGroupsSplit")}
                          title={t("resizeFileGroups")}
                          onResize={(height, _axis, available) =>
                            saveFileSplit(height === null ? null : height / available)
                          }
                        />
                      )}
                      <FileSection
                        id={`${changesId}-staged`}
                        kind="staged"
                        files={onIndex}
                        expanded={groups.staged}
                        onToggle={() =>
                          setGroups((current) => ({ ...current, staged: !current.staged }))
                        }
                        query={query}
                        selection={workspaceSelection}
                        onSelect={setSelection}
                        busy={busy}
                        inFlight={inFlight}
                        action={action}
                      />
                    </div>
                  </div>

                  <CommitComposer
                    draft={draft}
                    repo={repo}
                    busy={busy}
                    canCommit={canCommit}
                    onCommit={performCommit}
                    onSettings={showSettings}
                    onAmendChange={(checked) => {
                      void changeAmend(checked);
                    }}
                    discard={
                      <>
                        {file &&
                          !file.conflict &&
                          !file.submodule &&
                          selection?.kind === "file" &&
                          !selection.staged &&
                          file.worktree !== "?" && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() => void confirmDiscard(file)}
                            >
                              {t("discard")}
                            </button>
                          )}
                      </>
                    }
                  />
                </section>
              )}
              {diffVisible && (
                <>
                  {view === "history" || view === "find" ? (
                    <PaneDivider
                      key="history"
                      controls={historyId}
                      label={t(view === "find" ? "searchResultsSize" : "commitGraphSize")}
                      title={t(view === "find" ? "resizeSearchResults" : "resizeCommitGraph")}
                      onResize={saveHistorySize}
                    />
                  ) : (
                    <PaneDivider
                      key="changes"
                      controls={changesId}
                      label={t("changesPaneWidth")}
                      title={t("resizeChangesPane")}
                      onResize={saveChangesWidth}
                    />
                  )}
                  {conflictFile ? (
                    <ConflictView
                      key={conflictFile.id}
                      path={repo.path}
                      file={conflictFile}
                      busy={busy}
                      action={action}
                      onEditor={() =>
                        void action({
                          kind: "openEditor",
                          file: conflictFile.path,
                          editor: readEditor(),
                        })
                      }
                      onTools={() => setToolsVisible(true)}
                    />
                  ) : (
                    <DiffView
                      id={diffId}
                      fileTools={
                        file && (
                          <PopupMenu
                            open={menu === "fileTools"}
                            onOpenChange={(open) => setMenu(open ? "fileTools" : null)}
                            label={t("externalTools")}
                            trigger={<FileCode2 size={16} />}
                          >
                            <button
                              disabled={busy}
                              onClick={() => {
                                setMenu(null);
                                void action({
                                  kind: "openEditor",
                                  file: file.path,
                                  editor: readEditor(),
                                });
                              }}
                            >
                              {t("openInEditor")}
                            </button>
                            <button
                              onClick={() => {
                                setMenu(null);
                                setHistoryFile(file.originalPath ?? file.path);
                                navigate("fileHistory");
                              }}
                            >
                              {t("fileHistory")}
                            </button>
                            <button
                              onClick={() => {
                                setMenu(null);
                                setToolsVisible(true);
                              }}
                            >
                              {t("externalTools")}
                            </button>
                          </PopupMenu>
                        )
                      }
                      title={displayName}
                      subtitle={displaySubtitle}
                      diff={previewDiff}
                      pending={!!selection && !currentDiff}
                      error={currentDiff?.error ?? null}
                      split={split}
                      setSplit={setLayout}
                      selection={selection}
                      busy={busy}
                      action={action}
                      page={page}
                      loadMore={() => setDiffPage({ selection: selectionKey, page: page + 1 })}
                      ignoreWhitespace={ignoreWhitespace}
                      setIgnoreWhitespace={setIgnoreWhitespace}
                    />
                  )}
                </>
              )}
            </>
          )}

          {detailsView && (
            <main className="details">
              <header className="details-heading">
                <h1>{t(view)}</h1>
                {view === "branches" && (
                  <div className="details-actions">
                    {repo.remotes.length > 0 && (
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() => openRemoteDelete("branch")}
                      >
                        {t("deleteRemoteBranch")}
                      </button>
                    )}
                    <button
                      className="primary-button"
                      disabled={busy || !repo.status.head}
                      onClick={() => showModal("branch", { checkout: true })}
                    >
                      <Plus size={16} />
                      {t("newBranch")}
                    </button>
                  </div>
                )}
                {view === "stashes" && (
                  <button
                    className="primary-button"
                    disabled={busy || !repo.status.files.length}
                    onClick={() => showModal("stash", { includeUntracked: true })}
                  >
                    <Plus size={16} />
                    {t("stashChanges")}
                  </button>
                )}
                {view === "tags" && (
                  <div className="details-actions">
                    {repo.remotes.length > 0 && (
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() => openRemoteDelete("tag")}
                      >
                        {t("deleteRemoteTag")}
                      </button>
                    )}
                    <button
                      className="primary-button"
                      disabled={busy || !repo.status.head}
                      onClick={() => showModal("tag")}
                    >
                      <Plus size={16} />
                      {t("newTag")}
                    </button>
                  </div>
                )}
                {view === "remotes" && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() =>
                      showModal("remote", { name: repo.remotes.length ? "" : "origin" })
                    }
                  >
                    <Plus size={16} />
                    {t("addRemote")}
                  </button>
                )}
                {view === "worktrees" && (
                  <button
                    className="primary-button"
                    disabled={busy || !repo.status.head}
                    onClick={() =>
                      showModal("worktree", {
                        mode: "newBranch",
                        start: "HEAD",
                        parent: dirname(repo.path),
                      })
                    }
                  >
                    <Plus size={16} />
                    {t("createWorktree")}
                  </button>
                )}
              </header>
              {(view === "submodules" || view === "subtrees" || view === "lfs") && (
                <Suspense fallback={loadingView}>
                  <RepositoryTools
                    key={view}
                    kind={view}
                    repo={repo}
                    active={active}
                    busy={busy}
                    revision={diffRevision}
                    onAction={action}
                    onOpen={(path) => {
                      void openRepo("open", path);
                    }}
                    onConfirmPush={(toolAction, prefix, remote, branch) =>
                      ask({
                        title: "pushSubtree",
                        message: {
                          key: "subtreePushDescription",
                          values: { prefix, remote, branch },
                        },
                        label: "pushSubtree",
                        action: { kind: "repositoryTool", action: toolAction },
                      })
                    }
                  />
                </Suspense>
              )}
              {view === "worktrees" && (
                <WorktreesView
                  worktrees={repo.worktrees}
                  busy={busy}
                  onOpen={(path) => {
                    void openRepo("open", path);
                  }}
                  onRemove={(item) =>
                    ask({
                      title: "removeWorktree",
                      message: { key: "removeWorktreeDescription", values: { path: item.path } },
                      label: "removeWorktree",
                      destructive: true,
                      action: {
                        kind: "removeWorktree",
                        path: item.path,
                        head: item.head,
                        branch: item.branch,
                      },
                    })
                  }
                />
              )}
              {view === "branches" && (
                <div className="branch-details">
                  {(["local", "remote"] as const).map((scope) => {
                    const remote = scope === "remote";
                    const items = remote ? remoteBranches : localBranches;
                    const label = t(remote ? "remoteBranches" : "localBranches");
                    const Icon = remote ? Cloud : GitBranch;
                    return (
                      <section
                        className={`details-list scope-${scope}`}
                        key={scope}
                        aria-label={label}
                      >
                        <header className="branch-list-heading">
                          <Icon size={17} />
                          <h2>{label}</h2>
                          <span className="group-count">{items.length}</span>
                        </header>
                        {items.map((item) => (
                          <ReferenceRow
                            className="detail-row branch-detail-row"
                            key={item.name}
                            disabled={busy}
                            deleteLabel={t("deleteNamed", { name: item.name })}
                            onDelete={!item.current ? () => deleteBranch(item) : undefined}
                          >
                            <span className="file-tile">
                              <Icon size={17} />
                            </span>
                            <div className="detail-description truncate">
                              <strong title={item.name}>{item.name}</strong>
                              <small>
                                {item.current
                                  ? t("currentBranch")
                                  : item.remote
                                    ? t("remoteBranch")
                                    : item.upstream || t("localBranch")}
                              </small>
                            </div>
                            <div className="branch-detail-actions">
                              <button
                                className="icon-button"
                                disabled={busy}
                                title={t("showInGraph", { name: item.name })}
                                onClick={() =>
                                  jumpToCommit({ id: item.tip, label: item.name, branch: item })
                                }
                              >
                                <Crosshair size={16} />
                              </button>
                              {!item.current && (
                                <>
                                  <button
                                    className="plain-button"
                                    disabled={busy || !!repo.operation}
                                    onClick={() => switchBranch(item)}
                                  >
                                    {t("switch")}
                                  </button>
                                  <button
                                    className="plain-button"
                                    disabled={busy || !branch || !!repo.operation}
                                    onClick={() => branchCommand("merge", item)}
                                  >
                                    {t("merge")}
                                  </button>
                                  <button
                                    className="plain-button"
                                    disabled={busy || !branch || !!repo.operation}
                                    onClick={() => branchCommand("rebase", item)}
                                  >
                                    {t("rebase")}
                                  </button>
                                </>
                              )}
                            </div>
                          </ReferenceRow>
                        ))}
                        {!items.length && (
                          <p className="empty-list">
                            {t(remote ? "noRemoteBranches" : "noLocalBranches")}
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
              {view === "stashes" && (
                <div className="details-list">
                  {repo.stashes.map((item) => (
                    <ReferenceRow
                      className="detail-row"
                      key={`${item.id}:${item.tip}`}
                      disabled={busy}
                      deleteLabel={t("dropNamedStash", { name: item.id })}
                      onDelete={() => dropStash(item)}
                    >
                      <span className="file-tile">
                        <Archive size={17} />
                      </span>
                      <div className="detail-description truncate">
                        <strong>{item.subject}</strong>
                        <small>{item.id}</small>
                      </div>
                      <button
                        className="icon-button"
                        disabled={busy}
                        title={t("showInGraph", { name: item.id })}
                        onClick={() => jumpToCommit({ id: item.tip, label: item.id })}
                      >
                        <Crosshair size={16} />
                      </button>
                      <button
                        className="plain-button"
                        disabled={busy || !!repo.operation}
                        onClick={() => action({ kind: "applyStash", id: item.id, tip: item.tip })}
                      >
                        {t("apply")}
                      </button>
                      <button
                        className="plain-button"
                        disabled={busy || !!repo.operation}
                        onClick={() => action({ kind: "popStash", id: item.id, tip: item.tip })}
                      >
                        {t("pop")}
                      </button>
                    </ReferenceRow>
                  ))}
                  {!repo.stashes.length && <p className="empty-list">{t("noStashes")}</p>}
                </div>
              )}
              {view === "tags" && (
                <div className="details-list">
                  {repo.tags.map(({ name, tip }) => (
                    <ReferenceRow
                      className="detail-row"
                      key={`${name}:${tip}`}
                      disabled={busy}
                      deleteLabel={t("deleteNamedTag", { name })}
                      onDelete={() => deleteTag(name)}
                    >
                      <span className="file-tile">
                        <Tag size={17} />
                      </span>
                      <div className="detail-description truncate">
                        <strong>{name}</strong>
                      </div>
                      <button
                        className="icon-button"
                        disabled={busy}
                        title={t("showInGraph", { name })}
                        onClick={() => jumpToCommit({ id: tip, label: name })}
                      >
                        <Crosshair size={16} />
                      </button>
                    </ReferenceRow>
                  ))}
                  {!repo.tags.length && <p className="empty-list">{t("noTags")}</p>}
                </div>
              )}
              {view === "remotes" && (
                <div className="details-list">
                  {repo.remotes.map(({ name, url }) => (
                    <div className="detail-row" key={name}>
                      <span className="file-tile">
                        <Cloud size={17} />
                      </span>
                      <div className="detail-description truncate">
                        <strong>{name}</strong>
                        <small className="truncate" title={url}>
                          {url}
                        </small>
                      </div>
                      <button
                        className="plain-button"
                        disabled={busy}
                        title={t("remoteCredentials", { name })}
                        onClick={() => showModal("credentials", { remote: name })}
                      >
                        <KeyRound size={15} />
                        {t("credentials")}
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy}
                        title={t("removeNamedRemote", { name })}
                        onClick={() =>
                          ask({
                            title: "removeRemoteQuestion",
                            message: { key: "removeRemoteDescription", values: { name } },
                            label: "removeRemote",
                            destructive: true,
                            action: { kind: "removeRemote", name },
                          })
                        }
                      >
                        <X size={17} />
                      </button>
                    </div>
                  ))}
                  {!repo.remotes.length && <p className="empty-list">{t("noRemotes")}</p>}
                </div>
              )}
            </main>
          )}
        </div>
      )}

      <footer className="statusbar">
        <span className="status-item" role={restoring ? "status" : undefined}>
          <CircleDot size={12} className={isEmpty ? undefined : "connected"} />
          {restoring
            ? t("restoreRepositories")
            : busy
              ? t("runningGit")
              : isEmpty
                ? t("noRepositoryOpen")
                : t("localRepository")}
        </span>
        {!isEmpty && (
          <>
            <span className="status-divider" />
            <span className="status-item">
              <GitBranch size={13} />
              {branch ?? t("detachedHead")}
            </span>
          </>
        )}
        {repo.status.upstream && (
          <>
            <span className="status-divider" />
            <span className="status-item status-upstream">
              <ArrowUpRight size={13} />
              {repo.status.upstream}
            </span>
          </>
        )}
        <span className="footer-spacer" />
        {sign && (
          <span className="status-item">
            <KeyRound size={13} />
            {t("signingEnabled")}
          </span>
        )}
        <span className="status-item">
          <Code2 size={15} />
          Git
        </span>
        <span className="status-divider" />
        <span className="status-item" title={t("appVersion", { version: appVersion })}>
          v{appVersion}
        </span>
      </footer>

      {notice && !modal && active && (
        <Notice {...notice} autoDismiss onDismiss={() => setNotice(null)} />
      )}

      {active && (
        <OperationContext value={activity}>
          <WorkspaceDialogHost
            repo={repo}
            busy={busy}
            dialogs={dialogs}
            action={action}
            cloneRepository={cloneRepository}
            setNotice={setNotice}
          />
        </OperationContext>
      )}
      {toolsVisible && <ExternalTools onClose={() => setToolsVisible(false)} />}
    </div>
  );
}
