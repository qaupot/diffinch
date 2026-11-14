import { isTauri } from "@tauri-apps/api/core";
import { getStore, type Store } from "@tauri-apps/plugin-store";

const native = isTauri();
const migrationKey = "diffinch.storageVersion";
const keys = new Set([
  "diffinch.theme",
  "diffinch.language",
  "diffinch.layout",
  "diffinch.editor",
  "diffinch.sidebarWidth",
  "diffinch.changesWidth",
  "diffinch.fileSplit",
  "diffinch.historyWidth",
  "diffinch.historyHeight",
  "diffinch.session",
  "diffinch.current",
  "diffinch.recent",
]);
const prefixes = ["diffinch.branches:", "diffinch.branchFolders:", "diffinch.repositoryMenu:"];
const cache = new Map<string, string>();
const pending = new Map<string, string | null>();
const listeners = new Set<() => void>();
let store: Store | undefined;
let initialization: Promise<void> | undefined;
let writing: Promise<void> | undefined;
type StorageError = "preferencesLoadFailed" | "preferencesSaveFailed";
let error: StorageError | null = null;

function report(next: StorageError | null) {
  error = next;
  for (const listener of listeners) listener();
}

function legacyEntries(): [string, string][] {
  const entries: [string, string][] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && (keys.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
      const value = localStorage.getItem(key);
      if (value !== null) entries.push([key, value]);
    }
  }
  return entries;
}

async function persist() {
  if (!store) return;
  try {
    while (pending.size) {
      const batch = new Map(pending);
      for (const [key, value] of batch) {
        if (value === null) await store.delete(key);
        else await store.set(key, value);
      }
      await store.save();
      for (const [key, value] of batch) {
        if (pending.get(key) === value) pending.delete(key);
      }
    }
    if (error === "preferencesSaveFailed") report(null);
  } catch {
    // Retain the entire batch so a later change or flush retries failed writes.
    report("preferencesSaveFailed");
  }
}

function flush() {
  writing ??= Promise.resolve()
    .then(persist)
    .finally(() => {
      writing = undefined;
      if (store && pending.size && error !== "preferencesSaveFailed") void flush();
    });
  return writing;
}

async function initialize() {
  if (!native) return;
  try {
    // Rust opens only this file, rejecting unreadable or malformed files first.
    const loaded = await getStore("settings.json");
    if (!loaded) throw new Error("Preferences are unavailable");
    const entries = new Map(await loaded.entries<unknown>());
    for (const [key, value] of entries) {
      if (typeof value === "string") cache.set(key, value);
    }
    const version = entries.get(migrationKey);
    if (version !== "2") {
      for (const [key, value] of legacyEntries()) {
        // Version 1 omitted the external editor. Recover only that setting on
        // upgrade so other preferences deleted since migration stay deleted.
        if (!entries.has(key) && (version !== "1" || key === "diffinch.editor")) {
          cache.set(key, value);
          pending.set(key, value);
        }
      }
      pending.set(migrationKey, "2");
    }
    store = loaded;
  } catch {
    // Keep the app usable without overwriting settings that could not be read.
    report("preferencesLoadFailed");
    return;
  }
  // Keep legacy storage intact as a recovery copy. The marker prevents reimport.
  await flush();
}

function update(key: string, value: string | null) {
  if (native) {
    if ((cache.get(key) ?? null) === value && !pending.size) return;
    if (value === null) cache.delete(key);
    else cache.set(key, value);
    pending.set(key, value);
    if (store) void flush();
    return;
  }
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    report("preferencesSaveFailed");
  }
}

/** Synchronous reads after startup; desktop writes are serialized and saved to disk. */
export const preferences = {
  initialize: () => (initialization ??= initialize()),
  flush,
  getItem(key: string): string | null {
    if (native) return cache.get(key) ?? null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => update(key, value),
  removeItem: (key: string) => update(key, null),
  getError: () => error,
  dismissError: () => report(null),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
