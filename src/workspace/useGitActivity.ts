import { useCallback, useRef, useState } from "react";
import { errorMessage } from "../i18n";
import { git } from "../lib/git";
import type { MessageKey } from "../i18n/messages";
import type { WorkspaceNotice } from "./types";

// Refreshes and Git actions share this gate for the lifetime of a repository tab.
export function useGitActivity(
  restoring: boolean,
  setNotice: (notice: WorkspaceNotice | null) => void,
) {
  const [working, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<{
    id: string;
    kind: "fetch" | "clone" | "operation";
    label?: MessageKey;
    started: number;
    percent: number;
    ready: boolean;
    cancelling: boolean;
  } | null>(null);
  const busy = restoring || working;
  const inFlight = useRef(false);
  const runTransfer = useCallback(
    async <T>(
      kind: "fetch" | "clone" | "operation",
      start: (id: string, progress: (percent: number) => void) => Promise<T>,
      label?: MessageKey,
    ) => {
      const id = crypto.randomUUID();
      setTransfer({
        id,
        kind,
        label,
        started: Date.now(),
        percent: 0,
        ready: false,
        cancelling: false,
      });
      try {
        return await start(id, (percent) =>
          setTransfer((current) =>
            current?.id === id ? { ...current, ready: true, percent } : current,
          ),
        );
      } finally {
        setTransfer((current) => (current?.id === id ? null : current));
      }
    },
    [],
  );

  function cancelTransfer() {
    if (!transfer) return;
    setTransfer({ ...transfer, cancelling: true });
    void git.cancelTransfer(transfer.id).catch((error: unknown) => {
      setNotice({ message: errorMessage(error), error: true });
      setTransfer((current) =>
        current?.id === transfer.id ? { ...current, cancelling: false } : current,
      );
    });
  }

  return { busy, inFlight, setBusy, transfer, runTransfer, cancelTransfer };
}
export type GitActivity = ReturnType<typeof useGitActivity>;
