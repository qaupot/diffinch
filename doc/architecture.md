# Architecture and conventions

## Boundaries

The frontend renders repository state and sends typed requests through `src/lib/git.ts`. The backend in `src-tauri/src/main.rs` exposes Tauri commands and runs blocking Git work off the UI thread. `src-tauri/src/git.rs` is a small facade around `Repo`; its submodules own the actual Git workflows. `src-tauri/src/watch.rs` reports filesystem changes so the frontend can refresh affected state.

| Location                                                                             | Responsibility                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `src/workspace/RepositoryWorkspace.tsx`                                              | Compose the repository workspace and wire state to views                         |
| `src/workspace/WorkspaceTitlebar.tsx`, `SyncToolbar.tsx`, `WorkspaceDialogHost.tsx`  | Workspace navigation, transfer controls, and dialog rendering                    |
| `src/workspace/useRepositorySession.ts`                                              | Open repositories, active tab, and persisted session                             |
| `src/workspace/useRepositoryState.ts`, `useRepositoryDiff.ts`, `useGitOperations.ts` | Refresh state, load diffs, and coordinate mutations                              |
| `src/lib/git-types.ts`, `repository-tools.ts`                                        | Frontend IPC contracts                                                           |
| `src/lib/patch.ts`                                                                   | Pure patch parsing and display alignment                                         |
| `src/dialogs/`, `src/i18n/`, `src/icons.tsx`                                         | Dialogs, localized text, and local SVG icons                                     |
| `src-tauri/src/git/model.rs`, `actions.rs`                                           | Serialized data and action dispatch                                              |
| `src-tauri/src/git/process.rs`                                                       | Git process configuration, bounded output, progress, and cancellation            |
| `src-tauri/src/git/file_history.rs`, `external_tools.rs`                             | Committed file catalog, rename history, blame, editor and merge-tool integration |
| `src/FileHistoryView.tsx`, `useFileInspection.ts`, `workspace/OperationProgress.tsx` | File inspection, cancellation of superseded reads, shared operation feedback     |
| `src-tauri/src/git/status.rs`, `refs.rs`, `remotes.rs`                               | Repository state, references, and remote operations                              |
| `src-tauri/src/git/diff.rs`, `staging.rs`, `conflicts.rs`, `images.rs`               | Diffs, index changes, conflicts, and image previews                              |
| `src-tauri/src/git/rebase.rs`, `worktrees.rs`, `extensions.rs`                       | Rebase, worktree, submodule, subtree, and LFS workflows                          |
| `src-tauri/src/git/credentials.rs`, `search.rs`                                      | Credential helper integration and history search                                 |
| `scripts/`, `tests/contracts/`                                                       | Version/notices tooling and cross-language request fixtures                      |

## Preferences and session storage

Desktop preferences and repository sessions use Tauri Store in `settings.json` under the `Diffinch` folder in the system's user data directory. `app.appDirectoriesOverride.data` in `src-tauri/tauri.conf.json` sets this location for both Rust and the frontend store lookup:

- macOS: `~/Library/Application Support/Diffinch/settings.json`
- Windows: `%APPDATA%\Diffinch\settings.json`
- Linux: `$XDG_DATA_HOME/Diffinch/settings.json` (defaults to `~/.local/share/Diffinch/settings.json`)

`src-tauri/src/preferences.rs` opens this fixed file during setup, rejecting unreadable or malformed files before registering the store. The previous `app.diffinch.desktop/settings.json` location is not read or migrated. The frontend has access to the existing store but cannot load arbitrary store files.

`src/lib/preferences.ts` loads a synchronous read cache before React mounts and serializes explicit asynchronous saves. It imports recognized legacy `localStorage` keys once, preserves newer native values, and records `diffinch.storageVersion` with the migration. Legacy values remain untouched as a recovery copy; the marker prevents deleted preferences from being imported again. The browser demo continues to use `localStorage` through the same adapter.

Storage migration version 2 includes the external editor preference. When upgrading from version 1, it imports only that previously omitted key if no native value exists, without restoring other deleted preferences.

Failed saves retain pending changes for a later retry and show a notice. If the store cannot be opened, the interface remains usable with in-memory preferences and a notice; the existing file is not overwritten. Settings retain their previous string representations, including JSON-encoded sessions and branch preferences. Git data and credentials continue to use Git and its credential helpers.

## Code conventions

- TypeScript is strict. Prefer explicit domain types and discriminated unions; keep transport details in the Git adapter. Use PascalCase component files, `use`-prefixed hook files, and lowercase utility files. Keep helpers private unless another module needs them.
- Rust uses rustfmt, Clippy with warnings denied, snake_case modules, and narrow visibility. Production modules import their dependencies explicitly; wildcard imports are limited to test fixtures. Git failures carry a localized message key and optional detail through `GitError`.
- Prettier owns frontend, script, and Markdown formatting; `.editorconfig` defines basic whitespace. ESLint checks unused code and React hook correctness. Generated notices, lockfiles, and upstream license texts are not reformatted.
- Visible text belongs in `src/i18n/`; update every supported locale when adding a message. Reuse existing components and local icons before introducing a dependency.
- Keep rendering components focused. Put asynchronous workflow state in hooks, pure transformations in `src/lib/`, and domain-specific Git behavior in the matching Rust module. Avoid another broad utility module or adding workflow logic to the facade.

## Git operation invariants

Pass arguments through `Command` rather than building shell commands from user text. Validate references and repository-relative paths, use `--` or `--end-of-options` at the relevant Git boundary, and retain stale-state checks before destructive mutations. Never weaken those checks just to make an operation succeed.

Treat Git output as a protocol: preserve NUL-delimited paths, disable presentation settings that change parsed diffs, bound output and image sizes, and retain the existing encoding and truncation errors. Do not log credential-bearing URLs. Use the shared remote redaction function for every display surface.

During a commit, the composer freezes the submitted draft. It clears that draft only after a successful commit; a failure preserves it. Async refreshes and file selection must remain scoped to the repository and request that produced them.

Controlled workers install a scoped cancellation context on their blocking thread before repository discovery and gate acquisition. Nested Git subprocesses inherit it, including hooks and signing descendants. The context is restored when the operation exits, so a cancelled action cannot poison its recovery refresh. The process loop keeps cancellation available until output readers finish, even if Git exits before a descendant closes its pipes. Queued controlled workers check cancellation while waiting for the common-repository gate. File inspection requests carry a concrete revision after catalog resolution; changing the repository, file, revision, or page cancels the old request and ignores its eventual response.

## Tests

Frontend tests live beside the code they exercise and use Vitest, jsdom, and Testing Library. They cover user-visible state transitions, request races, selection, and pure parsing; avoid tests that only repeat implementation details.

Rust integration tests use temporary Git repositories and actual Git commands. Shared workflow regressions live in `git/tests.rs`; focused module tests live beside their module. Keep platform-specific behavior behind the appropriate `cfg` and use portable filenames in tests that create files on Windows. Pure parser tests still exercise tabs, newlines, and other unusual valid Git paths on every platform.

`git/contracts.rs` and `scripts/check-contracts.mjs` exercise the Serde/TypeScript boundary without generating application types. Request fixtures cover every frontend action discriminator, and representative backend responses must satisfy the exported TypeScript types. Extend those cases when a boundary changes.
