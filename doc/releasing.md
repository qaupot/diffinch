# Preparing a public release

## First public repository

- Review all intended files and Git history for credentials, private repository data, and personal paths. Run Gitleaks on both history and the source tree; never publish a scanner report containing a secret. Confirm `.idea`, `.env` files, dependencies, and build outputs are untracked.
- Confirm the owner and repository name, license ownership, public description, and project links. Update README links if the documentation moves to a separate site.
- Enable GitHub private vulnerability reporting so the route in `SECURITY.md` is available. Enable secret scanning and push protection where available.
- Run the local checks and scans listed below before publishing.
- Review the [dependency notes](security-review.md) and contributor docs. Confirm that someone will monitor private vulnerability reports; no response-time promise is made in the policy.

## Every version

1. Start from a reviewed commit and passing local checks on each platform you intend to distribute. Review dependency advisories and license changes. Use `npm run version:patch`, `version:minor`, or `version:major`; the scripts synchronize all version files without committing or tagging.
2. Use `.nvmrc` and `rust-toolchain.toml`, install with `npm ci`, and regenerate notices after dependency or toolchain changes. Run `npm run check:all`, `npm run build`, `npm audit --audit-level=low`, and the [Rust advisory review commands](security-review.md#manual-checks-and-re-review). The two documented GTK warnings do not block source publication; their Linux disposition applies only while the checked evidence remains valid.
3. Build packages on each platform you intend to distribute with `npm run tauri build -- --ci -- --locked`. For a local unsigned macOS bundle check, use `npm run tauri build -- --bundles app --no-sign --ci -- --locked`.
4. Test the packaged app using the smoke checklist below. Confirm the bundle contains `LICENSE` and `THIRD_PARTY_NOTICES.txt` and that **About → Open-source licenses** works offline. Review native libraries/runtime licenses for each installer format, especially Linux AppImage.
5. Sign/notarize platform packages when distributing binaries. Store signing credentials securely outside the repository and use them only for trusted release builds.
6. Prepare release notes describing changes, known issues, tested OS versions/architectures, and the required system Git version. Publish checksums for the exact packages being distributed. Create the release/tag only after the packages and notes have been reviewed.

## Packaged app smoke checklist

Use disposable repositories, including a local bare remote. Repeat for each supported platform and package format; a passing compile does not validate native webview behavior.

- Launch from the installed app, open/restore multiple repositories, switch tabs, and verify filesystem changes refresh the view.
- Review unstaged/staged text and image diffs; stage/unstage a hunk and selected lines, including blank context and Unicode filenames.
- Write a multiline commit, verify controls freeze while it is running, and confirm a failed hook preserves the draft.
- Cancel a slow commit hook and a network operation, including from an open dialog. Confirm subprocesses stop, the draft survives, and refreshed Git state is displayed without retrying the operation.
- Browse a clean file's history through a rename, inspect paged blame and follow a blame commit. Test file inspection cancellation and switching selections before a response arrives.
- Open a working file in the configured editor and resolve a conflict through the configured merge tool. Check missing-tool errors and review the staged result before continuing.
- Fetch, pull, push, and cancel a transfer. Verify authentication/signing through the user's configured helpers without exposing credentials in displayed URLs.
- Create a branch/worktree, merge with a conflict, resolve/abort, and exercise interactive rebase including reword and root commits. Verify stale-state errors preserve local work.
- Check submodules, subtree, and LFS when those tools are installed; check clear errors when an optional tool is missing.
- Check keyboard focus, dialogs, resizing, theme, all locales, native menus, and offline license display.

Do not claim a platform or architecture is supported solely because another platform passes. Local checks and manual package validation must supply the evidence for each release.
