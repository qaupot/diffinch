import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncVersions } from "./version.mjs";

const project = new URL("../", import.meta.url);
const files = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "diffinch-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src-tauri"));
  mkdirSync(join(root, "scripts"));
  for (const path of [...files, "scripts/version.mjs"])
    copyFileSync(new URL(path, project), join(root, path));
  const read = (path) => readFileSync(join(root, path), "utf8");
  const write = (path, contents) => writeFileSync(join(root, path), contents);
  const snapshot = () => files.map((path) => read(path));
  const setVersion = (version) => {
    const pkg = JSON.parse(read("package.json"));
    pkg.version = version;
    write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  };
  return { root, read, write, snapshot, setVersion };
}

test("checking synchronized versions leaves every file unchanged", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  assert.equal(syncVersions(f.root, true), JSON.parse(f.read("package.json")).version);
  syncVersions(f.root);
  assert.deepEqual(f.snapshot(), before);
});

test("drift is reported without writes, then sync updates only app metadata", (t) => {
  const f = fixture(t);
  const previous = JSON.parse(f.read("package.json")).version;
  const lock = JSON.parse(f.read("package-lock.json"));
  const cargo = f.read("src-tauri/Cargo.toml");
  const cargoLock = f.read("src-tauri/Cargo.lock");
  const tauri = JSON.parse(f.read("src-tauri/tauri.conf.json"));
  f.setVersion("2.3.4-beta.1+build.7");
  const before = f.snapshot();
  assert.throws(
    () => syncVersions(f.root, true),
    (error) => {
      for (const path of files.slice(1)) assert.ok(error.message.includes(path));
      return true;
    },
  );
  assert.deepEqual(f.snapshot(), before);
  syncVersions(f.root);
  assert.equal(syncVersions(f.root, true), "2.3.4-beta.1+build.7");
  lock.version = lock.packages[""].version = "2.3.4-beta.1+build.7";
  tauri.version = "2.3.4-beta.1+build.7";
  assert.deepEqual(JSON.parse(f.read("package-lock.json")), lock);
  assert.deepEqual(JSON.parse(f.read("src-tauri/tauri.conf.json")), tauri);
  for (const [path, original] of [
    ["src-tauri/Cargo.toml", cargo],
    ["src-tauri/Cargo.lock", cargoLock],
  ]) {
    assert.equal(
      f.read(path),
      original.replace(
        `name = "diffinch"\nversion = "${previous}"`,
        'name = "diffinch"\nversion = "2.3.4-beta.1+build.7"',
      ),
    );
  }
});

test("invalid canonical versions are rejected without writes", (t) => {
  const f = fixture(t);
  for (const version of ["1.2", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3\n", null]) {
    f.setVersion(version);
    const before = f.snapshot();
    assert.throws(() => syncVersions(f.root), /valid semantic version/);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("malformed native metadata fails before any file is written", (t) => {
  const f = fixture(t);
  f.setVersion("2.3.4");
  f.write(
    "src-tauri/Cargo.lock",
    f.read("src-tauri/Cargo.lock").replace('name = "diffinch"', 'name = "another-app"'),
  );
  const before = f.snapshot();
  assert.throws(() => syncVersions(f.root), /exactly one Diffinch package/);
  assert.deepEqual(f.snapshot(), before);
});

test("each mirrored version is independently checked", (t) => {
  const f = fixture(t);
  const original = f.snapshot();
  for (const path of files.slice(1)) {
    if (path.endsWith(".json")) {
      const json = JSON.parse(f.read(path));
      json.version = "9.8.7";
      f.write(path, JSON.stringify(json));
    } else {
      f.write(path, f.read(path).replace(/(name = "diffinch"\nversion = ")[^"]+/, "$19.8.7"));
    }
    assert.throws(() => syncVersions(f.root, true), /Version mismatch/);
    files.forEach((file, i) => f.write(file, original[i]));
  }
  const lock = JSON.parse(f.read("package-lock.json"));
  lock.packages[""].version = "9.8.7";
  f.write("package-lock.json", JSON.stringify(lock));
  assert.throws(() => syncVersions(f.root, true), /root package version/);
});

test("npm release commands synchronize metadata without creating Git history", (t) => {
  const f = fixture(t);
  f.setVersion("0.1.0");
  syncVersions(f.root);
  assert.ok(process.env.npm_execpath, "Run with npm run test:version so the npm CLI is available.");
  for (const [release, expected] of [
    ["patch", "0.1.1"],
    ["minor", "0.2.0"],
    ["major", "1.0.0"],
  ]) {
    execFileSync(process.execPath, [process.env.npm_execpath, "run", `version:${release}`], {
      cwd: f.root,
      stdio: "pipe",
    });
    assert.equal(syncVersions(f.root, true), expected);
  }
  execFileSync(
    process.execPath,
    [process.env.npm_execpath, "version", "1.1.0-beta.1", "--no-git-tag-version"],
    { cwd: f.root, stdio: "pipe" },
  );
  assert.equal(syncVersions(f.root, true), "1.1.0-beta.1");
});
