import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm owns package.json; its version lifecycle hook synchronizes native metadata.
export function syncVersions(root, check = false) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const version = JSON.parse(read("package.json")).version;
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const parsed = typeof version === "string" && version.match(semver);
  if (!parsed || parsed[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("package.json must contain a valid semantic version (for example, 0.1.0).");
  }

  const updates = [];
  const mismatches = [];
  const compare = (path, actual) => {
    if (actual !== version)
      mismatches.push(`${path}: ${actual ?? "missing"} (expected ${version})`);
  };

  for (const path of ["package-lock.json", "src-tauri/tauri.conf.json"]) {
    const contents = read(path);
    const json = JSON.parse(contents);
    compare(`${path} version`, json.version);
    json.version = version;
    if (path === "package-lock.json") {
      if (!json.packages?.[""]) throw new Error("package-lock.json is missing the root package.");
      compare(`${path} root package version`, json.packages[""].version);
      json.packages[""].version = version;
    }
    // Leave formatting alone when nothing changed.
    if (JSON.stringify(JSON.parse(contents)) !== JSON.stringify(json)) {
      updates.push([path, `${JSON.stringify(json, null, 2)}\n`]);
    }
  }

  for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const contents = read(path);
    let found = 0;
    const heading = path.endsWith(".toml") ? "[package]" : "[[package]]";
    const next = contents
      .split(/(?=^\[)/m)
      .map((block) => {
        if (!block.startsWith(heading)) return block;
        if (!/^name\s*=\s*"diffinch"\s*$/m.test(block)) return block;
        found++;
        const entry = /^(version\s*=\s*")([^"]+)(")/m;
        const match = block.match(entry);
        if (!match) throw new Error(`${path} is missing Diffinch's version.`);
        compare(path, match[2]);
        return block.replace(
          entry,
          (_, prefix, _previous, suffix) => `${prefix}${version}${suffix}`,
        );
      })
      .join("");
    if (found !== 1) throw new Error(`${path} must contain exactly one Diffinch package.`);
    if (next !== contents) updates.push([path, next]);
  }

  // Parse and validate every file before writing any of them.
  if (check && mismatches.length) {
    throw new Error(
      `Version mismatch:\n${mismatches.join("\n")}\nRun npm run version:sync to synchronize with package.json.`,
    );
  }
  if (!check) for (const [path, contents] of updates) writeFileSync(resolve(root, path), contents);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
      throw new Error("Usage: node scripts/version.mjs [--check]");
    }
    const check = args[0] === "--check";
    const version = syncVersions(fileURLToPath(new URL("../", import.meta.url)), check);
    console.log(`Diffinch ${version}: versions ${check ? "match" : "synchronized"}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
