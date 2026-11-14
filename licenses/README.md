# License supplements

Most texts are collected directly from the exact installed npm packages and Cargo source archives. `overrides.json` adds version-specific upstream texts for packages that omit them. Upstream URLs identify the source of each text; Cargo packages generally provide the original repository commit in `.cargo_vcs_info.json`.

`texts/MIT.txt` and `texts/MPL-2.0.txt` contain the standard license terms for packages whose published notices link to those terms without copying them. Original upstream notices are retained alongside these texts. For packages offering MIT as an alternative, Diffinch selects MIT; this does not remove additional licenses joined with AND or embedded third-party obligations.

`generated.json` records the input and output hashes and the Rust standard library version. It is generated, not edited manually. See [the development guide](../doc/development.md#third-party-notices) for regeneration and release checks.
