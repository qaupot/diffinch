import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { deferred } from "../test/fixtures";
import { git, type CommitSearch } from "./git";

vi.hoisted(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (percent: number) => void) {}
  },
}));

it.each(["before", "after"])(
  "cancels the correct search when superseded %s native registration",
  async (when) => {
    const pending = deferred<CommitSearch>();
    vi.mocked(invoke)
      .mockReset()
      .mockImplementation(async (command) =>
        command === "search_commits" ? pending.promise : undefined,
      );
    const controller = new AbortController();
    const search = git.searchCommits("/repo", "absent", "all", false, controller.signal);
    const [, args] = vi.mocked(invoke).mock.calls[0];
    const { request, progress } = args as {
      request: { id: string };
      progress: { onmessage: (percent: number) => void };
    };
    if (when === "after") progress.onmessage(0);
    controller.abort();
    if (when === "before") expect(invoke).toHaveBeenCalledTimes(1);
    progress.onmessage(0);
    progress.onmessage(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("cancel_transfer", { id: request.id });
    pending.reject({ key: "operationInterrupted" });
    await expect(search).rejects.toMatchObject({ key: "operationInterrupted" });
  },
);
