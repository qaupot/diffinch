import RemoteCredentials from "../RemoteCredentials";
import ActionDialog, { type CloneRequest } from "../dialogs/ActionDialog";
import DeleteRemoteRef from "../dialogs/DeleteRemoteRef";
import ChangeAuthor from "../dialogs/ChangeAuthor";
import InteractiveRebase from "../dialogs/InteractiveRebase";
import Manual from "../dialogs/Manual";
import { git, type Action, type Snapshot } from "../lib/git";
import type { WorkspaceNotice } from "./types";
import type { WorkspaceDialogs } from "./useWorkspaceDialogs";

export default function WorkspaceDialogHost({
  repo,
  busy,
  dialogs,
  action,
  cloneRepository,
  setNotice,
}: {
  repo: Snapshot;
  busy: boolean;
  dialogs: WorkspaceDialogs;
  action: (action: Action, fromModal?: boolean) => Promise<void>;
  cloneRepository: (request: CloneRequest) => Promise<void>;
  setNotice: (notice: WorkspaceNotice | null) => void;
}) {
  const {
    modal,
    setModal,
    values,
    setValues,
    confirm,
    remoteDeleteKind,
    rebaseDraft,
    authorDraft,
    modalError,
    setModalError,
  } = dialogs;
  const actionModal =
    modal === "manual" ||
    modal === "interactiveRebase" ||
    modal === "changeAuthor" ||
    modal === "deleteRemoteRef" ||
    modal === "credentials"
      ? null
      : modal;
  return (
    <>
      {modal === "manual" && <Manual onClose={() => setModal(null)} />}
      {modal === "changeAuthor" && authorDraft && (
        <ChangeAuthor
          plan={authorDraft}
          busy={busy}
          error={modalError}
          onClose={() => {
            if (!busy) setModal(null);
          }}
          onSubmit={(next) => {
            void action(next, true);
          }}
        />
      )}
      {modal === "credentials" && (
        <RemoteCredentials
          path={repo.path}
          remotes={repo.remotes}
          remote={typeof values.remote === "string" ? values.remote : undefined}
          authenticationRequired={values.authenticationRequired === true}
          onClose={() => setModal(null)}
          onComplete={(key) => {
            setModal(null);
            setNotice({ message: { key }, error: false });
          }}
        />
      )}
      {modal === "deleteRemoteRef" && (
        <DeleteRemoteRef
          kind={remoteDeleteKind}
          repo={repo}
          initialRemote={typeof values.remote === "string" ? values.remote : undefined}
          initialName={typeof values.name === "string" ? values.name : undefined}
          busy={busy}
          error={modalError}
          onClose={() => {
            if (!busy) setModal(null);
          }}
          onResetError={() => setModalError(null)}
          onDelete={(next) => {
            void action(next, true);
          }}
        />
      )}
      {modal === "interactiveRebase" && rebaseDraft && (
        <InteractiveRebase
          plan={rebaseDraft.plan}
          baseLabel={rebaseDraft.label}
          busy={busy}
          error={modalError}
          loadMessage={(id) => git.commitMessage(repo.path, id)}
          onClose={() => {
            if (!busy) setModal(null);
          }}
          onSubmit={(steps) => {
            const { branch, head, base, fromRoot } = rebaseDraft.plan;
            void action({ kind: "interactiveRebase", branch, head, base, fromRoot, steps }, true);
          }}
        />
      )}
      {actionModal && (
        <ActionDialog
          key={actionModal}
          modal={actionModal}
          repo={repo}
          busy={busy}
          values={values}
          setValues={setValues}
          confirm={confirm}
          error={modalError}
          onError={setModalError}
          onClose={() => {
            if (!busy) setModal(null);
          }}
          onSubmit={(next) => {
            void action(next, true);
          }}
          onClone={(request) => {
            void cloneRepository(request);
          }}
        />
      )}
    </>
  );
}
