# Diffinch

Desktop Git client: React/TypeScript in `src/`, Tauri/Rust and system Git in `src-tauri/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands and [doc/architecture.md](doc/architecture.md) for conventions.

- Use `.nvmrc` and `rust-toolchain.toml`. Install with `npm ci`; launch with `npm run tauri dev`.
- Keep changes focused, follow existing patterns, and preserve user work.
- Put visible text in `src/i18n/` and update all supported locales.
- Add regression tests for behavior fixes. Test Git mutations in temporary repositories and preserve existing safety checks.
- For IPC changes, update Rust/TypeScript types and `tests/contracts/actions.json`; run `npm run test:contracts`.
- Run `npm run check` and `npm test`. For Rust changes, run `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
- Before a pull request, format changes and run `npm run check:all` and `npm run build`. Report validation results.
- Run `npm run notices:generate` after dependency, toolchain, or notices-generator changes. Bump versions only when requested, using the `version:patch`, `version:minor`, or `version:major` npm scripts.
