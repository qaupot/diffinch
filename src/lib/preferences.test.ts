import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  native: true,
  available: true,
  disk: new Map<string, unknown>(),
  values: new Map<string, unknown>(),
  entries: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => backend.native }));
vi.mock("@tauri-apps/plugin-store", () => ({
  getStore: async () => (backend.available ? backend : null),
}));

beforeEach(() => {
  vi.resetModules();
  backend.native = true;
  backend.available = true;
  backend.disk = new Map();
  backend.values = new Map();
  backend.entries.mockReset().mockImplementation(async () => [...backend.values]);
  backend.set.mockReset().mockImplementation(async (key: string, value: unknown) => {
    backend.values.set(key, value);
  });
  backend.delete.mockReset().mockImplementation(async (key: string) => backend.values.delete(key));
  backend.save.mockReset().mockImplementation(async () => {
    backend.disk = new Map(backend.values);
  });
});

async function launch() {
  const { preferences } = await import("./preferences");
  await preferences.initialize();
  return preferences;
}

async function relaunch() {
  vi.resetModules();
  backend.values = new Map(backend.disk);
  return launch();
}

describe("desktop preferences", () => {
  it("migrates all previous settings, preserving session order and repository-specific values", async () => {
    const legacy = {
      "diffinch.theme": "dark",
      "diffinch.language": "ko",
      "diffinch.layout": "split",
      "diffinch.editor": JSON.stringify({ program: "zed", args: ["--wait"] }),
      "diffinch.sidebarWidth": "230",
      "diffinch.changesWidth": "320",
      "diffinch.fileSplit": "0.6",
      "diffinch.historyWidth": "480",
      "diffinch.historyHeight": "260",
      "diffinch.session": JSON.stringify({ paths: ["/b", "/a"], activePath: "/a" }),
      "diffinch.current": "/old",
      "diffinch.recent": JSON.stringify(["/a", "/b"]),
      "diffinch.branches:/a": '["refs/heads/hidden"]',
      "diffinch.branchFolders:/a": '["local:feature"]',
      "diffinch.repositoryMenu:/a": "expanded",
    };
    for (const [key, value] of Object.entries(legacy)) localStorage.setItem(key, value);
    localStorage.setItem("unrelated", "keep");
    localStorage.setItem("diffinch.unknown", "do not import");
    const preferences = await launch();
    for (const [key, value] of Object.entries(legacy)) {
      expect(preferences.getItem(key)).toBe(value);
      expect(backend.disk.get(key)).toBe(value);
      expect(localStorage.getItem(key)).toBe(value);
    }
    expect(backend.disk.has("unrelated")).toBe(false);
    expect(backend.disk.has("diffinch.unknown")).toBe(false);
    expect(backend.disk.get("diffinch.storageVersion")).toBe("2");
    const reopened = await relaunch();
    expect(reopened.getItem("diffinch.session")).toBe(legacy["diffinch.session"]);
  });

  it("keeps newer stored values and never reimports deleted preferences", async () => {
    localStorage.setItem("diffinch.theme", "light");
    localStorage.setItem("diffinch.sidebarWidth", "200");
    backend.values.set("diffinch.theme", "dark");
    const preferences = await launch();
    expect(preferences.getItem("diffinch.theme")).toBe("dark");
    preferences.removeItem("diffinch.sidebarWidth");
    preferences.setItem("diffinch.language", "ja");
    await preferences.flush();
    const reopened = await relaunch();
    expect(reopened.getItem("diffinch.sidebarWidth")).toBeNull();
    expect(reopened.getItem("diffinch.language")).toBe("ja");
    expect(localStorage.getItem("diffinch.language")).toBeNull();
  });

  it.each([null, JSON.stringify({ program: "cursor", args: [] })])(
    "recovers a missed legacy editor without replacing a newer choice (%s)",
    async (savedEditor) => {
      const legacyEditor = JSON.stringify({ program: "zed", args: ["--wait"] });
      localStorage.setItem("diffinch.editor", legacyEditor);
      localStorage.setItem("diffinch.theme", "light");
      backend.values.set("diffinch.storageVersion", "1");
      if (savedEditor !== null) backend.values.set("diffinch.editor", savedEditor);

      const preferences = await launch();
      expect(preferences.getItem("diffinch.editor")).toBe(savedEditor ?? legacyEditor);
      expect(preferences.getItem("diffinch.theme")).toBeNull();
      expect(backend.disk.get("diffinch.storageVersion")).toBe("2");

      preferences.removeItem("diffinch.editor");
      await preferences.flush();
      const reopened = await relaunch();
      expect(reopened.getItem("diffinch.editor")).toBeNull();
      expect(localStorage.getItem("diffinch.editor")).toBe(legacyEditor);
    },
  );

  it("waits for initial reads and initializes only once", async () => {
    let resolve!: (value: [string, unknown][]) => void;
    backend.entries.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { preferences } = await import("./preferences");
    const first = preferences.initialize();
    expect(preferences.initialize()).toBe(first);
    await vi.waitFor(() => expect(backend.entries).toHaveBeenCalledOnce());
    resolve([
      ["diffinch.theme", "dark"],
      ["diffinch.storageVersion", "2"],
    ]);
    await first;
    expect(preferences.getItem("diffinch.theme")).toBe("dark");
    expect(backend.set).not.toHaveBeenCalled();
  });

  it("saves the latest values when preferences change during an in-flight save", async () => {
    const preferences = await launch();
    let finish!: () => void;
    backend.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    preferences.setItem("diffinch.theme", "dark");
    await vi.waitFor(() => expect(finish).toBeDefined());
    preferences.setItem("diffinch.theme", "light");
    preferences.setItem("diffinch.sidebarWidth", "250");
    preferences.removeItem("diffinch.sidebarWidth");
    expect(preferences.getItem("diffinch.theme")).toBe("light");
    finish();
    await preferences.flush();
    const reopened = await relaunch();
    expect(reopened.getItem("diffinch.theme")).toBe("light");
    expect(reopened.getItem("diffinch.sidebarWidth")).toBeNull();
  });

  it("retains a failed migration for retry and leaves the legacy copy untouched", async () => {
    localStorage.setItem("diffinch.language", "ko");
    backend.save.mockRejectedValueOnce(new Error("disk full"));
    const preferences = await launch();
    expect(preferences.getItem("diffinch.language")).toBe("ko");
    expect(preferences.getError()).toBe("preferencesSaveFailed");
    expect(backend.disk.has("diffinch.storageVersion")).toBe(false);
    expect(localStorage.getItem("diffinch.language")).toBe("ko");
    preferences.setItem("diffinch.theme", "dark");
    await preferences.flush();
    expect(preferences.getError()).toBeNull();
    const reopened = await relaunch();
    expect(reopened.getItem("diffinch.language")).toBe("ko");
    expect(reopened.getItem("diffinch.theme")).toBe("dark");
  });

  it("retries the complete batch after a command fails partway through", async () => {
    const preferences = await launch();
    backend.set.mockRejectedValueOnce(new Error("IPC failed"));
    preferences.setItem("diffinch.theme", "dark");
    preferences.setItem("diffinch.language", "ko");
    await preferences.flush();
    expect(preferences.getError()).toBe("preferencesSaveFailed");
    await preferences.flush();
    expect(backend.disk.get("diffinch.theme")).toBe("dark");
    expect(backend.disk.get("diffinch.language")).toBe("ko");
    expect(preferences.getError()).toBeNull();
  });

  it("keeps changes in memory when Rust cannot open the settings file", async () => {
    backend.available = false;
    const preferences = await launch();
    expect(preferences.getError()).toBe("preferencesLoadFailed");
    preferences.setItem("diffinch.theme", "dark");
    await preferences.flush();
    expect(preferences.getItem("diffinch.theme")).toBe("dark");
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.save).not.toHaveBeenCalled();
  });

  it("ignores unexpected value types and preserves unknown native entries", async () => {
    backend.values.set("diffinch.storageVersion", "2");
    backend.values.set("diffinch.session", { invalid: true });
    backend.values.set("future", { preserve: true });
    const preferences = await launch();
    expect(preferences.getItem("diffinch.session")).toBeNull();
    preferences.setItem("diffinch.theme", "dark");
    await preferences.flush();
    expect(backend.disk.get("future")).toEqual({ preserve: true });
  });
});

describe("browser demo preferences", () => {
  it("uses browser storage without opening a desktop store", async () => {
    backend.native = false;
    localStorage.setItem("diffinch.theme", "dark");
    const preferences = await launch();
    expect(preferences.getItem("diffinch.theme")).toBe("dark");
    preferences.setItem("diffinch.theme", "light");
    expect(localStorage.getItem("diffinch.theme")).toBe("light");
    preferences.removeItem("diffinch.theme");
    expect(localStorage.getItem("diffinch.theme")).toBeNull();
    expect(backend.entries).not.toHaveBeenCalled();
  });

  it("keeps the demo usable when browser storage is unavailable", async () => {
    backend.native = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const preferences = await launch();
    expect(preferences.getItem("diffinch.theme")).toBeNull();
    expect(() => preferences.setItem("diffinch.theme", "dark")).not.toThrow();
    expect(preferences.getError()).toBe("preferencesSaveFailed");
  });
});
