import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import Notice from "./Notice";
import type { PaneAxis } from "./PaneDivider";
import About from "./dialogs/About";
import { LocaleContext, localeKey, readLocale } from "./i18n";
import type { Locale } from "./i18n/messages";
import { native } from "./lib/git";
import { preferences } from "./lib/preferences";
import RepositoryTabs from "./workspace/RepositoryTabs";
import RepositoryWorkspace from "./workspace/RepositoryWorkspace";
import { readTheme } from "./workspace/preferences";
import type { RepositoryTab } from "./workspace/types";
import { useRepositorySession } from "./workspace/useRepositorySession";

const themeKey = "diffinch.theme";
const sidebarWidthKey = "diffinch.sidebarWidth";
const changesWidthKey = "diffinch.changesWidth";
const fileSplitKey = "diffinch.fileSplit";
const historyWidthKey = "diffinch.historyWidth";
const historyHeightKey = "diffinch.historyHeight";

function usePaneSize(key: string, maximum = Infinity) {
  const [size, setSize] = useState(() => {
    const stored = Number(preferences.getItem(key));
    return Number.isFinite(stored) && stored > 0 && stored < maximum ? stored : null;
  });
  function saveSize(value: number | null) {
    setSize(value);
    if (value === null) preferences.removeItem(key);
    else preferences.setItem(key, String(value));
  }
  return [size, saveSize] as const;
}

export default function App() {
  const [locale, setLocale] = useState(readLocale);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function changeLocale(next: Locale) {
    preferences.setItem(localeKey, next);
    setLocale(next);
  }

  return (
    <LocaleContext.Provider value={locale}>
      <AppShell locale={locale} setLocale={changeLocale} />
    </LocaleContext.Provider>
  );
}

function AppShell({ locale, setLocale }: { locale: Locale; setLocale: (locale: Locale) => void }) {
  const storageError = useSyncExternalStore(preferences.subscribe, preferences.getError);
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const listener = listen("show-about", () => {
      if (!disposed) setAboutOpen(true);
    });
    void listener.catch((error: unknown) =>
      console.warn("Could not listen for the About menu.", error),
    );
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  const [split, setSplit] = useState(() => preferences.getItem("diffinch.layout") === "split");
  const [changesWidth, saveChangesWidth] = usePaneSize(changesWidthKey);
  const [fileSplit, saveFileSplit] = usePaneSize(fileSplitKey, 1);
  const [sidebarWidth, saveSidebarWidth] = usePaneSize(sidebarWidthKey);
  const [historyWidth, saveHistoryWidth] = usePaneSize(historyWidthKey);
  const [historyHeight, saveHistoryHeight] = usePaneSize(historyHeightKey);
  const [theme, setTheme] = useState(() => readTheme(preferences.getItem(themeKey)));
  const {
    tabs,
    activePath,
    setSession,
    restoreError,
    dismissRestoreError,
    recents,
    acceptRepo,
    closeTab,
    reorderTab,
    forgetWorktree,
  } = useRepositorySession();

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    preferences.setItem(themeKey, theme);
    if (native) {
      void Promise.resolve()
        .then(() => getCurrentWindow().setTheme(theme === "dark" ? "dark" : "light"))
        .catch((error: unknown) => console.warn("Could not update the window appearance.", error));
    }
  }, [theme]);

  function setLayout(value: boolean) {
    setSplit(value);
    preferences.setItem("diffinch.layout", value ? "split" : "unified");
  }

  function saveHistorySize(size: number | null, axis: PaneAxis) {
    if (axis === "height") saveHistoryHeight(size);
    else saveHistoryWidth(size);
  }

  const repositoryTabs = (
    <RepositoryTabs
      tabs={tabs}
      activePath={activePath}
      onSelect={(path) => setSession((current) => ({ ...current, activePath: path }))}
      onClose={closeTab}
      onReorder={reorderTab}
    />
  );

  return (
    <div
      className="app-shell"
      style={
        {
          "--sidebar-saved-width": sidebarWidth === null ? undefined : `${sidebarWidth}px`,
          "--changes-width": changesWidth === null ? undefined : `${changesWidth}px`,
          "--file-split": fileSplit ?? undefined,
          "--history-width": historyWidth === null ? undefined : `${historyWidth}px`,
          "--history-height": historyHeight === null ? undefined : `${historyHeight}px`,
        } as CSSProperties
      }
    >
      {(tabs.length ? tabs : [emptyTab]).map((tab) => (
        <RepositoryWorkspace
          key={tab.snapshot.path}
          tab={tab}
          active={tab.snapshot.path === (activePath ?? "")}
          restoring={activePath === null}
          acceptRepo={acceptRepo}
          forgetWorktree={forgetWorktree}
          repositoryTabs={repositoryTabs}
          recents={recents}
          split={split}
          setLayout={setLayout}
          saveChangesWidth={saveChangesWidth}
          saveSidebarWidth={saveSidebarWidth}
          saveFileSplit={saveFileSplit}
          saveHistorySize={saveHistorySize}
          theme={theme}
          setTheme={setTheme}
          locale={locale}
          setLocale={setLocale}
          onAbout={() => setAboutOpen(true)}
        />
      ))}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      {storageError ? (
        <Notice message={{ key: storageError }} error onDismiss={preferences.dismissError} />
      ) : (
        restoreError && <Notice message={restoreError} error onDismiss={dismissRestoreError} />
      )}
    </div>
  );
}

const emptyTab: RepositoryTab = {
  snapshot: {
    path: "",
    name: "",
    status: { branch: null, upstream: null, head: null, ahead: 0, behind: 0, files: [] },
    branches: [],
    worktrees: [],
    commits: [],
    historyCursor: null,
    hasOlderCommits: false,
    stashes: [],
    tags: [],
    remotes: [],
    operation: null,
    pushLease: null,
    settings: { name: "", email: "", signCommits: false, signingFormat: "", signingKey: "" },
  },
};
