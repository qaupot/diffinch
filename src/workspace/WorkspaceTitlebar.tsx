import { useTranslation } from "../i18n";
import { languages, type Locale } from "../i18n/messages";
import { BookOpen, ChevronDown, Languages, Palette, Settings2 } from "../icons";
import { mac, native, shortcut } from "../lib/git";
import { readTheme } from "./preferences";
import type { Theme, View } from "./types";

export default function WorkspaceTitlebar({
  repositoryName,
  view,
  theme,
  setTheme,
  locale,
  setLocale,
  onManual,
  onAbout,
  onSettings,
}: {
  repositoryName: string | null;
  view: View;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onManual: () => void;
  onAbout: () => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="brand">
        {!(native && mac) && (
          <div className="traffic" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        )}
        <img src="/finch.png" alt="" />
        <span>Diffinch</span>
      </div>
      <div className="title-center">
        {repositoryName !== null && (
          <>
            <span className="truncate" title={repositoryName}>
              {repositoryName}
            </span>
            <span className="title-divider">/</span>
            <span>{t(view)}</span>
          </>
        )}
      </div>
      <div className="title-actions">
        <label className="title-picker language-picker" title={t("language")}>
          <Languages size={15} aria-hidden="true" />
          <select
            aria-label={t("language")}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {Object.entries(languages).map(([code, name]) => (
              <option key={code} lang={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
        <label className="title-picker" title={t("theme")}>
          <Palette size={15} aria-hidden="true" />
          <select
            aria-label={t("theme")}
            value={theme}
            onChange={(event) => setTheme(readTheme(event.target.value))}
          >
            <option value="blue">{t("blue")}</option>
            <option value="white">{t("white")}</option>
            <option value="dark">{t("dark")}</option>
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
        <button
          type="button"
          className="plain-button manual-button"
          aria-haspopup="dialog"
          title={t("manual")}
          onClick={(event) => {
            event.currentTarget.focus();
            onManual();
          }}
        >
          <BookOpen size={15} aria-hidden="true" />
          <span>{t("manual")}</span>
        </button>
        <button
          type="button"
          className="plain-button"
          aria-haspopup="dialog"
          onClick={(event) => {
            event.currentTarget.focus();
            onAbout();
          }}
        >
          {t("about")}
        </button>
        {repositoryName !== null && (
          <button
            className="icon-button"
            title={t("settingsShortcut", { shortcut: `${shortcut},` })}
            onClick={onSettings}
          >
            <Settings2 size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
