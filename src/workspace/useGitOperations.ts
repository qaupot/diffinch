import type { CloneRequest } from "../dialogs/ActionDialog";
import { errorMessage, useTranslation } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import { readHiddenBranches, visibleHistory } from "../lib/branches";
import { git, type Action, type FileChange, type Snapshot } from "../lib/git";
import type { useCommitDraft } from "./CommitComposer";
import { chooseSelection } from "./selection";
import type { WorkspaceNotice } from "./types";
import type { GitActivity } from "./useGitActivity";
import type { RepositoryState } from "./useRepositoryState";
import type { WorkspaceDialogs } from "./useWorkspaceDialogs";

export function useGitOperations({
  repository,
  activity,
  dialogs,
  draft,
  restoring,
  acceptRepo,
  forgetWorktree,
  closeMenu,
  onConflict,
  setNotice,
}: {
  repository: RepositoryState;
  activity: GitActivity;
  dialogs: WorkspaceDialogs;
  draft: ReturnType<typeof useCommitDraft>;
  restoring: boolean;
  acceptRepo: (snapshot: Snapshot, message?: MessageKey, sourcePath?: string) => void;
  forgetWorktree: (path: string) => void;
  closeMenu: () => void;
  onConflict: () => void;
  setNotice: (notice: WorkspaceNotice | null) => void;
}) {
  const { t } = useTranslation();
  const { repo, setRepo, hiddenBranches, historyDepth, viewRef, setSelection, setDiffRevision } =
    repository;
  const { inFlight, setBusy, runTransfer } = activity;
  const { setModal, setModalError } = dialogs;
  const { setSign } = draft;

  async function confirmDiscard(file: FileChange) {
    if (!repo.path || restoring || inFlight.current) return;
    inFlight.current = true;
    closeMenu();
    setNotice(null);
    setBusy(true);
    try {
      const plan = await git.discardPlan(repo.path, file.id);
      dialogs.ask({
        title: "discardQuestion",
        message: { key: "discardDescription", values: { path: file.path } },
        label: "discardChanges",
        destructive: true,
        action: { kind: "discard", ...plan },
      });
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function openRepo(kind: "open" | "init", givenPath?: string) {
    if (restoring || inFlight.current) return;
    inFlight.current = true;
    closeMenu();
    setNotice(null);
    setBusy(true);
    try {
      const path =
        givenPath ??
        (await git.chooseFolder(t(kind === "init" ? "initRepository" : "openRepository")));
      if (!path) return;
      const snapshot = await (kind === "init"
        ? git.init(path)
        : git.snapshot(path, undefined, readHiddenBranches(path)));
      acceptRepo(snapshot, undefined, repo.path);
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function action(next: Action, fromModal = false) {
    if (!repo.path || restoring || inFlight.current) return;
    closeMenu();
    setNotice(null);
    setModalError(null);
    inFlight.current = true;
    setBusy(true);
    let completed = false;
    try {
      const key =
        next.kind === "fetch" || next.kind === "fetchPrune"
          ? await runTransfer("fetch", (id, progress) =>
              git.fetch(repo.path, next.kind === "fetchPrune", id, progress),
            )
          : await runTransfer(
              "operation",
              (id, progress) => git.action(repo.path, next, id, progress),
              next.kind === "push" || next.kind === "publish" || next.kind === "forcePush"
                ? "pushingRepository"
                : next.kind === "pull" || next.kind === "pullRebase"
                  ? "pullingRepository"
                  : next.kind === "commit"
                    ? "creatingCommit"
                    : next.kind === "mergeTool"
                      ? "runningMergeTool"
                      : "runningGitOperation",
            );
      completed = true;
      if (next.kind === "removeWorktree") forgetWorktree(next.path);
      if (fromModal) setModal(null);
      if (next.kind === "commit") {
        draft.reset();
      }
      const snapshot = await git.snapshot(repo.path, historyDepth.current, hiddenBranches);
      if (next.kind === "saveSettings") setSign(snapshot.settings.signCommits);
      setRepo(snapshot);
      setDiffRevision((revision) => revision + 1);
      setSelection((current) =>
        chooseSelection(
          visibleHistory(snapshot, hiddenBranches),
          viewRef.current,
          next.kind === "changeAuthor" && snapshot.status.head
            ? { kind: "commit", id: snapshot.status.head }
            : current,
        ),
      );
      setNotice({ message: { key }, error: false });
      if (next.kind === "createWorktree") {
        const opened = await git.snapshot(`${next.parent}/${next.name}`);
        acceptRepo(opened, "worktreeCreated", repo.path);
      }
    } catch (error) {
      const message = errorMessage(error);
      const needsCredentials =
        !completed &&
        message.key === "authenticationRequired" &&
        repo.remotes.length > 0 &&
        [
          "fetch",
          "fetchPrune",
          "pull",
          "pullRebase",
          "push",
          "publish",
          "forcePush",
          "deleteRemoteRef",
        ].includes(next.kind);
      if (needsCredentials) {
        const remote =
          "remote" in next && typeof next.remote === "string"
            ? next.remote
            : next.kind === "forcePush"
              ? next.lease.remote
              : undefined;
        dialogs.showModal("credentials", {
          ...(remote ? { remote } : {}),
          authenticationRequired: true,
        });
        setNotice({ message, error: true });
      } else if (fromModal && !completed && message.key !== "operationInterrupted")
        setModalError(message);
      else setNotice({ message, error: message.key !== "transferCancelled" });
      if (message.key === "operationInterrupted") setModal(null);
      if (!completed) {
        try {
          const snapshot = await git.snapshot(repo.path, historyDepth.current, hiddenBranches);
          setRepo(snapshot);
          setDiffRevision((revision) => revision + 1);
          if (!repo.operation && snapshot.operation) {
            setModal(null);
            onConflict();
            setNotice({ message, error: true });
          }
          // A conflicted operation can change the index even when Git exits with an error.
          setSelection((current) =>
            chooseSelection(visibleHistory(snapshot, hiddenBranches), viewRef.current, current),
          );
        } catch {
          /* Retain the original Git error. */
        }
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function cloneRepository(request: CloneRequest) {
    if (restoring || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setModalError(null);
    setModal(null);
    try {
      const snapshot = await runTransfer("clone", (id, progress) =>
        git.clone(request.url, request.parent, request.name, id, progress),
      );
      acceptRepo(snapshot, "repositoryCloned", repo.path);
    } catch (error) {
      const message = errorMessage(error);
      setNotice({ message, error: message.key !== "transferCancelled" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { openRepo, action, cloneRepository, confirmDiscard };
}
