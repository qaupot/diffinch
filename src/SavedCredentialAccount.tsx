import { useEffect, useRef, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import { git, type CredentialAccount } from "./lib/git";

export default function SavedCredentialAccount({
  path,
  remote,
  destination,
  disabled,
}: {
  path: string;
  remote: string;
  destination: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);
  const [account, setAccount] = useState<CredentialAccount | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);

  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [],
  );

  async function checkAccount() {
    if (disabled || inFlight.current) return;
    const version = ++requestVersion.current;
    inFlight.current = true;
    setChecking(true);
    setAccount(null);
    setError(null);
    try {
      const result = await git.credentialAccount(path, { remote, destination });
      if (requestVersion.current === version) setAccount(result);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      if (requestVersion.current === version) {
        inFlight.current = false;
        setChecking(false);
      }
    }
  }

  return (
    <div className="credential-account">
      <button
        type="button"
        className="plain-button"
        disabled={disabled || checking}
        onClick={() => void checkAccount()}
      >
        {t(checking ? "checkingCredentialAccount" : "checkCredentialAccount")}
      </button>
      {checking && <p role="status">{t("checkingCredentialAccount")}</p>}
      {account && (
        <p role="status">
          {account.username === null ? (
            t("credentialAccountNotReturned")
          ) : (
            <>
              {t("savedCredentialUsername")}:{" "}
              <strong>
                <bdi>{account.username}</bdi>
              </strong>
            </>
          )}
        </p>
      )}
      {error && (
        <p className="modal-error" role="alert">
          {t(error.key, error.values)}
        </p>
      )}
      <p className="muted">{t("credentialAccountHelp")}</p>
    </div>
  );
}
