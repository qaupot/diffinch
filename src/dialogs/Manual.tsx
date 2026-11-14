import { version as appVersion } from "../../package.json";
import { useTranslation } from "../i18n";

import GitModal from "./GitModal";

export default function Manual({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const steps = [
    { title: "manualOpenRepository", body: t("manualOpenRepositoryHelp") },
    { title: "worktrees", body: t("manualWorktreesHelp") },
    {
      title: "manualReview",
      body: t("manualReviewHelp", {
        changes: t("changes"),
        unified: t("unified"),
        split: t("split"),
      }),
    },
    {
      title: "manualCommit",
      body: t("manualCommitHelp", { summary: t("summary"), settings: t("repositorySettings") }),
    },
    {
      title: "manualHistory",
      body: t("manualHistoryHelp", { history: t("history"), actions: t("commitActions") }),
    },
    { title: "submodules", body: t("submodulesHelp") },
    { title: "subtrees", body: t("subtreesHelp") },
    { title: "lfs", body: t("lfsHelp") },
    {
      title: "manualSync",
      body: t("manualSyncHelp", {
        fetch: t("fetch"),
        pull: t("pull"),
        push: t("push"),
        publish: t("publish"),
      }),
    },
    {
      title: "manualRebase",
      body: t("manualRebaseHelp", {
        actions: t("gitActions"),
        interactive: t("interactiveRebaseFrom"),
        fromRoot: t("interactiveRebaseFromRoot"),
      }),
    },
  ] as const;
  return (
    <GitModal title={t("manual")} onClose={onClose} className="manual-dialog">
      <section className="manual-content" tabIndex={0} aria-label={t("manualQuickStart")}>
        <p className="muted">{t("appVersion", { version: appVersion })}</p>
        <p>{t("manualIntro")}</p>
        <ol>
          {steps.map(({ title, body }) => (
            <li key={title}>
              <h3>{t(title)}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
        <p className="manual-note">{t("manualSystemGit")}</p>
      </section>
    </GitModal>
  );
}
