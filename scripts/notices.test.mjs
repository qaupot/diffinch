import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNotices, inputsHash, licenseFiles } from "./notices.mjs";
import { syncVersions } from "./version.mjs";

const project = new URL("../", import.meta.url);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "diffinch-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "scripts/notices.mjs",
    "licenses",
    "THIRD_PARTY_NOTICES.txt",
  ]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    cpSync(new URL(path, project), join(root, path), { recursive: true });
  }
  return {
    root,
    read: (path) => readFileSync(join(root, path), "utf8"),
    write: (path, contents) => writeFileSync(join(root, path), contents),
  };
}

test("committed notices pass without accessing Cargo, node_modules, or the network", (t) => {
  const f = fixture(t);
  const state = checkNotices(f.root);
  assert.equal(state.npmPackages, 5);
  assert.ok(state.cargoPackages > 400);
});

test("dependency and source changes invalidate notices", (t) => {
  const f = fixture(t);
  const expected = inputsHash(f.root);
  for (const path of [
    "package-lock.json",
    "package.json",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "licenses/texts/MIT.txt",
  ]) {
    const original = f.read(path);
    f.write(path, original.replace(/19\.2\.8|0\.22|Permission is hereby granted/, "999"));
    assert.notEqual(inputsHash(f.root), expected, path);
    assert.throws(() => checkNotices(f.root), /out of date/);
    f.write(path, original);
  }
});

test("an app-only version bump keeps notices valid", (t) => {
  const f = fixture(t);
  const pkg = JSON.parse(f.read("package.json"));
  pkg.version = "9.8.7";
  f.write("package.json", JSON.stringify(pkg));
  syncVersions(f.root);
  checkNotices(f.root);
});

test("truncated or edited notices fail the release check", (t) => {
  const f = fixture(t);
  f.write("THIRD_PARTY_NOTICES.txt", f.read("THIRD_PARTY_NOTICES.txt").slice(0, 2000));
  assert.throws(() => checkNotices(f.root), /out of date/);
});

test("collects nested legal texts without treating copying.rs as a license", (t) => {
  const root = mkdtempSync(join(tmpdir(), "diffinch-license-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "vendor/licenses"), { recursive: true });
  for (const path of ["LICENSE-MIT", "NOTICE.txt", "copying.rs", "vendor/licenses/BSD.txt"])
    writeFileSync(join(root, path), "fixture");
  assert.deepEqual(
    licenseFiles(root),
    ["LICENSE-MIT", "NOTICE.txt", "vendor/licenses/BSD.txt"].map((p) => join(root, p)),
  );
});
