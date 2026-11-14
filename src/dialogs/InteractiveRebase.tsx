import { useRef, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "../i18n";
import { type MessageKey } from "../i18n/messages";
import { ArrowDown, ArrowUp } from "../icons";
import {
  type RebaseCommit,
  type RebaseOperation,
  type RebasePlan,
  type RebaseStep,
} from "../lib/git";

import GitModal from "./GitModal";
const rebaseOperations = {
  pick: "rebasePick",
  reword: "rebaseReword",
  squash: "rebaseSquash",
  fixup: "rebaseFixup",
  drop: "rebaseDrop",
} satisfies Record<RebaseOperation, MessageKey>;

type DraftStep = RebaseCommit & {
  operation: RebaseOperation;
  message?: string;
  messageError?: LocalizedMessage;
};

export default function InteractiveRebase({
  plan,
  baseLabel,
  busy,
  error,
  loadMessage,
  onClose,
  onSubmit,
}: {
  plan: RebasePlan;
  baseLabel: string;
  busy: boolean;
  error: LocalizedMessage | null;
  loadMessage: (id: string) => Promise<string>;
  onClose: () => void;
  onSubmit: (steps: RebaseStep[]) => void;
}) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    plan.commits.map((commit) => ({ ...commit, operation: "pick" })),
  );
  const requestedMessages = useRef(new Set<string>());
  const firstKept = steps.findIndex(
    ({ operation }) => operation === "pick" || operation === "reword",
  );
  const invalidOrder = steps.some(
    ({ operation }, index) =>
      (operation === "squash" || operation === "fixup") && (firstKept === -1 || index < firstKept),
  );
  const emptyMessage = steps.some(
    ({ operation, message }) => operation === "reword" && message !== undefined && !message.trim(),
  );
  const loadingMessage = steps.some(
    ({ operation, message }) => operation === "reword" && message === undefined,
  );
  const dropsAll = steps.every(({ operation }) => operation === "drop");
  const canSubmit =
    !busy && !invalidOrder && !emptyMessage && !loadingMessage && !(plan.fromRoot && dropsAll);

  function updateStep(id: string, update: Partial<DraftStep>) {
    setSteps((current) => current.map((step) => (step.id === id ? { ...step, ...update } : step)));
  }

  async function changeOperation(id: string, operation: RebaseOperation) {
    updateStep(id, { operation });
    if (operation !== "reword" || requestedMessages.current.has(id)) return;
    requestedMessages.current.add(id);
    try {
      updateStep(id, { message: await loadMessage(id) });
    } catch (error) {
      updateStep(id, { message: "", messageError: errorMessage(error) });
    }
  }

  function move(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  }
  return (
    <GitModal title={t("interactiveRebase")} onClose={onClose} className="rebase-dialog">
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit(
            steps.map(({ id, operation, message }) =>
              operation === "reword"
                ? { id, operation, message: message ?? "" }
                : { id, operation },
            ),
          );
        }}
      >
        <p>
          {t(plan.fromRoot ? "interactiveRebaseRootDescription" : "interactiveRebaseDescription", {
            branch: plan.branch,
            base: baseLabel,
          })}
        </p>
        <ol className="rebase-steps" aria-label={t("rebaseCommits")}>
          {steps.map((step, index) => (
            <li key={step.id}>
              <select
                aria-label={t("rebaseActionFor", { id: step.shortId })}
                value={step.operation}
                disabled={busy}
                onChange={(event) => {
                  void changeOperation(step.id, event.target.value as RebaseOperation);
                }}
              >
                {(Object.keys(rebaseOperations) as RebaseOperation[]).map((operation) => (
                  <option key={operation} value={operation}>
                    {t(rebaseOperations[operation])}
                  </option>
                ))}
              </select>
              <div className="rebase-commit truncate">
                <code>{step.shortId}</code> <span title={step.subject}>{step.subject}</span>
              </div>
              <div className="rebase-order">
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || index === 0}
                  title={t("rebaseMoveUp", { id: step.shortId })}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || index === steps.length - 1}
                  title={t("rebaseMoveDown", { id: step.shortId })}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={15} />
                </button>
              </div>
              {step.operation === "reword" && (
                <div className="rebase-message">
                  <label>
                    {t("rebaseMessageFor", { id: step.shortId })}
                    <textarea
                      rows={4}
                      value={step.message ?? ""}
                      disabled={busy || step.message === undefined}
                      placeholder={
                        step.message === undefined ? t("rebaseLoadingMessage") : undefined
                      }
                      onChange={(event) =>
                        updateStep(step.id, {
                          message: event.target.value,
                          messageError: undefined,
                        })
                      }
                    />
                  </label>
                  {step.messageError && (
                    <p className="modal-error" role="alert">
                      {t(step.messageError.key, step.messageError.values)}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
        {invalidOrder && (
          <p className="modal-error" role="alert">
            {t("invalidRebasePlan")}
          </p>
        )}
        {emptyMessage && (
          <p className="modal-error" role="alert">
            {t("invalidRebaseMessage")}
          </p>
        )}
        {dropsAll &&
          (plan.fromRoot ? (
            <p className="modal-error" role="alert">
              {t("rebaseKeepRootHistory")}
            </p>
          ) : (
            <p>{t("rebaseDropsAll")}</p>
          ))}
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
            {t(busy ? "working" : "startRebase")}
          </button>
        </div>
      </form>
    </GitModal>
  );
}
