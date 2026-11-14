import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import type { GitActivity } from "./useGitActivity";

export const OperationContext = createContext<GitActivity | null>(null);

export default function OperationProgress({ activity }: { activity?: GitActivity }) {
  const context = useContext(OperationContext);
  const { t } = useTranslation();
  const current = activity ?? context;
  const transfer = current?.transfer;
  const transferId = transfer?.id;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!transferId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [transferId]);
  if (!transfer || !current) return null;
  const seconds = Math.max(0, Math.floor((now - transfer.started) / 1000));
  const label =
    transfer.label ?? (transfer.kind === "clone" ? "cloningRepository" : "fetchingRepository");
  return (
    <div className="operation-bar transfer-bar">
      <span role="status">{t(transfer.cancelling ? "cancellingOperation" : label)}</span>
      <progress
        value={transfer.percent || undefined}
        max={100}
        aria-label={t("operationProgress")}
      />
      <span>{t("operationElapsed", { seconds })}</span>
      <button
        type="button"
        className="plain-button"
        disabled={!transfer.ready || transfer.cancelling}
        onClick={current.cancelTransfer}
      >
        {t("cancel")}
      </button>
      {seconds >= 30 && <p className="operation-hint">{t("operationTakingLonger")}</p>}
    </div>
  );
}
