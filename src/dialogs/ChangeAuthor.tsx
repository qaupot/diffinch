import { useState } from "react";
import { useTranslation, type LocalizedMessage } from "../i18n";
import type { Action, AuthorPlan } from "../lib/git";
import GitModal from "./GitModal";

export default function ChangeAuthor({
  plan,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  plan: AuthorPlan;
  busy: boolean;
  error: LocalizedMessage | null;
  onClose: () => void;
  onSubmit: (action: Extract<Action, { kind: "changeAuthor" }>) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(plan.name);
  const [email, setEmail] = useState(plan.email);
  const [confirmed, setConfirmed] = useState(false);
  const invalid =
    !name.trim() || !email.trim() || /[<>\p{Cc}]/u.test(name + email) || /\s/u.test(email.trim());
  const changed = name.trim() !== plan.name || email.trim() !== plan.email;
  const canSubmit = !busy && !invalid && changed && confirmed;
  return (
    <GitModal title={t("changeCommitAuthor")} onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            kind: "changeAuthor",
            branch: plan.branch,
            head: plan.head,
            id: plan.id,
            name: name.trim(),
            email: email.trim(),
          });
        }}
      >
        <p>
          <code>{plan.id.slice(0, 12)}</code> · {plan.subject}
        </p>
        <p>{t("currentCommitAuthor", { name: plan.name, email: plan.email })}</p>
        <label>
          {t("authorName")}
          <input
            required
            value={name}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          {t("authorEmail")}
          <input
            required
            type="email"
            value={email}
            disabled={busy}
            onChange={(event) => {
              setEmail(event.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <p>{t("changeAuthorScope", { branch: plan.branch, count: plan.affectedCommits })}</p>
        <p>{t("changeAuthorWarning")}</p>
        <label className="check-line">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t("confirmAuthorRewrite")}
        </label>
        {error && (
          <p className="modal-error" role="alert">
            {t(error.key, error.values)}
          </p>
        )}
        <div className="modal-actions">
          <button className="plain-button" type="button" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {t(busy ? "working" : "changeCommitAuthor")}
          </button>
        </div>
      </form>
    </GitModal>
  );
}
