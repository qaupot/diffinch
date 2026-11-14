import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = "THIRD_PARTY_NOTICES.txt";
const stateFile = "licenses/generated.json";
const read = (path) => readFileSync(path, "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (path) => JSON.parse(read(path));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
    });
}

export function inputsHash(root) {
  const npm = json(join(root, "package-lock.json"));
  // An app-only version bump does not change third-party notices.
  delete npm.version;
  delete npm.packages[""].version;
  const cargo = read(join(root, "src-tauri/Cargo.lock")).replace(
    /(name = "diffinch"\r?\n)version = "[^"]+"/,
    '$1version = "APP"',
  );
  const pkg = json(join(root, "package.json"));
  const dependencies = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies];
  const cargoManifest = read(join(root, "src-tauri/Cargo.toml")).replace(
    /(name = "diffinch"\r?\n)version = "[^"]+"/,
    '$1version = "APP"',
  );
  const supplements = filesUnder(join(root, "licenses"))
    .filter((path) => relative(root, path).replaceAll("\\", "/") !== stateFile)
    .map((path) => [relative(root, path).replaceAll("\\", "/"), hash(read(path))]);
  return hash(
    JSON.stringify({
      npm,
      cargo,
      dependencies,
      cargoManifest,
      supplements,
      generator: hash(read(join(root, "scripts/notices.mjs"))),
    }),
  );
}

function rustVersion() {
  const verbose = execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" });
  return verbose
    .split(/\r?\n/)
    .find((line) => line.startsWith("release: "))
    ?.slice(9);
}

export function checkNotices(root, toolchain = false) {
  const state = json(join(root, stateFile));
  if (
    state.inputsHash !== inputsHash(root) ||
    state.noticesHash !== hash(read(join(root, output)))
  ) {
    throw new Error(
      "Third-party notices are missing, edited, or out of date. Run npm run notices:generate and commit the notices and licenses/generated.json.",
    );
  }
  if (toolchain && state.rustVersion !== rustVersion()) {
    throw new Error(
      "The Rust toolchain changed. Run npm run notices:generate to refresh the standard library notices before building a release.",
    );
  }
  return state;
}

export function licenseFiles(root) {
  return filesUnder(root).filter((path) => {
    const parts = relative(root, path).split(/[\\/]/);
    const name = parts.at(-1);
    if (/\.(rs|c|h|cpp|js|ts|json|toml)$/i.test(name)) return false;
    return (
      /^(licen[cs]e|copying|notice|copyright|unlicense)(?:$|[._-])/i.test(name) ||
      parts.slice(0, -1).some((part) => /^(licenses|licences)$/i.test(part))
    );
  });
}

function htmlText(html) {
  // rust-docs ships the complete standard-library notices as static HTML.
  // Preserve preformatted text and external source links; never execute HTML.
  return html
    .replace(/<head>[\s\S]*?<\/head>/i, "")
    .replace(/<a\b[^>]*href="(https?:[^"<>]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(?:p|div|h[1-6]|li|pre|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(
      /&(?:amp|lt|gt|quot|apos);/g,
      (entity) =>
        ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity],
    )
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function generateNotices(root) {
  const npm = json(join(root, "package-lock.json"));
  const overrides = json(join(root, "licenses/overrides.json"));
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--manifest-path",
        join(root, "src-tauri/Cargo.toml"),
        "--format-version",
        "1",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const packages = [];
  for (const [path, locked] of Object.entries(npm.packages)) {
    if (!path || locked.dev) continue;
    const directory = join(root, path);
    const pkg = json(join(directory, "package.json"));
    if (pkg.version !== locked.version)
      throw new Error(`${path} does not match package-lock.json. Run npm ci.`);
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: locked.license,
      directory,
      source: locked.resolved,
      ecosystem: "npm",
    });
  }
  for (const pkg of metadata.packages) {
    if (pkg.id === metadata.resolve.root) continue;
    if (!pkg.source?.startsWith("registry+https://github.com/rust-lang/crates.io-index")) {
      throw new Error(`Review the source and license for ${pkg.name}: ${pkg.source}`);
    }
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      directory: dirname(pkg.manifest_path),
      licenseFile: pkg.license_file,
      source: `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
      ecosystem: "Cargo",
    });
  }
  packages.sort((a, b) =>
    compare(`${a.ecosystem}/${a.name}/${a.version}`, `${b.ecosystem}/${b.name}/${b.version}`),
  );
  const documents = new Map();
  const entries = [];
  const usedOverrides = new Set();
  function document(text) {
    const contents = text.replaceAll("\r\n", "\n").trim();
    if (!contents) throw new Error("An empty license or notice file was found.");
    const digest = hash(contents);
    if (!documents.has(digest)) documents.set(digest, { id: documents.size + 1, contents });
    return documents.get(digest).id;
  }
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!pkg.license)
      throw new Error(`No declared license for ${key}; review it before releasing.`);
    const files = licenseFiles(pkg.directory);
    if (pkg.licenseFile) {
      const path = resolve(pkg.directory, pkg.licenseFile);
      if (!files.includes(path)) files.push(path);
    }
    const references = files.map(
      (path) =>
        `${relative(pkg.directory, path).replaceAll("\\", "/")}: text ${document(read(path))}`,
    );
    for (const supplement of overrides[key] ?? []) {
      usedOverrides.add(key);
      references.push(
        `${supplement.source}: text ${document(read(join(root, "licenses", supplement.file)))}`,
      );
    }
    if (!references.length)
      throw new Error(
        `No license text for ${key}. Add a reviewed, version-specific entry to licenses/overrides.json.`,
      );
    const mpl = pkg.license.includes("MPL-2.0")
      ? "\nMPL source availability: the corresponding unmodified source is available at the Source URL above under MPL-2.0."
      : "";
    entries.push(
      `${pkg.name} ${pkg.version} (${pkg.ecosystem})\nLicense: ${pkg.license}\nSource: ${pkg.source}${mpl}\n${references.join("\n")}`,
    );
  }
  for (const key of Object.keys(overrides)) {
    if (!usedOverrides.has(key))
      throw new Error(`Remove or update the unused license override: ${key}`);
  }
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const rustCopyright = join(sysroot, "share/doc/rust/COPYRIGHT-library.html");
  if (!existsSync(rustCopyright))
    throw new Error(
      "Install rust-docs (rustup component add rust-docs) to collect the Rust standard library notices.",
    );
  const rust = rustVersion();
  const rustText = document(htmlText(read(rustCopyright)));
  const separator = "=".repeat(78);
  const text = `Diffinch — Third-party notices\n\nThis distribution includes software from the projects listed below.\nTheir respective licenses and copyright notices follow. Identical texts are\nshared by reference to a numbered text in the second part of this file.\n\nScope: production npm packages and all locked Cargo packages, including optional,\nplatform-specific, build and test dependencies. Not every listed component is\npresent in every binary. Rust standard library notices are included separately.\nGit is supplied by the user and is not bundled with Diffinch.\n\nWhere a package offers MIT as an alternative license (OR), Diffinch uses MIT.\nAll terms joined by AND still apply. Other supplied license texts are retained\nfor reference, including embedded third-party notices.\n\nMPL-2.0 source: the Source URL on each MPL entry provides the exact corresponding\nsource archive, available under MPL-2.0. These dependencies are used unmodified.\n\nGenerated by npm run notices:generate; do not edit this file directly.\n\n${separator}\nDEPENDENCIES\n${separator}\n\n${entries.join("\n\n")}\n\nRust standard library ${rust}\nSource: https://github.com/rust-lang/rust/tree/${rust}/library\nLicense and copyright notices: text ${rustText}\n\n${separator}\nLICENSE AND NOTICE TEXTS\n${separator}\n\n${[...documents.values()].map(({ id, contents }) => `${separator}\nTEXT ${id}\n${separator}\n\n${contents}`).join("\n\n")}\n`;
  const state = {
    inputsHash: inputsHash(root),
    noticesHash: hash(text),
    rustVersion: rust,
    npmPackages: packages.filter((p) => p.ecosystem === "npm").length,
    cargoPackages: packages.filter((p) => p.ecosystem === "Cargo").length,
  };
  writeFileSync(join(root, output), text);
  writeFileSync(join(root, stateFile), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const state = process.argv.includes("--check")
      ? checkNotices(project, process.argv.includes("--toolchain"))
      : generateNotices(project);
    console.log(
      `Third-party notices: ${state.npmPackages} npm packages, ${state.cargoPackages} Rust crates, Rust ${state.rustVersion}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
