import ContextMenuRow from "./ContextMenuRow";
import { useTranslation } from "./i18n";
import { Archive, ChevronDown, ChevronRight, Plus, Tag } from "./icons";
import type { Snapshot, Stash } from "./lib/git";
import { useSidebarExpansion } from "./useSidebarExpansion";

export default function ReferenceSidebar({
  repo,
  busy,
  onCreate,
  onSelect,
  onDeleteTag,
  onDropStash,
}: {
  repo: Snapshot;
  busy: boolean;
  onCreate: (kind: "tag" | "stash") => void;
  onSelect: (target: { id: string; label: string }) => void;
  onDeleteTag: (name: string) => void;
  onDropStash: (stash: Stash) => void;
}) {
  const { t } = useTranslation();
  const { isExpanded, toggle } = useSidebarExpansion(
    `diffinch.referenceSections:${repo.path || "example"}`,
  );
  return (
    <>
      {(["tags", "stashes"] as const).map((kind) => {
        const tags = kind === "tags";
        const expanded = isExpanded(kind);
        const count = repo[kind].length;
        const Icon = tags ? Tag : Archive;
        const createLabel = t(tags ? "newTag" : "stashChanges");
        const canCreate =
          !!repo.status.head &&
          (tags ||
            (!repo.operation &&
              repo.status.files.length > 0 &&
              !repo.status.files.some((file) => file.conflict)));
        const items = !expanded
          ? []
          : tags
            ? repo.tags.map(({ name, tip }) => ({
                id: name,
                tip,
                title: name,
                deleteLabel: t("deleteNamedTag", { name }),
                onDelete: () => onDeleteTag(name),
              }))
            : repo.stashes.map((stash) => ({
                id: stash.id,
                tip: stash.tip,
                title: `${stash.id}: ${stash.subject}`,
                deleteLabel: t("dropNamedStash", { name: stash.id }),
                onDelete: () => onDropStash(stash),
              }));
        return (
          <section className="reference-sidebar" key={kind} aria-label={t(kind)}>
            <div className="section-line">
              <button
                className="branch-tree-select reference-heading"
                aria-expanded={expanded}
                onClick={() => toggle(kind)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Icon size={14} />
                <span>{t(kind)}</span> <span className="branch-folder-count">{count}</span>
              </button>
              <button
                className="icon-button"
                title={createLabel}
                aria-label={createLabel}
                disabled={busy || !canCreate}
                onClick={() => onCreate(tags ? "tag" : "stash")}
              >
                <Plus size={15} />
              </button>
            </div>
            {expanded && (
              <div>
                {items.map((item) => (
                  <ContextMenuRow
                    className="branch-tree-row"
                    key={`${item.id}:${item.tip}`}
                    disabled={busy}
                    actionLabel={item.deleteLabel}
                    onAction={item.onDelete}
                  >
                    <button
                      className="branch-tree-select"
                      title={item.title}
                      aria-label={t("showInGraph", { name: item.id })}
                      disabled={busy}
                      onClick={() => onSelect({ id: item.tip, label: item.id })}
                    >
                      <Icon size={14} />
                      <span className="truncate">{item.title}</span>
                    </button>
                  </ContextMenuRow>
                ))}
                {!items.length && (
                  <p className="branch-sidebar-empty">{t(tags ? "noTags" : "noStashes")}</p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
