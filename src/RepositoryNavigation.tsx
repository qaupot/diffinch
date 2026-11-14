import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "./i18n";
import { ChevronDown, ChevronRight } from "./icons";
import { preferences } from "./lib/preferences";

export default function RepositoryNavigation({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const key = `diffinch.repositoryMenu:${path || "example"}`;
  const [expanded, setExpanded] = useState(() => preferences.getItem(key) === "expanded");
  return (
    <section className="repository-navigation" data-expanded={expanded}>
      <h2 className="section-label secondary-label">
        <button
          type="button"
          className="repository-navigation-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded(!expanded);
            preferences.setItem(key, expanded ? "collapsed" : "expanded");
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{t("repository")}</span>
        </button>
      </h2>
      <nav id={id} aria-label={t("repository")} className="repository-navigation-items">
        {children}
      </nav>
    </section>
  );
}
