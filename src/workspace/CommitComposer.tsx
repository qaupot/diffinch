import { useState, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { GitCommitHorizontal, ShieldCheck } from "../icons";
import { shortcut, type HeadTarget, type Snapshot } from "../lib/git";

export function useCommitDraft(initialSign: boolean) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [sign, setSign] = useState(initialSign);
  const [amend, setAmend] = useState<HeadTarget | null>(null);
  function reset() {
    setSummary("");
    setDescription("");
    setAmend(null);
  }
  return {
    summary,
    setSummary,
    description,
    setDescription,
    sign,
    setSign,
    amend,
    setAmend,
    reset,
  };
}

export default function CommitComposer({
  draft,
  repo,
  busy,
  canCommit,
  onCommit,
  onSettings,
  onAmendChange,
  discard,
}: {
  draft: ReturnType<typeof useCommitDraft>;
  repo: Snapshot;
  busy: boolean;
  canCommit: boolean;
  onCommit: () => void;
  onSettings: () => void;
  onAmendChange: (checked: boolean) => void;
  discard: ReactNode;
}) {
  const { t } = useTranslation();
  const { summary, setSummary, description, setDescription, sign, setSign, amend } = draft;
  const branch = repo.status.branch;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onCommit();
      }}
    >
      <div className="composer-title">
        <GitCommitHorizontal size={17} />
        <h2>{t("commit")}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onSettings}
          title={t("signingSettings")}
        >
          <ShieldCheck size={16} />
        </button>
      </div>
      <input
        disabled={busy}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder={t("summary")}
        aria-label={t("commitSummary")}
      />
      <textarea
        disabled={busy}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={t("optionalDescription")}
        aria-label={t("commitDescription")}
        rows={2}
      />
      <label className="check-line">
        <input
          type="checkbox"
          disabled={busy}
          checked={sign}
          onChange={(event) => setSign(event.target.checked)}
        />
        <ShieldCheck size={14} />
        {t("signCommit")}
      </label>
      <button className="primary-button commit-button" disabled={!canCommit} type="submit">
        <GitCommitHorizontal size={17} />
        <span>{amend ? t("amendCommit") : t("commitTo", { branch: branch ?? "HEAD" })}</span>
        <kbd>{shortcut}↵</kbd>
      </button>
      <div className="composer-bottom">
        <label className="check-line">
          <input
            type="checkbox"
            checked={amend !== null}
            disabled={busy || !repo.status.head || !!repo.operation}
            onChange={(event) => onAmendChange(event.target.checked)}
          />
          {t("amendLast")}
        </label>
        {discard}
      </div>
    </form>
  );
}
