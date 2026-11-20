import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { git, type Action, type RemoteRefs, type Snapshot } from "../lib/git";
import { deferred, fileChange, snapshot } from "../test/fixtures";
import RepositoryWorkspace from "./RepositoryWorkspace";
import { useRepositoryWatch } from "./useRepositoryWatch";

vi.mock("./useRepositoryWatch", () => ({ useRepositoryWatch: vi.fn() }));
vi.hoisted(() => {
  vi.stubGlobal("CSS", { supports: () => false });
});

beforeAll(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

beforeEach(() => {
  vi.spyOn(git, "jsonDiff").mockResolvedValue({ text: "", truncated: false, hunkToken: null });
  vi.spyOn(git, "commitMessage").mockResolvedValue("Saved work\n");
});

function repository() {
  const repo = snapshot();
  const tip = repo.status.head!;
  repo.commits = [
    {
      id: tip,
      shortId: tip.slice(0, 7),
      parents: [],
      subject: "Saved work",
      author: "Test",
      email: "test@example.invalid",
      date: "2026-11-15T12:00:00Z",
    },
  ];
  repo.branches = [
    { name: "main", tip, current: true, remote: false, upstream: "" },
    { name: "feature/sidebar", tip, current: false, remote: false, upstream: "" },
    { name: "origin/main", tip, current: false, remote: true, upstream: "" },
  ];
  repo.tags = [{ name: "v1.0", tip }];
  repo.remotes = [{ name: "origin", url: "https://example.invalid/repo.git" }];
  repo.stashes = [{ id: "stash@{0}", tip, subject: "On main: saved draft" }];
  repo.status.files = [fileChange("notes")];
  return repo;
}

async function setup(repo: Snapshot = repository(), restoring = false) {
  const action = vi.spyOn(git, "action").mockResolvedValue("tagCreated");
  vi.spyOn(git, "snapshot").mockResolvedValue(repo);
  await act(async () =>
    render(
      <RepositoryWorkspace
        tab={{ snapshot: repo }}
        active
        restoring={restoring}
        acceptRepo={vi.fn()}
        forgetWorktree={vi.fn()}
        repositoryTabs={null}
        recents={[]}
        split={false}
        setLayout={vi.fn()}
        saveChangesWidth={vi.fn()}
        saveSidebarWidth={vi.fn()}
        saveFileSplit={vi.fn()}
        saveHistorySize={vi.fn()}
        theme="blue"
        setTheme={vi.fn()}
        locale="en"
        setLocale={vi.fn()}
        onAbout={vi.fn()}
      />,
    ),
  );
  return { repo, action };
}

function branchGroup(scope: "Local" | "Remote", expanded: boolean) {
  return within(screen.getByRole("region", { name: `${scope} branches` })).getByRole("button", {
    name: new RegExp(`^${scope}`),
    expanded,
  });
}

function expand(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name, expanded: false }));
}

it("reserves the Add repository button's width when space for tabs runs out", async () => {
  render(<style>{readFileSync("src/styles.css", "utf8")}</style>);
  await setup();
  const add = screen.getByRole("button", { name: "Add repository" });
  const anchor = getComputedStyle(add.parentElement!);
  expect(anchor.flexBasis).toBe("auto");
  expect(anchor.flexShrink).toBe("0");
  fireEvent.click(add);
  expect(screen.getByRole("menuitem", { name: /Open Repository/ })).toBeTruthy();
});

it("opens the branch sections and folds each slash-delimited path independently", async () => {
  const repo = repository();
  repo.branches.push({ ...repo.branches[1], name: "feature/ui/buttons" });
  repo.branches.push({ ...repo.branches[2], name: "origin/feature/sidebar" });
  await setup(repo);
  expect(branchGroup("Local", true)).toBeTruthy();
  expect(branchGroup("Remote", true)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show main in the commit graph" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Show feature/sidebar in the commit graph" }),
  ).toBeNull();
  expand("Branch folder feature");
  expand("Branch folder feature/ui");
  expect(
    screen.getByRole("button", { name: "Show feature/ui/buttons in the commit graph" }),
  ).toBeTruthy();
  expand("Remote origin");
  expect(
    screen.getByRole("button", { name: "Branch folder origin/feature", expanded: false }),
  ).toBeTruthy();
  cleanup();
  repo.branches.push({ ...repo.branches[1], name: "feature/new/work" });
  await setup(repo);
  expect(
    screen.getByRole("button", { name: "Show feature/ui/buttons in the commit graph" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Branch folder feature/new", expanded: false }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remote origin", expanded: true })).toBeTruthy();
  cleanup();
  await setup({ ...repo, path: "/other" });
  expect(
    screen.getByRole("button", { name: "Branch folder feature", expanded: false }),
  ).toBeTruthy();
});

it("keeps previously saved collapsed sections when reading the older branch preference", async () => {
  const repo = repository();
  localStorage.setItem(
    `diffinch.branchFolders:${repo.path}`,
    JSON.stringify(["remote", "local/feature"]),
  );
  await setup(repo);
  expect(branchGroup("Local", true)).toBeTruthy();
  expect(branchGroup("Remote", false)).toBeTruthy();
  expand("Branch folder feature");
  cleanup();
  await setup(repo);
  expect(branchGroup("Remote", false)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Branch folder feature", expanded: true }),
  ).toBeTruthy();
});

it("starts Tags and Stashes folded and remembers their separate choices per repository", async () => {
  const { repo } = await setup();
  expect(screen.getByRole("button", { name: "Tags 1", expanded: false })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stashes 1", expanded: false })).toBeTruthy();
  expand("Tags 1");
  expect(screen.getByRole("button", { name: "Show v1.0 in the commit graph" })).toBeTruthy();
  cleanup();
  await setup(repo);
  expect(screen.getByRole("button", { name: "Tags 1", expanded: true })).toBeTruthy();
  expand("Stashes 1");
  fireEvent.click(screen.getByRole("button", { name: "Tags 1", expanded: true }));
  cleanup();
  await setup(repo);
  expect(screen.getByRole("button", { name: "Tags 1", expanded: false })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stashes 1", expanded: true })).toBeTruthy();
  cleanup();
  await setup({ ...repo, path: "/other" });
  expect(screen.getByRole("button", { name: "Stashes 1", expanded: false })).toBeTruthy();
});

it("confirms discard for the right-clicked file while another file is selected", async () => {
  const repo = repository();
  const target = fileChange("src/target", "M", "M");
  repo.status.files.push(target);
  const { action } = await setup(repo);
  const plan = { id: target.id, token: "reviewed-state" };
  const prepare = vi.spyOn(git, "discardPlan").mockResolvedValue(plan);
  const unstaged = within(screen.getByRole("region", { name: "Unstaged files" }));
  const selected = unstaged.getByTitle("notes.txt");
  const row = unstaged.getByTitle(target.path);
  const menuLabel = "Discard changes to src/target.txt…";

  fireEvent.contextMenu(row, { clientX: 180, clientY: 300 });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: menuLabel }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(prepare).toHaveBeenCalledWith(repo.path, target.id);
  expect(dialog.getByText(/working copy of src\/target\.txt/)).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(action).not.toHaveBeenCalled();

  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const item = screen.getByRole("menuitem", { name: menuLabel });
  expect(document.activeElement).toBe(item);
  fireEvent.keyDown(item, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: "ContextMenu" });
  fireEvent.click(screen.getByRole("menuitem", { name: menuLabel }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard changes" }),
  );
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      repo.path,
      { kind: "discard", ...plan },
      expect.any(String),
      expect.any(Function),
    ),
  );
});

it("offers no discard menu on staged, untracked, conflicted, or submodule rows", async () => {
  const repo = repository();
  repo.status.files = [
    fileChange("partial", "M", "M"),
    fileChange("new", ".", "?"),
    { ...fileChange("conflict", "U", "U"), conflict: true },
    { ...fileChange("module"), submodule: true },
  ];
  await setup(repo);
  const staged = within(screen.getByRole("region", { name: "Staged files" }));
  const unstaged = within(screen.getByRole("region", { name: "Unstaged files" }));
  for (const row of [
    staged.getByTitle("partial.txt"),
    unstaged.getByTitle("new.txt"),
    unstaged.getByTitle("conflict.txt"),
    unstaged.getByTitle("module.txt"),
  ]) {
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menu")).toBeNull();
  }
});

it("blocks the file discard menu while the repository is busy", async () => {
  await setup(repository(), true);
  const unstaged = within(screen.getByRole("region", { name: "Unstaged files" }));
  fireEvent.contextMenu(unstaged.getByTitle("notes.txt"));
  expect(screen.queryByRole("menu")).toBeNull();
});

it.each(["loaded message", "existing draft"])(
  "does not retarget an amend %s when HEAD refreshes before confirmation",
  async (mode) => {
    const message = vi
      .spyOn(git, "commitMessage")
      .mockResolvedValue(" \t\r\nOriginal\r\nA\r\n\r\n    Original body\r\n");
    const { repo, action } = await setup();
    if (mode === "existing draft") {
      fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
        target: { value: "Original A" },
      });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Amend last commit" }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Commit summary" }).value).toBe(
        "Original A",
      ),
    );
    if (mode === "loaded message")
      expect(message).toHaveBeenCalledWith(repo.path, repo.status.head);
    else expect(message).not.toHaveBeenCalled();
    const later = { ...repo, status: { ...repo.status, head: "b".repeat(40) } };
    vi.mocked(git.snapshot).mockResolvedValue(later);
    await act(async () => {
      expect(vi.mocked(useRepositoryWatch).mock.lastCall![2]("full")).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: /^Amend commit/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("amendment target changed");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Commit summary" }).value).toBe(
      "Original A",
    );

    // Explicitly selecting the new target preserves the user's draft.
    fireEvent.click(screen.getByRole("checkbox", { name: "Amend last commit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Amend last commit" }));
    fireEvent.click(screen.getByRole("button", { name: /^Amend commit/ }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Amend commit" }),
    );
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        expect.objectContaining({
          kind: "commit",
          summary: "Original A",
          description: mode === "loaded message" ? "    Original body" : "",
          amend: { branch: "main", head: later.status.head },
        }),
        expect.any(String),
        expect.any(Function),
      ),
    );
  },
);

it.each([
  ["Merge into current branch…", "Merge branch", "merge"],
  ["Rebase current branch…", "Rebase branch", "rebase"],
  ["Cherry-pick…", "Cherry-pick", "cherryPick"],
  ["Revert…", "Revert commit", "revert"],
])("keeps the reviewed branch when confirming %s after a refresh", async (menu, label, kind) => {
  const initial = repository();
  // Selecting a commit on another branch offers merge and rebase actions.
  initial.commits.unshift({
    ...initial.commits[0],
    id: "b".repeat(40),
    shortId: "bbbbbbb",
    subject: "Source commit",
  });
  initial.branches[1].tip = "b".repeat(40);
  const { repo, action } = await setup(initial);
  action.mockRejectedValue({ key: "staleHistoryAction" });
  fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
  fireEvent.click(screen.getByRole("button", { name: /^Source commit,/ }));
  fireEvent.click(screen.getByRole("button", { name: "Commit actions" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Commit graph" })).getByRole("button", {
      name: menu,
    }),
  );
  vi.mocked(git.snapshot).mockResolvedValue({
    ...repo,
    status: { ...repo.status, branch: "other", head: "c".repeat(40) },
  });
  await act(async () => {
    expect(vi.mocked(useRepositoryWatch).mock.lastCall![2]("full")).toBe(true);
  });
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: label }));
  const source =
    kind === "merge" || kind === "rebase"
      ? { name: "feature/sidebar", remote: false, tip: "b".repeat(40) }
      : { id: "b".repeat(40) };
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      repo.path,
      { kind, ...source, target: { branch: "main", head: repo.status.head } },
      expect.any(String),
      expect.any(Function),
    ),
  );
  expect((await dialog.findByRole("alert")).textContent).toContain("branch or commit changed");
});

it("keeps the original checkout and source tip in the rebase branch picker", async () => {
  const { repo, action } = await setup();
  action.mockRejectedValue({ key: "staleHistoryAction" });
  fireEvent.click(screen.getByRole("button", { name: "Git actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rebase onto branch…" }));
  const dialog = within(screen.getByRole("dialog"));
  vi.mocked(git.snapshot).mockResolvedValue({
    ...repo,
    status: { ...repo.status, branch: "other", head: "b".repeat(40) },
    branches: repo.branches.map((branch) => ({ ...branch, tip: "b".repeat(40) })),
  });
  await act(async () => {
    expect(vi.mocked(useRepositoryWatch).mock.lastCall![2]("full")).toBe(true);
  });
  fireEvent.click(dialog.getByRole("button", { name: "Rebase branch" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      repo.path,
      {
        kind: "rebase",
        name: "feature/sidebar",
        remote: false,
        tip: repo.status.head,
        target: { branch: "main", head: repo.status.head },
      },
      expect.any(String),
      expect.any(Function),
    ),
  );
  expect((await dialog.findByRole("alert")).textContent).toContain("branch or commit changed");
});

it.each(["main", null])(
  "keeps the reviewed amend target after a refresh from branch %s and preserves rejected drafts",
  async (branch) => {
    const initial = repository();
    initial.status.branch = branch;
    const { repo, action } = await setup(initial);
    action.mockRejectedValue({ key: "staleAmend" });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
      target: { value: "Reviewed amendment" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit description" }), {
      target: { value: "Keep this body" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Amend last commit" }));
    fireEvent.click(screen.getByRole("button", { name: /^Amend commit/ }));
    expect(action).not.toHaveBeenCalled();

    const latest = {
      ...repo,
      status: { ...repo.status, branch: "other", head: "b".repeat(40) },
    };
    vi.mocked(git.snapshot).mockResolvedValue(latest);
    await act(async () => {
      expect(vi.mocked(useRepositoryWatch).mock.lastCall![2]("full")).toBe(true);
    });
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Amend commit" }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        {
          kind: "commit",
          summary: "Reviewed amendment",
          description: "Keep this body",
          sign: false,
          amend: { branch, head: repo.status.head },
        },
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect((await dialog.findByRole("alert")).textContent).toContain("branch or commit changed");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Commit summary" }).value).toBe(
      "Reviewed amendment",
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Commit description" }).value,
    ).toBe("Keep this body");
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Amend last commit" }).checked,
    ).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  },
);

it("keeps the reviewed force-push destination when the repository refreshes during confirmation", async () => {
  const initial = repository();
  initial.status.upstream = "origin/main";
  initial.pushLease = {
    branch: "main",
    head: initial.status.head!,
    remote: "origin",
    target: "refs/heads/main",
    expected: "b".repeat(40),
    destination: "reviewed-destination",
  };
  const { repo, action } = await setup(initial);
  action.mockRejectedValue({ key: "stalePushLease" });
  fireEvent.click(screen.getByRole("button", { name: "Git actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Force push with lease…" }));
  expect(action).not.toHaveBeenCalled();
  vi.mocked(git.snapshot).mockResolvedValue({
    ...repo,
    pushLease: { ...initial.pushLease, destination: "changed-destination" },
  });
  await act(async () => {
    expect(vi.mocked(useRepositoryWatch).mock.lastCall![2]("full")).toBe(true);
  });
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Force push with lease" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      repo.path,
      { kind: "forcePush", lease: initial.pushLease },
      expect.any(String),
      expect.any(Function),
    ),
  );
  expect((await dialog.findByRole("alert")).textContent).toContain("push destination changed");
  expect(action).toHaveBeenCalledTimes(1);
});

it.each(["Compare", "File history", "Git LFS"])(
  "opens %s on demand and preserves the commit draft when returning to Changes",
  async (view) => {
    const repo = repository();
    const inspection = vi.spyOn(git, "inspectFile").mockResolvedValue({
      kind: "catalog",
      data: { revision: repo.status.head!, files: ["notes.txt"] },
    });
    const tools = vi.spyOn(git, "repositoryTools").mockResolvedValue({
      kind: "lfs",
      available: true,
      version: "git-lfs/test",
      patterns: "",
      files: [],
    });
    await setup(repo);
    fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
      target: { value: "Keep my draft" },
    });
    expect(inspection).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    if (view === "Git LFS") fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: view }));
    // Only the selected panel suspends; navigation stays available while it loads.
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Changes/ }).disabled).toBe(
      false,
    );
    if (view === "Compare") {
      expect(await screen.findByRole("combobox", { name: "Base" })).toBeTruthy();
    } else if (view === "File history") {
      const panel = within(await screen.findByRole("region", { name: "File history" }));
      expect(await panel.findByRole("button", { name: "notes.txt" })).toBeTruthy();
      expect(inspection).toHaveBeenCalledWith(
        repo.path,
        { kind: "catalog", revision: repo.status.head },
        expect.any(String),
        expect.any(Function),
      );
    } else {
      expect(
        await screen.findByRole("button", { name: "Enable LFS in this repository" }),
      ).toBeTruthy();
      expect(tools).toHaveBeenCalledWith(repo.path, "lfs");
    }
    fireEvent.click(screen.getByRole("button", { name: /^Changes/ }));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Commit summary" }).value).toBe(
      "Keep my draft",
    );
  },
);

it.each([
  ["Branches", "New Branch", "Create branch", "createBranch"],
  ["Tags", "New Tag", "Create tag", "createTag"],
] as const)(
  "creates from the %s sidebar without leaving Changes",
  async (section, add, submit, kind) => {
    const { repo, action } = await setup();
    fireEvent.click(
      within(screen.getByRole("region", { name: section })).getByRole("button", { name: add }),
    );
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "new-reference" } });
    fireEvent.click(dialog.getByRole("button", { name: submit }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        {
          kind,
          name: "new-reference",
          start: undefined,
          ...(kind === "createBranch" ? { checkout: true } : {}),
        },
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(screen.getByRole("heading", { name: "Changes", level: 2 })).toBeTruthy();
  },
);

it("stashes with the chosen message and untracked option from the sidebar", async () => {
  const { repo, action } = await setup();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Stashes" })).getByRole("button", {
      name: "Stash changes",
    }),
  );
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Message"), { target: { value: "Work in progress" } });
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "Stash changes" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      repo.path,
      {
        kind: "stash",
        message: "Work in progress",
        includeUntracked: false,
      },
      expect.any(String),
      expect.any(Function),
    ),
  );
});

const deletions: [string, string, string, string, Action][] = [
  [
    "Branches",
    "feature/sidebar",
    "Delete feature/sidebar",
    "Delete branch",
    { kind: "deleteBranch", name: "feature/sidebar" },
  ],
  ["Tags", "v1.0", "Delete tag v1.0", "Delete tag", { kind: "deleteTag", name: "v1.0" }],
  [
    "Stashes",
    "stash@{0}",
    "Drop stash@{0}",
    "Drop stash",
    { kind: "dropStash", id: "stash@{0}", tip: "a".repeat(40) },
  ],
];

it.each(deletions)(
  "keeps %s deletion out of the inline sidebar and detail actions",
  async (section, _name, remove) => {
    await setup();
    expand(section === "Branches" ? "Branch folder feature" : `${section} 1`);
    const region = within(screen.getByRole("region", { name: section }));
    expect(region.queryByRole("button", { name: remove })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: section }));
    expect(screen.queryByRole("button", { name: remove })).toBeNull();
  },
);

it("keeps a tall graph context menu inside the window at the pointer's edge", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
  const row = screen.getByRole("button", { name: /^Saved work,/ });
  fireEvent.contextMenu(row, { clientX: 0, clientY: innerHeight - 1 });
  const panel = screen.getByRole("button", { name: "Copy commit title" }).parentElement!;
  const rect = vi.spyOn(panel, "getBoundingClientRect");
  rect.mockReturnValue(new DOMRect(0, 0, 214, 480));
  fireEvent(window, new Event("resize"));
  expect(panel.style.left).toBe("8px");
  expect(panel.style.top).toBe(`${innerHeight - 480 - 8}px`);
});

it("copies the graph commit's title and SHA separately and reports clipboard failures", async () => {
  const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue(undefined);
  vi.spyOn(window, "navigator", "get").mockReturnValue(
    Object.create(navigator, { clipboard: { value: { writeText } } }),
  );
  const { repo } = await setup();
  const commit = repo.commits[0];
  fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
  const row = screen.getByRole("button", { name: /^Saved work,/ });
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("button", { name: "Copy commit title" }));
  expect(writeText).toHaveBeenLastCalledWith(commit.subject);
  expect(await screen.findByText("Commit title copied")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Commit actions" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy commit SHA" }));
  expect(writeText).toHaveBeenLastCalledWith(commit.id);
  expect(await screen.findByText("Commit SHA copied")).toBeTruthy();

  writeText.mockRejectedValueOnce(new Error("Permission denied"));
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("button", { name: "Copy commit title" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn’t copy the commit title.\nSaved work",
  );
});

it("shows the selected commit body beneath the graph and ignores superseded reads", async () => {
  const repo = repository();
  const tip = repo.commits[0];
  const parentId = "b".repeat(40);
  tip.parents = [parentId];
  repo.commits.push({
    ...tip,
    id: parentId,
    shortId: parentId.slice(0, 7),
    subject: "Earlier work",
    parents: [],
  });
  const pending = deferred<string>();
  const read = vi
    .mocked(git.commitMessage)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce("Earlier\r\nwork\r\n\r\n  First paragraph\r\n\r\nLast paragraph\r\n");
  await setup(repo);
  fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
  const graph = within(screen.getByRole("region", { name: "Commit graph" }));
  const description = () => graph.getByRole("region", { name: "Commit description" });
  const tipRow = graph.getByRole("button", { name: /^Saved work,/ });
  fireEvent.click(tipRow);
  expect(read).toHaveBeenCalledWith(repo.path, tip.id);
  expect(within(description()).getByRole("status").textContent).toBe("Loading description…");
  fireEvent.keyDown(tipRow, { key: "ArrowDown" });
  expect(read).toHaveBeenCalledWith(repo.path, parentId);
  const body = await within(description()).findByText("First paragraph Last paragraph");
  expect(body.textContent).toBe("  First paragraph\r\n\r\nLast paragraph");
  await act(async () => pending.resolve("Saved work\n\nSuperseded body"));
  expect(description().textContent).not.toContain("Superseded body");

  fireEvent.click(tipRow);
  expect(await within(description()).findByText("No description")).toBeTruthy();
  fireEvent.click(graph.getByRole("button", { name: /^Current changes,/ }));
  expect(graph.queryByRole("region", { name: "Commit description" })).toBeNull();
});

it("shows references in the Labels column and leaves it empty on rows without references", async () => {
  const repo = repository();
  const tip = repo.commits[0];
  const parentId = "b".repeat(40);
  tip.parents = [parentId];
  repo.commits.push({
    ...tip,
    id: parentId,
    shortId: parentId.slice(0, 7),
    subject: "Earlier work",
    parents: [],
  });
  repo.status.files.push(fileChange("staged-notes", "A", "."));
  await setup(repo);
  fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
  const graph = within(screen.getByRole("region", { name: "Commit graph" }));
  const header = graph.getByText("Labels").closest(".graph-columns")!;
  expect(Array.from(header.children, (cell) => cell.textContent)).toEqual([
    "Graph",
    "Labels",
    "Commit",
    "Author",
    "Date & time",
  ]);
  const row = graph.getByRole("button", { name: /^Saved work,/ });
  expect(Array.from(row.children[1].children, (badge) => badge.textContent)).toEqual([
    "HEAD",
    "main",
    "feature/sidebar",
    "origin/main",
    "v1.0",
    "stash@{0}",
  ]);
  expect(row.children[2].textContent).toBe(tip.subject + tip.shortId);
  for (const subject of ["Earlier work", "Current changes", "Staged changes"]) {
    const entry = graph.getByRole("button", { name: new RegExp(`^${subject},`) });
    expect(entry.children[1].textContent).toBe("");
    expect(entry.children[2].textContent).toContain(subject);
  }
});

it.each(deletions)(
  "offers %s deletion from the selected history commit",
  async (_section, _name, remove, confirm, expected) => {
    const { repo, action } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
    fireEvent.click(screen.getByRole("button", { name: /^Saved work,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Commit actions" }));
    const graph = within(screen.getByRole("region", { name: "Commit graph" }));
    expect(graph.queryByRole("button", { name: "Delete main" })).toBeNull();
    expect(graph.queryByRole("button", { name: "Delete origin/main" })).toBeNull();
    fireEvent.click(graph.getByRole("button", { name: remove }));
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        expected,
        expect.any(String),
        expect.any(Function),
      ),
    );
  },
);

it.each(deletions)(
  "confirms %s deletion from the sidebar context menu without navigating",
  async (section, name, remove, confirm, expected) => {
    const { repo, action } = await setup();
    expand(section === "Branches" ? "Branch folder feature" : `${section} 1`);
    const region = within(screen.getByRole("region", { name: section }));
    const label = `Show ${name} in the commit graph`;
    const target = region.getByRole("button", { name: label });
    fireEvent.contextMenu(target, { clientX: 180, clientY: 300 });
    expect(screen.getByRole("heading", { name: "Changes", level: 2 })).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: remove }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    fireEvent.contextMenu(target, { clientX: 180, clientY: 300 });
    fireEvent.click(screen.getByRole("menuitem", { name: remove }));
    vi.mocked(git.snapshot).mockResolvedValue({
      ...repo,
      branches: [repo.branches[0], repo.branches[2]],
      tags: [],
      stashes: [],
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        expected,
        expect.any(String),
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(region.queryByRole("button", { name: label })).toBeNull());
  },
);

it.each(deletions)(
  "offers %s deletion from its details row context menu",
  async (section, name, remove, confirm, expected) => {
    const { repo, action } = await setup();
    fireEvent.click(screen.getByRole("button", { name: section }));
    const target = screen
      .getAllByRole("button", { name: `Show ${name} in the commit graph` })
      .at(-1)!
      .closest(".detail-row")!;
    fireEvent.contextMenu(target, { clientX: 700, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: remove }));
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        expected,
        expect.any(String),
        expect.any(Function),
      ),
    );
  },
);

it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
  "opens a reference context menu with $key and restores focus on Escape",
  async (keys) => {
    const { action } = await setup();
    expand("Tags 1");
    const region = within(screen.getByRole("region", { name: "Tags" }));
    const target = region.getByRole("button", { name: "Show v1.0 in the commit graph" });
    target.focus();
    fireEvent.keyDown(target, keys);
    const item = screen.getByRole("menuitem", { name: "Delete tag v1.0" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(target);
    expect(action).not.toHaveBeenCalled();
  },
);

it("dismisses reference menus and retargets them when another row is right-clicked", async () => {
  const { action } = await setup();
  expand("Tags 1");
  expand("Stashes 1");
  const tag = within(screen.getByRole("region", { name: "Tags" })).getByRole("button", {
    name: "Show v1.0 in the commit graph",
  });
  const stash = within(screen.getByRole("region", { name: "Stashes" })).getByRole("button", {
    name: "Show stash@{0} in the commit graph",
  });
  fireEvent.contextMenu(tag, { clientX: 100, clientY: 200 });
  fireEvent.pointerDown(stash, { button: 2 });
  fireEvent.contextMenu(stash, { clientX: 100, clientY: 300 });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(screen.getByRole("menuitem", { name: "Drop stash@{0}" })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(tag, { clientX: 100, clientY: 200 });
  fireEvent.scroll(document);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

it.each([false, true])(
  "protects the current branch and blocks branch menus while busy (busy: %s)",
  async (busy) => {
    const { action } = await setup(repository(), busy);
    if (busy) {
      expand("Branch folder feature");
      expand("Remote origin");
    }
    const region = within(screen.getByRole("region", { name: "Branches" }));
    for (const name of ["main", ...(busy ? ["feature/sidebar", "origin/main"] : [])]) {
      fireEvent.contextMenu(
        region.getByRole("button", { name: `Show ${name} in the commit graph` }),
      );
      expect(screen.queryByRole("menu")).toBeNull();
    }
    expect(action).not.toHaveBeenCalled();
  },
);

it.each(["Tags", "Stashes"])("prevents %s context actions while busy", async (section) => {
  const { action } = await setup(repository(), true);
  expand(`${section} 1`);
  const region = within(screen.getByRole("region", { name: section }));
  fireEvent.contextMenu(region.getByRole("button", { name: /^Show .* in the commit graph$/ }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

const remoteRefs: RemoteRefs = {
  destination: "verified-push-destination",
  url: "https://example.invalid/repo.git",
  refs: [{ name: "main", tip: "b".repeat(40) }],
};

it.each(["sidebar", "details", "history"])(
  "deletes the chosen remote branch from the %s menu after loading and confirmation",
  async (surface) => {
    const { repo, action } = await setup();
    const pending = deferred<RemoteRefs>();
    const load = vi.spyOn(git, "remoteRefs").mockReturnValue(pending.promise);
    if (surface === "history") {
      fireEvent.click(screen.getByRole("button", { name: "Commit graph" }));
      const row = screen.getByRole("button", { name: /^Saved work,/ });
      fireEvent.contextMenu(row);
      fireEvent.change(screen.getByRole("combobox", { name: "Branch for actions" }), {
        target: { value: "remote/origin/main" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Delete origin/main" }));
    } else {
      if (surface === "details") fireEvent.click(screen.getByRole("button", { name: "Branches" }));
      else expand("Remote origin");
      const targets = screen.getAllByRole("button", {
        name: "Show origin/main in the commit graph",
      });
      fireEvent.contextMenu(surface === "details" ? targets.at(-1)! : targets[0]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete origin/main" }));
    }
    const dialog = within(screen.getByRole("dialog"));
    expect(load).toHaveBeenCalledWith(repo.path, "origin", "branch");
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Remote" }).value).toBe(
      "origin",
    );
    expect(
      dialog.getByRole<HTMLButtonElement>("button", { name: "Delete remote branch" }).disabled,
    ).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await act(async () => pending.resolve(remoteRefs));
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Remote branch" }).value).toBe(
      "main",
    );
    expect(dialog.getByText(/bbbbbbbbbbbb/)).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Delete remote branch" }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        repo.path,
        {
          kind: "deleteRemoteRef",
          refKind: "branch",
          remote: "origin",
          name: "main",
          tip: "b".repeat(40),
          destination: remoteRefs.destination,
        },
        expect.any(String),
        expect.any(Function),
      ),
    );
  },
);

it("matches remote names containing slashes and preserves the branch path", async () => {
  const repo = repository();
  repo.remotes.push({ name: "origin/team", url: "https://example.invalid/team.git" });
  repo.branches.push({ ...repo.branches[2], name: "origin/team/feature/sidebar" });
  const { action } = await setup(repo);
  expand("Remote origin/team");
  expand("Branch folder origin/team/feature");
  const load = vi.spyOn(git, "remoteRefs").mockResolvedValue({
    ...remoteRefs,
    refs: [{ name: "feature/sidebar", tip: "b".repeat(40) }],
  });
  fireEvent.contextMenu(
    screen.getByRole("button", {
      name: "Show origin/team/feature/sidebar in the commit graph",
    }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete origin/team/feature/sidebar" }));
  const dialog = within(screen.getByRole("dialog"));
  await waitFor(() =>
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Remote branch" }).value).toBe(
      "feature/sidebar",
    ),
  );
  expect(load).toHaveBeenCalledWith(repo.path, "origin/team", "branch");
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(action).not.toHaveBeenCalled();
});

it.each(["missing", "failed"])(
  "blocks remote branch deletion when loading is %s",
  async (state) => {
    const { action } = await setup();
    expand("Remote origin");
    const load = vi.spyOn(git, "remoteRefs");
    if (state === "failed") load.mockRejectedValue({ key: "authenticationRequired" });
    else load.mockResolvedValue({ ...remoteRefs, refs: [{ name: "other", tip: "c".repeat(40) }] });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Show origin/main in the commit graph" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete origin/main" }));
    const dialog = within(screen.getByRole("dialog"));
    await waitFor(() => expect(dialog.queryByRole("status")).toBeNull());
    expect(
      dialog.getByRole<HTMLButtonElement>("button", { name: "Delete remote branch" }).disabled,
    ).toBe(true);
    expect(action).not.toHaveBeenCalled();
    if (state === "failed") expect(dialog.getByRole("alert")).toBeTruthy();
    load.mockResolvedValue(remoteRefs);
    fireEvent.click(dialog.getByRole("button", { name: "Reload list" }));
    await waitFor(() =>
      expect(
        dialog.getByRole<HTMLButtonElement>("button", { name: "Delete remote branch" }).disabled,
      ).toBe(false),
    );
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Remote branch" }).value).toBe(
      "main",
    );
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
  },
);

it("preserves a rejected stash deletion and prevents repeat actions while busy", async () => {
  const { action } = await setup();
  expand("Stashes 1");
  const pending = deferred<never>();
  action.mockReturnValue(pending.promise);
  const region = within(screen.getByRole("region", { name: "Stashes" }));
  const target = region.getByRole<HTMLButtonElement>("button", {
    name: "Show stash@{0} in the commit graph",
  });
  fireEvent.contextMenu(target);
  fireEvent.click(screen.getByRole("menuitem", { name: "Drop stash@{0}" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Drop stash" }));
  expect(region.getByRole<HTMLButtonElement>("button", { name: "Stash changes" }).disabled).toBe(
    true,
  );
  expect(target.disabled).toBe(true);
  fireEvent.contextMenu(target);
  expect(screen.queryByRole("menu")).toBeNull();
  await act(async () => pending.reject({ key: "staleStash" }));
  expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain(
    "stash list changed",
  );
  expect(target.disabled).toBe(false);
});

it.each(["clean", "unborn", "conflict", "operation", "busy"])(
  "disables stash creation for a %s repository",
  async (state) => {
    const repo = repository();
    if (state === "clean") repo.status.files = [];
    if (state === "unborn") repo.status.head = null;
    if (state === "conflict") repo.status.files[0].conflict = true;
    if (state === "operation") repo.operation = "merge";
    await setup(repo, state === "busy");
    const stashes = within(screen.getByRole("region", { name: "Stashes" }));
    expect(stashes.getByRole<HTMLButtonElement>("button", { name: "Stash changes" }).disabled).toBe(
      true,
    );
    const branches = within(screen.getByRole("region", { name: "Branches" }));
    expect(branches.queryByRole("button", { name: "Delete main" })).toBeNull();
    expect(branches.queryByRole("button", { name: "Delete origin/main" })).toBeNull();
  },
);
