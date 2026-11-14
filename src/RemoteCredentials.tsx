import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import type { MessageKey } from "./i18n/messages";
import { KeyRound, X } from "./icons";
import { git, type CredentialHelper, type CredentialTarget, type Snapshot } from "./lib/git";
import SavedCredentialAccount from "./SavedCredentialAccount";

const helperLabels: Record<CredentialHelper, MessageKey> = {
  osxkeychain: "credentialHelperKeychain",
  manager: "credentialHelperManager",
  "manager-core": "credentialHelperManagerCore",
  libsecret: "credentialHelperLibsecret",
  wincred: "credentialHelperWincred",
  cache: "credentialHelperCache",
};

export default function RemoteCredentials({
  path,
  remotes,
  remote: initialRemote,
  authenticationRequired = false,
  onClose,
  onComplete,
}: {
  path: string;
  remotes: Snapshot["remotes"];
  remote?: string;
  authenticationRequired?: boolean;
  onClose: () => void;
  onComplete: (key: MessageKey) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const requestVersion = useRef(0);
  const [remote, setRemote] = useState(
    initialRemote ?? (remotes.length === 1 ? remotes[0].name : ""),
  );
  const [targets, setTargets] = useState<CredentialTarget[]>([]);
  const [destination, setDestination] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [retry, setRetry] = useState(0);
  const [helperChoice, setHelperChoice] = useState<
    CredentialHelper | "inherited" | "custom" | null
  >(null);
  const [helperSaved, setHelperSaved] = useState(false);
  const target = targets.find((item) => item.destination === destination);
  const supported = target?.transport === "https";
  const helper = target?.helper;
  const selectedHelper = helperChoice ?? helper?.current;
  const helperChanged = !!helper && selectedHelper !== helper.current;
  const canSave =
    supported && target.storage !== "unavailable" && !helperChanged && username.trim() && password;

  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);

  useEffect(() => {
    requestVersion.current += 1;
    let stale = false;
    inFlight.current = false;
    setBusy(false);
    setTargets([]);
    setDestination("");
    setUsername("");
    setPassword("");
    setForget(false);
    setError(null);
    setHelperChoice(null);
    setHelperSaved(false);
    if (!remote) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void git
      .credentialTargets(path, remote)
      .then((items) => {
        if (stale) return;
        setTargets(items);
        setDestination(items[0]?.destination ?? "");
      })
      .catch((reason: unknown) => {
        if (!stale) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
      requestVersion.current += 1;
    };
  }, [path, remote, retry]);

  function close() {
    if (!inFlight.current) onClose();
  }

  async function submit(remove: boolean) {
    if (inFlight.current || helperChanged || !target || !username.trim() || (!remove && !canSave))
      return;
    const version = requestVersion.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const key = await git.updateCredentials(path, {
        remote,
        destination,
        username: username.trim(),
        password: remove ? null : password,
      });
      if (requestVersion.current === version) onComplete(key);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      if (requestVersion.current === version) {
        setPassword("");
        setForget(false);
        setBusy(false);
        inFlight.current = false;
      }
    }
  }

  async function saveHelper() {
    if (
      inFlight.current ||
      !target ||
      !helper ||
      !helperChanged ||
      !selectedHelper ||
      selectedHelper === "custom"
    )
      return;
    const version = requestVersion.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setPassword("");
    setForget(false);
    setHelperSaved(false);
    try {
      await git.action(path, {
        kind: "configureCredentialHelper",
        remote,
        destination,
        helper: selectedHelper === "inherited" ? null : selectedHelper,
        token: helper.token,
      });
      if (requestVersion.current !== version) return;
      // Configuration was saved; discard the old target before refreshing so
      // a refresh failure cannot leave credential controls using stale settings.
      setTargets([]);
      setLoading(true);
      const items = await git.credentialTargets(path, remote);
      if (requestVersion.current !== version) return;
      setTargets(items);
      setDestination(
        items.find((item) => item.destination === destination)?.destination ??
          items[0]?.destination ??
          "",
      );
      setHelperChoice(null);
      setHelperSaved(true);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      if (requestVersion.current === version) {
        setLoading(false);
        setBusy(false);
        inFlight.current = false;
      }
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-title">
        <h2 id={titleId}>{remote ? t("remoteCredentials", { name: remote }) : t("credentials")}</h2>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label={t("close")}
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <form
        className="modal-form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {authenticationRequired && <p role="alert">{t("credentialSignInHelp")}</p>}
        {remotes.length > 1 && (
          <label>
            {t("remote")}
            <select
              value={remote}
              disabled={busy}
              onChange={(event) => {
                setRemote(event.target.value);
                setTargets([]);
                setDestination("");
                setUsername("");
                setPassword("");
                setForget(false);
                setError(null);
                setHelperChoice(null);
                setHelperSaved(false);
              }}
            >
              <option value="" disabled>
                {t("chooseRemote")}
              </option>
              {remotes.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading ? (
          <p role="status">{t("loadingCredentials")}</p>
        ) : (
          target && (
            <>
              {targets.length > 1 ? (
                <label>
                  {t("credentialDestination")}
                  <select
                    aria-label={t("credentialDestination")}
                    value={destination}
                    disabled={busy}
                    onChange={(event) => {
                      setDestination(event.target.value);
                      setPassword("");
                      setUsername("");
                      setForget(false);
                      setError(null);
                      setHelperChoice(null);
                      setHelperSaved(false);
                    }}
                  >
                    {targets.map((item, index) => (
                      <option key={item.destination} value={item.destination}>
                        {t(
                          index === 0 ? "credentialFetchDestination" : "credentialPushDestination",
                        )}{" "}
                        · {item.url}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="credential-destination">{target.url}</p>
              )}
              {!supported ? (
                <p>{t(target.transport === "ssh" ? "credentialSshHelp" : "credentialHttpsOnly")}</p>
              ) : (
                <>
                  {helper && (
                    <div className="credential-helper-settings">
                      <div className="credential-helper-controls">
                        <label>
                          {t("credentialHelper")}
                          <select
                            value={selectedHelper}
                            disabled={busy}
                            onChange={(event) => {
                              setHelperChoice(event.target.value as typeof helper.current);
                              setPassword("");
                              setForget(false);
                              setHelperSaved(false);
                              setError(null);
                            }}
                          >
                            <option value="inherited">{t("credentialHelperInherited")}</option>
                            {helper.current === "custom" && (
                              <option value="custom">{t("credentialHelperCustom")}</option>
                            )}
                            {helper.current !== "inherited" &&
                              helper.current !== "custom" &&
                              !helper.available.includes(helper.current) && (
                                <option value={helper.current} disabled>
                                  {t(helperLabels[helper.current])}
                                </option>
                              )}
                            {helper.available.map((item) => (
                              <option key={item} value={item}>
                                {t(helperLabels[item])}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="plain-button"
                          disabled={busy || !helperChanged || selectedHelper === "custom"}
                          onClick={() => void saveHelper()}
                        >
                          {t("applyCredentialHelper")}
                        </button>
                      </div>
                      <p className="muted">{t("credentialHelperSetupHelp")}</p>
                      {helperSaved && <p role="status">{t("credentialHelperSaved")}</p>}
                    </div>
                  )}
                  <p>
                    {t(
                      target.storage === "keychain"
                        ? "credentialKeychainHelp"
                        : target.storage === "unavailable"
                          ? "credentialHelperMissing"
                          : "credentialStorageHelp",
                    )}
                  </p>
                  <p className="muted">{t("credentialScopeHelp")}</p>
                  {target.storage === "configured" && (
                    <SavedCredentialAccount
                      key={JSON.stringify([
                        path,
                        remote,
                        destination,
                        helper?.token,
                        selectedHelper,
                        busy,
                      ])}
                      path={path}
                      remote={remote}
                      destination={destination}
                      disabled={busy || helperChanged}
                    />
                  )}
                  {target.storage !== "unavailable" && (
                    <>
                      <label>
                        {t("credentialUsername")}
                        <input
                          autoFocus
                          required
                          value={username}
                          disabled={busy}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => {
                            setUsername(event.target.value);
                            setForget(false);
                          }}
                        />
                      </label>
                      <label>
                        {t("credentialPassword")}
                        <input
                          type="password"
                          required={!forget}
                          value={password}
                          disabled={busy}
                          autoComplete="new-password"
                          spellCheck={false}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </label>
                      <p className="muted">{t("credentialTokenHelp")}</p>
                    </>
                  )}
                </>
              )}
            </>
          )
        )}
        {error && (
          <p className="modal-error" role="alert">
            {t(error.key, error.values)}
          </p>
        )}
        {!loading && remote && !target && (
          <button type="button" className="plain-button" onClick={() => setRetry(retry + 1)}>
            {t("refresh")}
          </button>
        )}
        {forget && <p role="status">{t("credentialForgetConfirm", { username })}</p>}
        <div className="modal-actions">
          {supported && target.storage === "configured" && (
            <button
              type="button"
              className={`plain-button credential-forget${forget ? " danger" : ""}`}
              disabled={busy || helperChanged || !username.trim()}
              onClick={() => {
                if (forget) void submit(true);
                else {
                  setForget(true);
                  setPassword("");
                }
              }}
            >
              {t(forget ? "confirm" : "forgetCredentials")}
            </button>
          )}
          <button type="button" className="plain-button" disabled={busy} onClick={close}>
            {t("close")}
          </button>
          {supported && target.storage !== "unavailable" && (
            <button type="submit" className="primary-button" disabled={busy || !canSave}>
              <KeyRound size={15} />
              {t(busy ? "working" : "saveCredentials")}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
