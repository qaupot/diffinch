import { useTranslation } from "./i18n";
import { ChevronDown, FileCode2, Search } from "./icons";
import { shortcut } from "./lib/git";
import PopupMenu from "./PopupMenu";

export default function FindMenu({
  open,
  onOpen,
  onFind,
  onFiles,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  onFind: () => void;
  onFiles: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PopupMenu
      open={open}
      onOpenChange={onOpen}
      label={t("find")}
      panelClassName="find-menu"
      trigger={
        <>
          <Search size={15} />
          <span>{t("find")}</span>
          <ChevronDown size={12} />
        </>
      }
    >
      <button type="button" onClick={onFind}>
        <Search size={14} />
        {t("findCommits")}
        <kbd className="menu-shortcut">{shortcut}⇧F</kbd>
      </button>
      <button type="button" onClick={onFiles}>
        <FileCode2 size={14} />
        {t("findChangedFiles")}
      </button>
    </PopupMenu>
  );
}
