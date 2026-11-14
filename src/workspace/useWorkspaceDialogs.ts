import { useState } from "react";
import type { LocalizedMessage } from "../i18n";
import type { AuthorPlan, RebasePlan, RemoteRefKind } from "../lib/git";
import type { Confirm, Modal, Values } from "./types";

export function useWorkspaceDialogs(closeMenu: () => void) {
  const [modal, setModal] = useState<Modal | null>(null);
  const [values, setValues] = useState<Values>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [remoteDeleteKind, setRemoteDeleteKind] = useState<RemoteRefKind>("branch");
  const [rebaseDraft, setRebaseDraft] = useState<{ plan: RebasePlan; label: string } | null>(null);
  const [authorDraft, setAuthorDraft] = useState<AuthorPlan | null>(null);
  const [modalError, setModalError] = useState<LocalizedMessage | null>(null);
  function showModal(next: Modal, initial: Values = {}) {
    closeMenu();
    setModalError(null);
    setValues(initial);
    setModal(next);
  }

  function ask(question: Confirm) {
    setConfirm(question);
    showModal("confirm");
  }

  function openRemoteDelete(kind: RemoteRefKind, target?: { remote: string; name: string }) {
    setRemoteDeleteKind(kind);
    showModal("deleteRemoteRef", target);
  }

  return {
    modal,
    setModal,
    values,
    setValues,
    confirm,
    remoteDeleteKind,
    rebaseDraft,
    setRebaseDraft,
    authorDraft,
    setAuthorDraft,
    modalError,
    setModalError,
    showModal,
    ask,
    openRemoteDelete,
  };
}
export type WorkspaceDialogs = ReturnType<typeof useWorkspaceDialogs>;
