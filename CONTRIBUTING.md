# Contributing to Diffinch

Bug reports, focused fixes, tests, documentation, and translations are welcome. For a substantial feature or architecture change, describe the workflow in an issue before starting a large implementation. Keep discussion respectful, specific, and focused on the work.

## Set up

Use Node from `.nvmrc`, the Rust toolchain in `rust-toolchain.toml`, Git 2.36 or newer, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). The integration tests also require Git LFS, Git's subtree command, and OpenSSH's `ssh-keygen`. On macOS, install the Xcode Command Line Tools and Git LFS; on Linux and Windows, see [development setup](doc/development.md).

```sh
npm ci
npm run tauri dev
```

`npm run dev` starts the browser demo without the desktop shell. It is useful for layout work; native Git behavior must be checked in Tauri.

## Make a change

Keep one logical change per pull request. Follow the [architecture and conventions](doc/architecture.md), use existing translations for visible text, and add a regression test when fixing behavior. Tests that mutate Git state must use temporary repositories, never a contributor's checkout or real remote. Do not include credentials, personal paths, private repository data, editor settings, or build outputs.

Before submitting:

```sh
npm run format
cargo fmt --manifest-path src-tauri/Cargo.toml
npm run check:all
npm run build
```

For changes to dependencies, the Rust toolchain, or the notices generator, run `npm run notices:generate` after formatting and review the generated license inventory. Update both lockfiles when their dependencies change. `package.json` overrides the transitive `minimatch` version to a patched release; remove that override only after the parent packages resolve a safe version and the audit passes.

Changes to IPC actions or responses must update both Rust and TypeScript types and the [contract fixtures](tests/contracts/actions.json). `npm run test:contracts` deserializes requests in Rust and checks real serialized responses against TypeScript. Keep non-null and optional-field examples when expanding the fixtures.

Describe the concrete problem, resulting behavior, and validation in your pull request. Include screenshots for visual changes and list the platforms checked locally. Maintainers handle version bumps when preparing releases.

Cargo dependency changes require repeating the [GTK advisory review](doc/security-review.md) and updating its findings.

## Report problems

Include reproduction steps, app/OS/Git versions, and sanitized output in bug reports. Report security issues through [SECURITY.md](SECURITY.md), rather than a public issue containing exploit details.

By submitting a contribution, you agree to license it under the project's [MIT License](LICENSE). Only contribute work you have the right to share; preserve attribution for third-party material.
