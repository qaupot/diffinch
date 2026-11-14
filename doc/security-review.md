# Dependency review notes

Reviewed on 2026-11-15 against the committed lockfiles. Recheck current advisories manually before releases; this document is a record of decisions, not a substitute for the live scans.

## npm

The lockfile uses a package override for `minimatch` 11.0.8 because the TypeScript ESLint dependency chain otherwise resolves a version affected by [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Frontend linting and tests exercise the override. The complete npm dependency audit reports no vulnerabilities after the override. Remove it when upstream resolves a safe version without it.

## GTK advisory release decision

**Neither advisory blocks making this source repository public.** They also do not affect the resolved macOS or Windows dependency graphs. For Linux, the current locked graph has no identified call to the affected GLib API, and the unmaintained dependency is confined to build-time macros. These two warnings are treated as non-blocking residual risks for this reviewed dependency set, subject to the checks below. This is an assessment of these advisories, not approval of an otherwise untested Linux package; local checks and package smoke checks still apply.

The 2026-11-15 audit reports zero vulnerability-class advisories and the following two informational warnings. GLib's “unsound” classification describes a real memory-safety defect; informational does not mean harmless.

| Advisory                                                                   | Finding                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | `glib` 0.18.5 passes an immutable pointer reference to a C function that writes through it in `VariantStrIter::impl_get`. Iterating can cause undefined behavior and release-build crashes. | No identified caller in Diffinch or its resolved Linux dependencies. Keep visible and prevent new usage until the GTK stack can be upgraded. The defect itself remains in the dependency.                                                                |
| [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | `proc-macro-error` 1.0.4 is unmaintained; the advisory reports no specific runtime exploit and lists no patched version.                                                                    | Its only immediate consumers are the `glib-macros` 0.18.5 and `gtk3-macros` 0.18.2 procedural-macro crates, which execute while compiling. This remains a build-tool maintenance/supply-chain risk, not a demonstrated vulnerability in the running app. |

### What was checked

The review used `cargo metadata --locked --features custom-protocol --filter-platform` for x86_64 and ARM64 Linux, macOS, and Windows, including the release protocol feature. After adding Tauri Store 2.5.1, both Linux graphs resolve 303 packages, both macOS graphs resolve 257, and both Windows graphs resolve 255. Neither macOS nor Windows includes `glib` or `proc-macro-error`. These are dependency-resolution checks, not cross-platform build results. The repeated cargo-audit scan reports the same two informational warnings and no vulnerability-class advisories; the npm audit reports no vulnerabilities.

All Rust source files in both resolved Linux graphs were searched for `VariantStrIter` and `array_iter_str` (17,278 file checks across the two graphs, including shared files twice). Matches occurred only in three GLib files:

- `src/lib.rs`: the public re-export.
- `src/variant.rs`: the import, `Variant::array_iter_str` definition, documentation example, and tests.
- `src/variant_iter.rs`: the type/iterator implementation and tests.

Manual inspection confirmed the iterator's fields are private, its constructor is `pub(crate)`, and the only production call to that constructor is `Variant::array_iter_str`. No other resolved package or Diffinch source references the type or factory. The general `Variant::iter` API uses a different iterator. Source searching is not a formal call-graph proof: generated code, unsafe construction, future feature changes, and unreviewed dependency versions must not inherit this conclusion automatically.

### Fix availability

The upstream GLib fix is [gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), recognized by RustSec in `glib >=0.20.0`. The 0.18 backport proposal [#2009](https://github.com/gtk-rs/gtk-rs-core/pull/2009) was closed without merging, and [the maintainer declined another 0.18 release](https://github.com/tauri-apps/tauri/issues/12564). The published 0.18 series still ends at 0.18.5.

GTK 3 bindings are **no longer universally abandoned**: [GTK 0.19.0 was released on 2026-09-08](https://github.com/gtk-rs/gtk3-rs/releases/tag/0.19.0) and uses GLib 0.22. However, the currently published Tauri 2.12.5, tauri-runtime 2.12.2, tauri-runtime-wry 2.12.3, Tao 0.37.2, and WebKitGTK 2.0.2 still require GTK/GLib 0.18. The current Wry 0.57.2 also retains that requirement. A routine compatible dependency update therefore removes neither warning.

Adding a new top-level GLib dependency would retain the old transitive copy. Forcing GTK 0.19 or GLib 0.22 across the old API requirements would require coordinated upstream changes. A private backport could repair the GLib function, but would create a locally maintained fork of an end-of-life GLib series and need native Linux validation; it would not resolve the macro crate's maintenance warning. This review keeps the registry dependencies unchanged rather than introducing that additional maintenance obligation for an API with no identified caller. Replace the old stack when Tauri and WebKitGTK offer a compatible maintained dependency path.

### Manual checks and re-review

There are no `cargo-audit` ignores. Review the complete audit output, including informational warnings. Any new advisory, changed dependency, expansion to macOS/Windows, new macro consumer, or new source reference to the affected GLib API requires a fresh review. If a warning disappears, remove or update its disposition here.

To repeat the check with cargo-audit 0.23.0 installed:

```sh
cargo audit --file src-tauri/Cargo.lock
```

Repeat the platform dependency and source checks described above when the locked dependencies change. Cargo metadata may download locked source packages for other platforms; no Linux compiler or GTK installation is needed for this source review. Include references in dependency tests and comments when reviewing new uses of the affected API.

When dependencies change, repeat the advisory, upgrade-path, platform, and source review and update this explanation with the findings. If the iterator becomes reachable, withdraw the Linux non-blocking disposition until the call is removed or a tested fix is in use. An app-only version bump does not change the reviewed dependency set.

## Secrets and artifacts

Run Gitleaks manually on all available Git history and the checked-out tree before releases, with redacted output. Include uncommitted files intended for publication. Ignore rules exclude local environment files, editor state, dependency directories, and build output from source control. If a real credential is found, revoke it before rewriting history; deleting its current file does not remove it from history.
