import type { LocalizedMessage } from "../i18n";
import { reachableCommits } from "./branches";
import {
  staged,
  unstaged,
  type Action,
  type Diff,
  type FileChange,
  type Selection,
  type Snapshot,
} from "./git";

const file = (path: string, index: string, worktree: string): FileChange => ({
  id: path,
  path,
  originalPath: null,
  index,
  worktree,
  conflict: false,
});

const files = [
  file("src/components/Editor.tsx", ".", "M"),
  file("src/styles/globals.css", ".", "M"),
  file("src/lib/useAutosave.ts", ".", "?"),
  file("README.md", ".", "M"),
  file("src/lib/format.ts", "M", "."),
  file("package.json", "M", "."),
];

export const demo: Snapshot = {
  path: "",
  name: "fieldnotes",
  status: { branch: "main", upstream: "origin/main", head: "fa493e2", ahead: 1, behind: 0, files },
  branches: [
    { name: "main", tip: "fa493e2", current: true, remote: false, upstream: "origin/main" },
    {
      name: "feature/editor",
      tip: "12c57ae",
      current: false,
      remote: false,
      upstream: "origin/feature/editor",
    },
    { name: "fix/mobile-layout", tip: "be44f76", current: false, remote: false, upstream: "" },
    { name: "origin/main", tip: "d81bc30", current: false, remote: true, upstream: "" },
    { name: "origin/feature/editor", tip: "12c57ae", current: false, remote: true, upstream: "" },
  ],
  commits: [
    {
      id: "9f61c20",
      shortId: "9f61c20",
      parents: ["fa493e2", "bd75c21"],
      subject: "On main: try a compact editor layout",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-13T12:15:00+09:00",
    },
    {
      id: "bd75c21",
      shortId: "bd75c21",
      parents: ["fa493e2"],
      subject: "index on main: fa493e2 Refine the editor toolbar",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-13T12:15:00+09:00",
    },
    {
      id: "fa493e2",
      shortId: "fa493e2",
      parents: ["d81bc30"],
      subject: "Refine the editor toolbar",
      description:
        "Group formatting controls and simplify the writing experience.\n\nKeep keyboard shortcuts visible in the toolbar.",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-13T11:34:00+09:00",
    },
    {
      id: "8e5c74a",
      shortId: "8e5c74a",
      parents: ["d81bc30", "06b3a21"],
      subject: "On main: experiment with note colors",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-13T11:00:00+09:00",
    },
    {
      id: "06b3a21",
      shortId: "06b3a21",
      parents: ["d81bc30"],
      subject: "index on main: d81bc30 Improve keyboard navigation",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-13T11:00:00+09:00",
    },
    {
      id: "be44f76",
      shortId: "be44f76",
      parents: ["d81bc30"],
      subject: "Keep the note list visible on mobile",
      author: "Morgan Lee",
      email: "morgan@example.com",
      date: "2026-11-13T10:04:00+09:00",
    },
    {
      id: "d81bc30",
      shortId: "d81bc30",
      parents: ["f972ac4"],
      subject: "Improve keyboard navigation",
      author: "Jamie Park",
      email: "jamie@example.com",
      date: "2026-11-12T15:19:00+09:00",
    },
    {
      id: "f972ac4",
      shortId: "f972ac4",
      parents: ["1b7c251", "12c57ae"],
      subject: "Merge feature/editor into main",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-12T13:40:00+09:00",
    },
    {
      id: "12c57ae",
      shortId: "12c57ae",
      parents: ["53c6ae0"],
      subject: "Show when a note was last saved",
      author: "Morgan Lee",
      email: "morgan@example.com",
      date: "2026-11-12T10:42:00+09:00",
    },
    {
      id: "53c6ae0",
      shortId: "53c6ae0",
      parents: ["953e1ba"],
      subject: "Save drafts as you type",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-11T16:19:00+09:00",
    },
    {
      id: "1b7c251",
      shortId: "1b7c251",
      parents: ["953e1ba"],
      subject: "Add note search to the sidebar",
      author: "Jamie Park",
      email: "jamie@example.com",
      date: "2026-11-11T14:09:00+09:00",
    },
    {
      id: "6b27a90",
      shortId: "6b27a90",
      parents: ["953e1ba"],
      subject: "Package the early preview",
      author: "Jamie Park",
      email: "jamie@example.com",
      date: "2026-11-10T15:00:00+09:00",
    },
    {
      id: "953e1ba",
      shortId: "953e1ba",
      parents: ["a2b564e"],
      subject: "Start the Fieldnotes workspace",
      author: "Avery Chen",
      email: "avery@example.com",
      date: "2026-11-10T09:57:00+09:00",
    },
    {
      id: "a2b564e",
      shortId: "a2b564e",
      parents: [],
      subject: "Initialize the repository",
      author: "Jamie Park",
      email: "jamie@example.com",
      date: "2026-11-09T14:29:00+09:00",
    },
  ],
  hasOlderCommits: false,
  worktrees: [],
  stashes: [
    { id: "stash@{0}", tip: "9f61c20", subject: "On main: try a compact editor layout" },
    { id: "stash@{1}", tip: "8e5c74a", subject: "On main: experiment with note colors" },
  ],
  tags: [
    { name: "v0.1.0", tip: "953e1ba" },
    { name: "v0.1.0-preview", tip: "6b27a90" },
  ],
  remotes: [{ name: "origin", url: "https://github.com/example/fieldnotes.git" }],
  operation: null,
  pushLease: null,
  settings: {
    name: "Avery Chen",
    email: "avery@example.com",
    signingFormat: "ssh",
    signCommits: false,
    signingKey: "",
  },
};

const editorPatch = `diff --git a/src/components/Editor.tsx b/src/components/Editor.tsx
index 74dc333..a321b45 100644
--- a/src/components/Editor.tsx
+++ b/src/components/Editor.tsx
@@ -12,10 +12,13 @@ export function Editor({ note }: EditorProps) {
   const [content, setContent] = useState(note.content);
-  const [isDirty, setIsDirty] = useState(false);
+  const { status, save } = useAutosave(note.id);

   const handleChange = (value: string) => {
     setContent(value);
-    setIsDirty(true);
+    save(value);
   };

+  const isSaving = status === 'saving';
+  const saveLabel = isSaving ? 'Saving…' : 'All changes saved';
+
   return (
     <section className="editor">
@@ -28,9 +31,13 @@ export function Editor({ note }: EditorProps) {
       <EditorToolbar note={note} />
       <EditorContent value={content} onChange={handleChange} />

-      {isDirty && <span>Unsaved changes</span>}
+      <div className="editor-status" aria-live="polite">
+        <span className={isSaving ? 'status pending' : 'status saved'}>
+          {saveLabel}
+        </span>
+      </div>
     </section>
   );
 }
`;

const examples: Record<string, string> = {
  "src/styles/globals.css":
    "@@ -17,4 +17,5 @@ :root {\n   --text-color: #252838;\n-  --editor-gap: 12px;\n+  --editor-gap: 16px;\n+  --status-color: #32936f;\n }\n",
  "src/lib/useAutosave.ts":
    "@@ -0,0 +1,4 @@\n+export function useAutosave(noteId: string) {\n+  const save = (content: string) => localStorage.setItem(noteId, content);\n+  return { status: 'saved', save };\n+}\n",
  "README.md":
    "@@ -4,3 +4,4 @@ A quiet space for your ideas.\n - Write and organize notes\n+- Save changes as you type\n - Find notes by title\n",
  "src/lib/format.ts":
    "@@ -3,4 +3,4 @@ export function formatTitle(title: string) {\n-  return title.trim();\n+  return title.trim().replace(/\\s+/g, ' ');\n }\n",
  "package.json":
    '@@ -2,4 +2,4 @@\n   "name": "fieldnotes",\n-  "version": "0.1.0",\n+  "version": "0.2.0",\n   "type": "module",\n',
};

const commitPatches: Record<string, readonly [string, string]> = {
  "9f61c20": [
    "src/styles/globals.css",
    "@@ -3,3 +3,3 @@\n :root {\n-  --editor-gap: 16px;\n+  --editor-gap: 8px;\n }\n",
  ],
  "8e5c74a": [
    "src/styles/globals.css",
    "@@ -3,3 +3,4 @@\n :root {\n   --editor-gap: 12px;\n+  --note-color: #fff5d6;\n }\n",
  ],
  "6b27a90": [
    "package.json",
    '@@ -2,3 +2,3 @@\n   "name": "fieldnotes",\n-  "version": "0.1.0",\n+  "version": "0.1.0-preview",\n   "type": "module",\n',
  ],
  be44f76: [
    "src/styles/globals.css",
    "@@ -2,3 +2,7 @@\n .note-list {\n   display: grid;\n }\n+\n+@media (max-width: 640px) {\n+  .note-list { position: sticky; top: 0; }\n+}\n",
  ],
  d81bc30: [
    "src/components/NoteList.tsx",
    '@@ -18,2 +18,3 @@\n   <ul aria-label="Notes">\n+    <li><button onClick={selectNext}>Next note</button></li>\n   </ul>\n',
  ],
  f972ac4: [
    "src/components/Editor.tsx",
    "@@ -27,2 +27,3 @@\n   <EditorContent value={content} />\n+  <SaveStatus updatedAt={note.updatedAt} />\n </section>\n",
  ],
  "12c57ae": [
    "src/components/SaveStatus.tsx",
    "@@ -0,0 +1,3 @@\n+export function SaveStatus({ updatedAt }: { updatedAt: string }) {\n+  return <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleTimeString()}</time>;\n+}\n",
  ],
  "53c6ae0": ["src/lib/useAutosave.ts", examples["src/lib/useAutosave.ts"]],
  "1b7c251": [
    "src/components/NoteList.tsx",
    '@@ -8,3 +8,4 @@\n export function NoteList({ notes }: Props) {\n-  return renderNotes(notes);\n+  const [query, setQuery] = useState("");\n+  return renderSearchableNotes(notes, query, setQuery);\n }\n',
  ],
  "953e1ba": ["README.md", examples["README.md"]],
  a2b564e: ["README.md", "@@ -0,0 +1,3 @@\n+# Fieldnotes\n+\n+A quiet space for your ideas.\n"],
};

export function demoDiff(selection: Selection, snapshot: Snapshot = demo): Diff {
  if (selection.kind === "changes") {
    const inIndex = selection.id === "staged";
    return {
      text: snapshot.status.files
        .filter(inIndex ? staged : unstaged)
        .map((file) => demoDiff({ kind: "file", id: file.id, staged: inIndex }, snapshot).text)
        .join(""),
      truncated: false,
      hunkToken: null,
    };
  }
  if (
    selection.id === "fa493e2" ||
    (selection.kind === "file" && selection.id === "src/components/Editor.tsx")
  ) {
    return { text: editorPatch, truncated: false, hunkToken: null };
  }
  const [path, patch] =
    selection.kind === "commit"
      ? (commitPatches[selection.id] ?? [])
      : [selection.id, examples[selection.id]];
  return {
    text: path
      ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch ?? ""}`
      : "",
    truncated: false,
    hunkToken: null,
  };
}

export function demoAction(snapshot: Snapshot, action: Action): Snapshot {
  const changes = snapshot.status.files;
  if (
    action.kind === "stage" ||
    action.kind === "unstage" ||
    action.kind === "stageFiles" ||
    action.kind === "unstageFiles" ||
    action.kind === "stageAll" ||
    action.kind === "unstageAll"
  ) {
    const adding =
      action.kind === "stage" || action.kind === "stageFiles" || action.kind === "stageAll";
    const ids =
      "ids" in action ? new Set(action.ids) : "id" in action ? new Set([action.id]) : null;
    const files = changes.map((file) => {
      if (ids && !ids.has(file.id)) return file;
      if (adding && file.worktree !== ".") {
        return { ...file, index: file.worktree === "?" ? "A" : file.worktree, worktree: "." };
      }
      if (!adding && file.index !== ".") {
        return { ...file, index: ".", worktree: file.index === "A" ? "?" : file.index };
      }
      return file;
    });
    return { ...snapshot, status: { ...snapshot.status, files } };
  }
  if (action.kind === "switchBranch") {
    const target = snapshot.branches.find(
      (candidate) => candidate.name === action.name && candidate.remote === action.remote,
    );
    if (target) {
      const name = target.remote ? target.name.slice(target.name.indexOf("/") + 1) : target.name;
      const local = snapshot.branches.find(
        (candidate) => !candidate.remote && candidate.name === name,
      );
      const branches = local
        ? snapshot.branches
        : [...snapshot.branches, { ...target, name, remote: false, upstream: target.name }];
      const current = local ?? branches.at(-1)!;
      const unchanged = snapshot.status.branch === current.name;
      return {
        ...snapshot,
        branches: branches.map((branch) => ({ ...branch, current: branch === current })),
        status: {
          ...snapshot.status,
          branch: current.name,
          head: current.tip,
          upstream: current.upstream || null,
          ahead: unchanged ? snapshot.status.ahead : 0,
          behind: unchanged ? snapshot.status.behind : 0,
        },
      };
    }
  }
  if (action.kind === "createBranch" || action.kind === "createTag") {
    const tip = action.start ?? snapshot.status.head;
    if (!tip || !snapshot.commits.some(({ id }) => id === tip))
      throw { key: "startingCommitRequired" } satisfies LocalizedMessage;
    if (!action.name.trim() || /[\s~^:?*[\\]/.test(action.name) || action.name.startsWith("-"))
      throw { key: "invalidGitName" } satisfies LocalizedMessage;
    if (action.kind === "createTag") {
      if (snapshot.tags.some(({ name }) => name === action.name))
        throw { key: "tagExists" } satisfies LocalizedMessage;
      return { ...snapshot, tags: [...snapshot.tags, { name: action.name, tip }] };
    }
    if (snapshot.branches.some(({ name, remote }) => name === action.name && !remote))
      throw { key: "branchExists" } satisfies LocalizedMessage;
    const withBranch = {
      ...snapshot,
      branches: [
        ...snapshot.branches,
        { name: action.name, tip, current: false, remote: false, upstream: "" },
      ],
    };
    return action.checkout
      ? demoAction(withBranch, { kind: "switchBranch", name: action.name, remote: false })
      : withBranch;
  }
  if (action.kind === "deleteBranch") {
    const branch = snapshot.branches.find((item) => !item.remote && item.name === action.name);
    if (!branch || branch.current) throw { key: "missingBranch", detail: action.name };
    const upstream = snapshot.branches.find((item) => item.name === branch.upstream);
    const base = upstream?.tip ?? snapshot.status.head;
    if (!base || !reachableCommits(snapshot.commits, [base]).has(branch.tip)) {
      throw { key: "branchNotMerged" } satisfies LocalizedMessage;
    }
    return { ...snapshot, branches: snapshot.branches.filter((item) => item !== branch) };
  }
  if (action.kind === "deleteTag") {
    return { ...snapshot, tags: snapshot.tags.filter((tag) => tag.name !== action.name) };
  }
  if (action.kind === "dropStash") {
    if (!snapshot.stashes.some((stash) => stash.id === action.id && stash.tip === action.tip)) {
      throw { key: "staleStash" } satisfies LocalizedMessage;
    }
    const stashes = snapshot.stashes
      .filter((stash) => stash.id !== action.id)
      .map((stash, index) => ({ ...stash, id: `stash@{${index}}` }));
    return { ...snapshot, stashes };
  }
  if (action.kind === "saveSettings") return { ...snapshot, settings: action.settings };
  if (action.kind === "commit" && changes.some((change) => change.index !== ".")) {
    const shortId = Date.now().toString(16).slice(-7);
    const commit = {
      id: shortId,
      shortId,
      parents: snapshot.status.head ? [snapshot.status.head] : [],
      subject: action.summary,
      author: snapshot.settings.name || "Avery Chen",
      email: snapshot.settings.email,
      date: new Date().toISOString(),
    };
    return {
      ...snapshot,
      status: {
        ...snapshot.status,
        head: shortId,
        ahead: snapshot.status.ahead + 1,
        files: changes.filter((file) => file.index === "."),
      },
      branches: snapshot.branches.map((branch) =>
        branch.current ? { ...branch, tip: shortId } : branch,
      ),
      commits: [commit, ...snapshot.commits],
    };
  }
  throw { key: "localRepoRequired" } satisfies LocalizedMessage;
}
