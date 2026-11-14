import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { version } from "../../package.json";
import noticesUrl from "../../THIRD_PARTY_NOTICES.txt?url";
import { useTranslation } from "../i18n";
import { ArrowLeft, BookOpen } from "../icons";
import GitModal from "./GitModal";

export default function About({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [showLicenses, setShowLicenses] = useState(false);
  const [notices, setNotices] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const licensesButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (showLicenses) content.current?.focus();
    else licensesButton.current?.focus();
  }, [showLicenses]);
  useEffect(() => {
    if (!showLicenses || notices !== null) return;
    const controller = new AbortController();
    setFailed(false);
    void fetch(noticesUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load licenses: ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) setNotices(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [showLicenses, notices, attempt]);

  return (
    <GitModal
      title={t(showLicenses ? "openSourceLicenses" : "aboutDiffinch")}
      onClose={onClose}
      className={`about-dialog${showLicenses ? " licenses-dialog" : ""}`}
    >
      {showLicenses ? (
        <>
          <div className="licenses-toolbar">
            <button className="plain-button" onClick={() => setShowLicenses(false)}>
              <ArrowLeft size={15} aria-hidden="true" />
              {t("aboutDiffinch")}
            </button>
          </div>
          <div
            ref={content}
            className="licenses-content"
            tabIndex={0}
            role="region"
            aria-label={t("openSourceLicenses")}
          >
            {notices !== null ? (
              <pre lang="en">{notices}</pre>
            ) : failed ? (
              <>
                <p role="alert">{t("licensesLoadError")}</p>
                <button className="plain-button" onClick={() => setAttempt((value) => value + 1)}>
                  {t("retryLicenses")}
                </button>
              </>
            ) : (
              <p role="status">{t("loadingLicenses")}</p>
            )}
          </div>
        </>
      ) : (
        <div className="about-content">
          <img src="/finch.png" alt="" width={64} height={64} />
          <h3>Diffinch</h3>
          <p className="muted">{t("appVersion", { version })}</p>
          <p>{t("aboutDescription")}</p>
          <p className="muted">Copyright © 2026 qaupot · MIT</p>
          <button
            ref={licensesButton}
            className="plain-button"
            onClick={() => setShowLicenses(true)}
          >
            <BookOpen size={16} aria-hidden="true" />
            {t("openSourceLicenses")}
          </button>
        </div>
      )}
    </GitModal>
  );
}
