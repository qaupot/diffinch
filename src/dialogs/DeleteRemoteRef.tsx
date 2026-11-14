import { useEffect, useId, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "../i18n";
import { git, type Action, type RemoteRefKind, type RemoteRefs, type Snapshot } from "../lib/git";

import GitModal from "./GitModal";

export default function DeleteRemoteRef({
  kind,
  repo,
  initialRemote = "",
  initialName = "",
  busy,
  error,
  onClose,
  onResetError,
  onDelete,
}: {
  kind: RemoteRefKind;
  repo: Snapshot;
  initialRemote?: string;
  initialName?: string;
  busy: boolean;
  error: LocalizedMessage | null;
  onClose: () => void;
  onResetError: () => void;
  onDelete: (action: Extract<Action, { kind: "deleteRemoteRef" }>) => void;
}) {
  const { t } = useTranslation();
  const [remote, setRemote] = useState(initialRemote);
  const [name, setName] = useState(initialName);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<RemoteRefs | null>(null);
  const [loadError, setLoadError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(!!initialRemote);
  const isBranch = kind === "branch";
  const title = isBranch ? "deleteRemoteBranch" : "deleteRemoteTag";
  const remoteId = useId();
  const refId = useId();
  const selected = result?.refs.find((ref) => ref.name === name);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    setLoading(!!remote);
    if (!remote) return;
    void git.remoteRefs(repo.path, remote, kind).then(
      (result) => {
        if (cancelled) return;
        setResult(result);
        setLoading(false);
      },
      (error) => {
        if (cancelled) return;
        setLoadError(errorMessage(error));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo.path, remote, kind, revision]);

  function load(next: string) {
    setRemote(next);
    if (next !== remote) setName("");
    setResult(null);
    onResetError();
    setRevision((value) => value + 1);
  }

  return (
    <GitModal title={t(title)} onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected && result && !busy && !loading) {
            onDelete({
              kind: "deleteRemoteRef",
              refKind: kind,
              remote,
              name,
              tip: selected.tip,
              destination: result.destination,
            });
          }
        }}
      >
        <label>
          <span id={remoteId}>{t("remote")}</span>
          <select
            aria-labelledby={remoteId}
            autoFocus
            value={remote}
            disabled={busy || loading}
            onChange={(event) => {
              load(event.target.value);
            }}
          >
            <option value="">{t("chooseRemote")}</option>
            {repo.remotes.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {loading && <p role="status">{t("working")}</p>}
        {result && <p className="muted">{result.url}</p>}
        {result &&
          (result.refs.length ? (
            <label>
              <span id={refId}>{t(isBranch ? "remoteBranch" : "remoteTag")}</span>
              <select
                aria-labelledby={refId}
                required
                value={name}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  onResetError();
                }}
              >
                <option value="">{t(isBranch ? "chooseRemoteBranch" : "chooseRemoteTag")}</option>
                {result.refs.map(({ name }) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>{t(isBranch ? "noRemoteBranches" : "noRemoteTags")}</p>
          ))}
        {selected && (
          <p className="confirmation-message">
            {t(isBranch ? "deleteRemoteBranchDescription" : "deleteRemoteTagDescription", {
              name: selected.name,
              remote,
              id: selected.tip.slice(0, 12),
            })}
          </p>
        )}
        {loadError && (
          <p className="modal-error" role="alert">
            {t(loadError.key, loadError.values)}
          </p>
        )}
        {error && !loading && selected && (
          <p className="modal-error" role="alert">
            {t(error.key, error.values)}
          </p>
        )}
        <div className="modal-actions">
          {remote && (
            <button
              className="plain-button"
              type="button"
              disabled={busy || loading}
              onClick={() => {
                load(remote);
              }}
            >
              {t("reloadRefs")}
            </button>
          )}
          <button className="plain-button" type="button" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="primary-button danger"
            type="submit"
            disabled={busy || loading || !selected}
          >
            {t(busy ? "working" : title)}
          </button>
        </div>
      </form>
    </GitModal>
  );
}
