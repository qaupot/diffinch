<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Diffinch app icon" width="128" height="128" />
</p>

<h1 align="center">Diffinch</h1>

<p align="center">
  A desktop Git client with a macOS-inspired workspace for reviewing changes, staging patches, and writing commits.
</p>

Diffinch was built with AI-assisted development ("vibe coding").

## Run locally

Use the Node.js version in `.nvmrc` and the Rust toolchain in `rust-toolchain.toml` (installed automatically by rustup). Install Git 2.36 or later for NUL-delimited worktree listings. On macOS, install the Xcode Command Line Tools. For other platforms, follow the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run tauri dev
```

`npm run dev` opens a browser demo for interface development. Native repository operations require the desktop app. Git LFS, subtree, signing, and authentication use the corresponding system Git tools; see [development setup](doc/development.md) for test prerequisites.

The project is in early development. Use disposable repositories when evaluating new workflows and keep backups of valuable work. Each distributed package needs validation on its target platform.

## Documentation

- [Workspace](doc/workspace.md)
- [Git workflows](doc/git-workflows.md)
- [Submodules, subtrees, and Git LFS](doc/git-extensions.md)
- [Signing and authentication](doc/signing-and-authentication.md)
- [Development](doc/development.md)
- [Architecture and conventions](doc/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release checklist](doc/releasing.md)

## License

Diffinch is licensed under the [MIT License](LICENSE). Third-party copyright notices, license texts, and source availability information are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Releases include both files, and the notices are available offline from **About → Open-source licenses**.
