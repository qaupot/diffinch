import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "diffinch-contracts-"));
try {
  const output = join(temporary, "responses.json");
  execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "git::contracts::export_contract_fixtures",
      "--",
      "--exact",
    ],
    {
      cwd: root,
      env: { ...process.env, DIFFINCH_CONTRACT_OUTPUT: output },
      stdio: "inherit",
    },
  );
  const responses = JSON.parse(readFileSync(output, "utf8"));
  const requests = JSON.parse(readFileSync(join(root, "tests/contracts/actions.json"), "utf8"));
  const actions = requests.filter(({ command }) => command === undefined);
  const accountRequests = requests.filter(({ command }) => command === "credential_account");
  const inspections = requests.filter(({ command }) => command === "inspect_file");
  const operations = requests.filter(({ command }) => command === "git_action");
  if (
    actions.length + accountRequests.length + inspections.length + operations.length !==
    requests.length
  ) {
    throw new Error("Unknown IPC request fixture");
  }
  const kinds = Object.fromEntries(actions.map(({ kind }) => [kind, true]));
  const toolKinds = Object.fromEntries(
    actions
      .filter(({ kind }) => kind === "repositoryTool")
      .map(({ action }) => [action.kind, true]),
  );
  const source = `
    import type * as Git from "./src/lib/git-types";
    import type * as Tools from "./src/lib/repository-tools";
    const actions = ${JSON.stringify(actions)} satisfies Git.Action[];
    const accountRequests = ${JSON.stringify(accountRequests.map(({ request }) => request))} satisfies Git.CredentialAccountRequest[];
    const inspections = ${JSON.stringify(inspections.map(({ request }) => request))} satisfies Git.FileInspectionRequest[];
    const inspectionKinds = ${JSON.stringify(Object.fromEntries(inspections.map(({ request }) => [request.kind, true])))} satisfies Record<Git.FileInspectionRequest["kind"], true>;
    const operations = ${JSON.stringify(operations.map(({ request }) => request))} satisfies Git.GitActionRequest[];
    const kinds = ${JSON.stringify(kinds)} satisfies Record<Git.Action["kind"], true>;
    const toolKinds = ${JSON.stringify(toolKinds)} satisfies Record<Tools.RepositoryToolAction["kind"], true>;
    ${Object.entries(responses)
      .map(([name, value], index) => {
        if (!/^[A-Za-z]+$/.test(name)) throw new Error("Invalid response fixture name");
        return `const response${index} = ${JSON.stringify(value)} satisfies Git.${name}${Array.isArray(value) ? "[]" : ""};`;
      })
      .join("\n")}
  `;
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const filename = join(root, "contract-check.ts");
  const host = ts.createCompilerHost(parsed.options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) =>
    resolve(path) === filename
      ? ts.createSourceFile(filename, source, languageVersion, true)
      : original(path, languageVersion, ...rest);
  const program = ts.createProgram([filename], parsed.options, host);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (path) => path,
        getNewLine: () => "\n",
      }),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `IPC contracts: ${requests.length} request examples and ${Object.keys(responses).length} Rust response types match TypeScript.`,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
