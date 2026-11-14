# Development

## Prerequisites

Use Node 24.22.3 from `.nvmrc` (for example, `nvm install && nvm use`). The supported Node ranges are declared in `package.json`. Rustup reads `rust-toolchain.toml`, including rustfmt, Clippy, and the standard-library documentation used by license generation.

Install Git 2.36+, Git LFS, Git's subtree command, and OpenSSH (`ssh-keygen`) for the integration suite. Tests create temporary repositories and local remotes; they do not need a hosted Git account.

- **macOS:** install Xcode Command Line Tools (`xcode-select --install`), Rust via rustup, and Git LFS (`brew install git-lfs`). A Homebrew Git installation includes subtree.
- **Ubuntu 24.04:** install `build-essential`, `git`, `git-lfs`, `openssh-client`, `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, and `patchelf`, then install Rust via rustup.
- **Windows:** install Git for Windows with its command-line tools on PATH, the MSVC Rust toolchain via rustup, Visual Studio C++ Build Tools with the Windows SDK, and WebView2. Git for Windows includes Git LFS, subtree, and OpenSSH; verify they are accessible in the shell used for tests.

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for native setup details. Run `git --version`, `git lfs version`, and `rustup show` to check the installed tools.

## Build and test

```sh
npm ci
npm run check:all
npm run build
npm run tauri build -- --no-bundle --ci -- --locked
```

`npm run check:all` checks TypeScript, version synchronization, notices, lint, formatting, frontend/tooling tests, IPC contracts, Rust formatting, Clippy, and Rust tests. It requires the native build prerequisites even when you are only editing the frontend. For focused work, use:

| Command                                                                                   | Purpose                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run check`                                                                           | TypeScript, versions, and committed notices                     |
| `npm run lint`                                                                            | TypeScript/JavaScript and React hook rules                      |
| `npm run format` / `npm run format:check`                                                 | Apply / verify frontend and documentation formatting            |
| `npm test`                                                                                | Frontend behavior, patch parsing, versioning, and notices tests |
| `npm run test:watch`                                                                      | Frontend tests in watch mode                                    |
| `npm run test:contracts`                                                                  | Real Rust serialization checked against TypeScript              |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml`                                | Rust unit and Git integration tests                             |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Strict Rust lint                                                |
| `npm audit --audit-level=low`                                                             | Audit all npm dependencies                                      |
| `cargo audit --file src-tauri/Cargo.lock`                                                 | Audit Rust dependencies (install cargo-audit 0.23.0 first)      |

Run checks and desktop builds locally on each platform you intend to support. The `--no-bundle` build above compiles the app without creating installers. See [releasing](releasing.md) for installer validation and the manual smoke checklist.

See [architecture](architecture.md) for code ownership boundaries, naming conventions, and the Git protocol invariants that tests protect.

## Versioning

`package.json` is the source of truth for the app's semantic version (`MAJOR.MINOR.PATCH`). The current version appears in the status bar and **Manual**.

```sh
npm run version:patch  # Bug fixes: 0.1.0 → 0.1.1
npm run version:minor  # New features: 0.1.0 → 0.2.0
npm run version:major  # Breaking changes: 0.1.0 → 1.0.0
```

Each command updates the npm manifest and lockfile, Tauri configuration, Rust manifest, and Diffinch's entry in the Cargo lockfile. Dependency versions stay unchanged. These commands leave the changes available for review without creating a Git commit or tag. For an explicit version or prerelease, use `npm version 0.2.0-beta.1 --no-git-tag-version`.

`npm run version:check` detects mismatched versions and also runs as part of `npm run check` and `npm run build`. If you edit the version in `package.json` directly, run `npm run version:sync` to update the other files. Run `npm run test:version` to verify the versioning workflow in temporary copies of the project.

## Stack

Tauri 2 provides the desktop shell and native folder picker. The interface uses React, TypeScript, Vite, and local SVG icons. Rust runs typed Git commands off the UI thread. System Git provides compatibility with the command-line index, configuration, signing, and credential tools.

## Third-party notices

`THIRD_PARTY_NOTICES.txt` contains the production npm dependencies, all locked Cargo dependencies across platforms (including build, optional, and test dependencies), and the Rust standard library's own copyright report. Some listed components are not present in every binary. The file includes original license/NOTICE texts and exact source archive links for MPL dependencies.

After changing dependencies or updating Rust:

```sh
npm ci
rustup component add rust-docs
npm run notices:generate
npm run test:notices
```

Generation uses `cargo metadata --locked` and may download sources for other platforms. Review and commit `THIRD_PARTY_NOTICES.txt`, `licenses/generated.json`, and any changed license supplements. Missing license files stop generation; add reviewed, version-specific upstream texts to `licenses/overrides.json` with their source URLs. Preserve upstream notices and check for licensing changes rather than just accepting a new version. If MPL source is modified, publish that corresponding source and update its notice instead of retaining the unmodified-source statement.

`npm run check` verifies the committed notices offline without needing every dependency's source cache. `npm run build` additionally checks the Rust toolchain version, so a release cannot silently reuse a previous standard library's notices. App-only version bumps do not invalidate notices.

Tauri copies the notices and Diffinch's `LICENSE` into each bundle's resource directory. Vite also embeds the notices as a local text asset for **About → Open-source licenses**, so the viewer works without a network connection. The native About menu and the titlebar About button open the same view, including when no repository is open.

The inventory covers the project's npm/Cargo dependencies and Rust standard library. When adding separately redistributed native runtimes, tools, fonts, or other assets, include their license/source obligations too. In particular, review the native libraries included by a Linux AppImage and any custom WebView runtime or installer additions when preparing those release formats.
