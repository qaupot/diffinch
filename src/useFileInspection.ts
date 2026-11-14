import { useEffect, useState } from "react";
import { errorMessage, type LocalizedMessage } from "./i18n";
import type { MessageKey } from "./i18n/messages";
import { git, type FileInspectionRequest, type FileInspectionResult } from "./lib/git";
import { useGitActivity } from "./workspace/useGitActivity";

export function useFileInspection<K extends FileInspectionRequest["kind"]>(
  path: string,
  request: Extract<FileInspectionRequest, { kind: K }> | null,
  label: MessageKey = "loadingFileHistory",
) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify({ path, request, attempt });
  const [loaded, setLoaded] = useState<{
    key: string;
    result?: FileInspectionResult;
    error?: LocalizedMessage;
  } | null>(null);
  const activity = useGitActivity(false, (notice) => {
    if (notice) setLoaded({ key, error: notice.message });
  });
  const { runTransfer } = activity;
  useEffect(() => {
    const query = (JSON.parse(key) as { request: FileInspectionRequest | null }).request;
    if (!query) return;
    let active = true;
    let id: string | undefined;
    let ready = false;
    const cancel = () => {
      if (id && ready) void git.cancelTransfer(id).catch(() => {});
    };
    void runTransfer(
      "operation",
      (operationId, progress) => {
        id = operationId;
        return git.inspectFile(path, query, operationId, (percent) => {
          ready = true;
          if (active) progress(percent);
          else cancel();
        });
      },
      label,
    )
      .then((result) => {
        if (active) setLoaded({ key, result });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ key, error: errorMessage(error) });
      });
    return () => {
      active = false;
      cancel();
    };
  }, [path, key, label, runTransfer]);
  const current = loaded?.key === key ? loaded : null;
  return {
    data: (current?.result?.kind === request?.kind ? current?.result?.data : undefined) as
      Extract<FileInspectionResult, { kind: K }>["data"] | undefined,
    error: current?.error,
    pending: !!request && !current,
    retry: () => setAttempt((value) => value + 1),
    activity,
  };
}
