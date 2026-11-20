import { useEffect, useState } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import { splitCommitMessage } from "./lib/commits";
import { git, type Commit } from "./lib/git";

export default function GraphCommitDescription({ path, commit }: { path: string; commit: Commit }) {
  const { t } = useTranslation();
  const { id, subject, description } = commit;
  const [loaded, setLoaded] = useState<string | LocalizedMessage | null>(null);

  useEffect(() => {
    if (!path || description !== undefined) return;
    let current = true;
    git.commitMessage(path, id).then(
      (message) => {
        if (current) setLoaded(splitCommitMessage(message).description);
      },
      (error: unknown) => {
        if (current) setLoaded(errorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [path, id, description]);

  const body = description ?? (path ? loaded : "");
  return (
    <section className="commit-message" aria-label={t("commitDescription")}>
      <strong>{subject || t("noSubject")}</strong>
      {body === null ? (
        <p className="muted" role="status">
          {t("loadingCommitDescription")}
        </p>
      ) : typeof body !== "string" ? (
        <p className="modal-error" role="alert">
          {t(body.key, body.values)}
        </p>
      ) : body ? (
        <p>{body}</p>
      ) : (
        <p className="muted">{t("noCommitDescription")}</p>
      )}
    </section>
  );
}
