import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "../i18n";
import type { MessageKey } from "../i18n/messages";
import { branchRef } from "../lib/branches";
import { git, type Action, type Settings, type Snapshot, type WorktreeMode } from "../lib/git";
import type { ActionModal, Confirm, Values } from "../workspace/types";
import GitModal from "./GitModal";

export type CloneRequest = { url: string; parent: string; name: string };

export default function ActionDialog({
  modal,
  repo,
  busy,
  values,
  setValues,
  confirm,
  error,
  onError,
  onClose,
  onSubmit,
  onClone,
}: {
  modal: ActionModal;
  repo: Snapshot;
  busy: boolean;
  values: Values;
  setValues: Dispatch<SetStateAction<Values>>;
  confirm: Confirm | null;
  error: LocalizedMessage | null;
  onError: (error: LocalizedMessage) => void;
  onClose: () => void;
  onSubmit: (action: Action) => void;
  onClone: (request: CloneRequest) => void;
}) {
  const { t } = useTranslation();
  const localBranches = repo.branches.filter((item) => !item.remote);
  const [rebaseContext] = useState(() => ({
    target: { branch: repo.status.branch, head: repo.status.head },
    branches: repo.branches.filter((item) => !item.current),
  }));
  const rebaseTargets = rebaseContext.branches;
  async function pickCloneFolder() {
    try {
      const path = await git.chooseFolder(t("destinationFolder"));
      if (path) setValues((previous) => ({ ...previous, parent: path }));
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  function val(key: string) {
    return typeof values[key] === "string" ? values[key] : "";
  }

  function update(key: string, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submitModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (modal === "clone") {
      if (!val("parent")) {
        onError({ key: "destinationRequired" });
        return;
      }
      onClone({ url: val("url"), parent: val("parent"), name: val("name") });
      return;
    }
    const settings: Settings = {
      name: val("name"),
      email: val("email"),
      signCommits: values.signCommits === true,
      signingFormat: val("signingFormat"),
      signingKey: val("signingKey"),
    };
    const name = val("name").trim();
    const rebaseTarget = rebaseTargets.find((item) => branchRef(item) === val("target"));
    if (modal === "worktree" && !val("parent")) {
      onError({ key: "destinationRequired" });
      return;
    }
    const actions: Record<Exclude<ActionModal, "clone">, Action | undefined> = {
      branch: {
        kind: "createBranch",
        name,
        checkout: values.checkout === true,
        start: val("start") || undefined,
      },
      worktree: {
        kind: "createWorktree",
        parent: val("parent"),
        name,
        mode: val("mode") as WorktreeMode,
        branch: val("branch").trim(),
        start: val("start").trim(),
      },
      stash: {
        kind: "stash",
        message: val("message"),
        includeUntracked: values.includeUntracked === true,
      },
      tag: { kind: "createTag", name, start: val("start") || undefined },
      remote: { kind: "addRemote", name, url: val("url") },
      publish: { kind: "publish", remote: val("remote") },
      settings: { kind: "saveSettings", settings },
      confirm: confirm?.action,
      rebase: rebaseTarget && {
        kind: "rebase",
        name: rebaseTarget.name,
        remote: rebaseTarget.remote,
        tip: rebaseTarget.tip,
        target: rebaseContext.target,
      },
    };
    const next = actions[modal];
    if (next) onSubmit(next);
  }

  const modalTitle = modal
    ? (
        {
          clone: "cloneRepository",
          branch: "newBranch",
          worktree: "createWorktree",
          stash: "stashChanges",
          tag: "newTag",
          remote: "addRemote",
          publish: "publishBranch",
          settings: "repositorySettings",
          confirm: confirm?.title ?? "confirm",
          rebase: "rebaseQuestion",
        } satisfies Record<ActionModal, MessageKey | LocalizedMessage>
      )[modal]
    : "confirm";
  const modalLabel = modal
    ? (
        {
          clone: "clone",
          branch: "createBranch",
          worktree: "createWorktree",
          stash: "stashChanges",
          tag: "createTag",
          remote: "addRemote",
          publish: "publishBranch",
          settings: "saveSettings",
          confirm: confirm?.label ?? "continue",
          rebase: "rebaseBranch",
        } satisfies Record<ActionModal, MessageKey>
      )[modal]
    : "continue";

  return (
    <GitModal
      title={typeof modalTitle === "string" ? t(modalTitle) : t(modalTitle.key, modalTitle.values)}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="modal-form" onSubmit={submitModal}>
        {modal === "worktree" && (
          <>
            <p className="muted">{t("worktreesDescription")}</p>
            <label>
              {t("destinationFolder")}
              <div className="field-row">
                <input
                  required
                  value={val("parent")}
                  readOnly
                  placeholder={t("chooseDestination")}
                />
                <button
                  type="button"
                  className="plain-button"
                  disabled={busy}
                  onClick={pickCloneFolder}
                >
                  {t("choose")}
                </button>
              </div>
            </label>
            <label>
              {t("folderName")}
              <input
                required
                autoFocus
                disabled={busy}
                value={val("name")}
                onChange={(event) => update("name", event.target.value)}
              />
            </label>
            <label>
              {t("worktreeMode")}
              <select
                disabled={busy}
                value={val("mode")}
                onChange={(event) =>
                  setValues((current) => ({ ...current, mode: event.target.value, branch: "" }))
                }
              >
                <option value="newBranch">{t("newBranch")}</option>
                <option value="existingBranch">{t("existingBranch")}</option>
                <option value="detached">{t("detachedHead")}</option>
              </select>
            </label>
            {val("mode") === "newBranch" && (
              <label>
                {t("newBranch")}
                <input
                  required
                  disabled={busy}
                  value={val("branch")}
                  onChange={(event) => update("branch", event.target.value)}
                />
              </label>
            )}
            {val("mode") === "existingBranch" ? (
              <label>
                {t("localBranch")}
                <select
                  required
                  disabled={busy}
                  value={val("branch")}
                  onChange={(event) => update("branch", event.target.value)}
                >
                  <option value="">{t("chooseWorktreeBranch")}</option>
                  {localBranches.map((item) => (
                    <option
                      key={item.name}
                      value={item.name}
                      disabled={repo.worktrees.some((worktree) => worktree.branch === item.name)}
                    >
                      {item.name}
                    </option>
                  ))}
                </select>
                <small className="muted">{t("worktreeBranchHint")}</small>
              </label>
            ) : (
              <label>
                {t("worktreeStart")}
                <input
                  disabled={busy}
                  value={val("start")}
                  placeholder="HEAD"
                  onChange={(event) => update("start", event.target.value)}
                />
              </label>
            )}
          </>
        )}
        {modal === "clone" && (
          <>
            <label>
              {t("repositoryUrl")}
              <input
                required
                autoFocus
                value={val("url")}
                placeholder="https://host/owner/repository.git"
                onChange={(event) => {
                  const url = event.target.value;
                  setValues((current) => ({
                    ...current,
                    url,
                    ...(!current.editedName
                      ? {
                          name:
                            url
                              .trim()
                              .replace(/\/$/, "")
                              .split(/[/:]/)
                              .at(-1)
                              ?.replace(/\.git$/, "") ?? "",
                        }
                      : {}),
                  }));
                }}
              />
            </label>
            <label>
              {t("destinationFolder")}
              <div className="field-row">
                <input value={val("parent")} readOnly placeholder={t("chooseDestination")} />
                <button
                  type="button"
                  className="plain-button"
                  disabled={busy}
                  onClick={pickCloneFolder}
                >
                  {t("choose")}
                </button>
              </div>
            </label>
            <label>
              {t("folderName")}
              <input
                required
                value={val("name")}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    name: event.target.value,
                    editedName: true,
                  }))
                }
              />
            </label>
          </>
        )}
        {(modal === "branch" || modal === "tag" || modal === "remote" || modal === "settings") && (
          <label>
            {modal === "settings" ? t("authorName") : t("name")}
            <input
              required={modal !== "settings"}
              value={val("name")}
              onChange={(event) => update("name", event.target.value)}
            />
          </label>
        )}
        {(modal === "branch" || modal === "tag") && val("startLabel") && (
          <p className="muted">
            {t("startingCommit")} <strong>{val("startLabel")}</strong>
          </p>
        )}
        {modal === "branch" && (
          <label className="check-line">
            <input
              type="checkbox"
              checked={values.checkout === true}
              onChange={(event) => update("checkout", event.target.checked)}
            />
            {t("switchToNewBranch")}
          </label>
        )}
        {modal === "stash" && (
          <>
            <label>
              {t("message")}
              <input
                value={val("message")}
                placeholder={t("optionalDescription")}
                onChange={(event) => update("message", event.target.value)}
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={values.includeUntracked === true}
                onChange={(event) => update("includeUntracked", event.target.checked)}
              />
              {t("includeUntracked")}
            </label>
          </>
        )}
        {modal === "remote" && (
          <label>
            {t("remoteUrl")}
            <input
              required
              value={val("url")}
              onChange={(event) => update("url", event.target.value)}
            />
          </label>
        )}
        {modal === "publish" && (
          <label>
            {t("remote")}
            <select
              value={val("remote")}
              onChange={(event) => update("remote", event.target.value)}
            >
              {repo.remotes.map((remote) => (
                <option key={remote.name}>{remote.name}</option>
              ))}
            </select>
          </label>
        )}
        {modal === "rebase" && (
          <>
            <label>
              {t("rebaseTarget")}
              <select
                required
                value={val("target")}
                onChange={(event) => update("target", event.target.value)}
              >
                {rebaseTargets.map((item) => (
                  <option key={branchRef(item)} value={branchRef(item)}>
                    {t(item.remote ? "namedRemoteBranch" : "namedLocalBranch", { name: item.name })}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {t("rebaseDescription", {
                source: rebaseContext.target.branch ?? "HEAD",
                target: rebaseTargets.find((item) => branchRef(item) === val("target"))?.name ?? "",
              })}
            </p>
          </>
        )}
        {modal === "settings" && (
          <>
            <label>
              {t("authorEmail")}
              <input
                type="email"
                value={val("email")}
                onChange={(event) => update("email", event.target.value)}
              />
            </label>
            <label>
              {t("signingFormat")}
              <select
                value={val("signingFormat")}
                onChange={(event) => update("signingFormat", event.target.value)}
              >
                <option value="openpgp">OpenPGP</option>
                <option value="ssh">SSH</option>
                <option value="x509">X.509</option>
              </select>
            </label>
            <label>
              {t("signingKey")}
              <input
                value={val("signingKey")}
                placeholder={
                  val("signingFormat") === "ssh" ? "~/.ssh/id_ed25519.pub" : t("keyIdOrCertificate")
                }
                onChange={(event) => update("signingKey", event.target.value)}
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={values.signCommits === true}
                onChange={(event) => update("signCommits", event.target.checked)}
              />
              {t("signByDefault")}
            </label>
            <p className="muted">{t("settingsDescription")}</p>
          </>
        )}
        {modal === "confirm" && (
          <p className="confirmation-message">
            {confirm && t(confirm.message.key, confirm.message.values)}
          </p>
        )}
        {error && (
          <p className="modal-error" role="alert">
            {t(error.key, error.values)}
          </p>
        )}
        <div className="modal-actions">
          <button className="plain-button" type="button" disabled={busy} onClick={() => onClose()}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className={`primary-button ${modal === "confirm" && confirm?.destructive ? "danger" : ""}`}
            disabled={busy}
          >
            {t(busy ? "working" : modalLabel)}
          </button>
        </div>
      </form>
    </GitModal>
  );
}
