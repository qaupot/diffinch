import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, useTranslation, type LocalizedMessage } from "./i18n";
import type { MessageKey } from "./i18n/messages";
import { ArrowDown, ArrowUpRight, FolderGit2, RefreshCw } from "./icons";
import { git, shortcut, type Action, type Snapshot } from "./lib/git";
import type {
  RepositoryToolAction,
  RepositoryToolKind,
  RepositoryToolState,
  Subtree,
  SubtreeOperation,
} from "./lib/repository-tools";

const subtreeLabels = {
  add: "addSubtree",
  pull: "pullSubtree",
  push: "pushSubtree",
  split: "splitSubtree",
} as const;
const emptyTree: Subtree = { prefix: "", remote: "", branch: "", squash: true };

export default function RepositoryTools({
  kind,
  repo,
  active,
  busy,
  revision,
  onAction,
  onOpen,
  onConfirmPush,
}: {
  kind: RepositoryToolKind;
  repo: Snapshot;
  active: boolean;
  busy: boolean;
  revision: number;
  onAction: (action: Action) => Promise<unknown>;
  onOpen: (path: string) => void;
  onConfirmPush: (
    action: RepositoryToolAction,
    prefix: string,
    remote: string,
    branch: string,
  ) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<RepositoryToolState | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [module, setModule] = useState({ url: "", path: "", branch: "" });
  const [tree, setTree] = useState<Subtree>(emptyTree);
  const [operation, setOperation] = useState<SubtreeOperation>("add");
  const [pattern, setPattern] = useState("");
  const [remote, setRemote] = useState(
    repo.remotes.find((item) => item.name === "origin")?.name ?? repo.remotes[0]?.name ?? "",
  );
  const selectedRemote = repo.remotes.some((item) => item.name === remote)
    ? remote
    : (repo.remotes[0]?.name ?? "");

  useEffect(() => {
    if (!active || busy || !repo.path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    git
      .repositoryTools(repo.path, kind)
      .then((state) => {
        if (!cancelled) setState(state);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, repo.path, active, busy, revision, reload]);

  const disabled = busy || loading || !!error || !!repo.operation;
  const run = (action: RepositoryToolAction) => {
    void onAction({ kind: "repositoryTool", action });
  };
  function submitTree(event: FormEvent) {
    event.preventDefault();
    const action: RepositoryToolAction = { kind: "subtree", operation, ...tree };
    if (operation === "push") onConfirmPush(action, tree.prefix, tree.remote, tree.branch);
    else run(action);
  }
  function input(
    label: MessageKey,
    value: string,
    onChange: (value: string) => void,
    placeholder = "",
    required = true,
  ) {
    return (
      <label className="tool-field">
        <span>{t(label)}</span>
        <input
          value={value}
          required={required}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  return (
    <section className="repository-tools" aria-label={t(kind)} aria-busy={loading || busy}>
      <div className="tool-intro">
        <p>
          {t(
            kind === "submodules"
              ? "submodulesHelp"
              : kind === "subtrees"
                ? "subtreesHelp"
                : "lfsHelp",
          )}
        </p>
        <button
          className="icon-button"
          title={t("refresh", { shortcut: `${shortcut}R` })}
          disabled={busy || loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {t(error.key, error.values)}
        </p>
      )}
      {loading && (
        <p className="muted" role="status">
          {t("working")}
        </p>
      )}
      {state?.kind === "submodules" && (
        <>
          <div className="tool-actions">
            <button
              className="plain-button"
              disabled={disabled || !state.items.length}
              onClick={() => run({ kind: "updateSubmodule", path: null, remote: false })}
            >
              <ArrowDown size={14} />
              {t("initializeSubmodules")}
            </button>
            <button
              className="plain-button"
              disabled={disabled || !state.items.length}
              onClick={() => run({ kind: "syncSubmodules" })}
            >
              {t("syncSubmodules")}
            </button>
          </div>
          <div className="tool-list">
            {state.items.map((item) => (
              <article className="tool-card" key={item.path}>
                <div className="tool-card-heading">
                  <FolderGit2 size={18} />
                  <strong>{item.path}</strong>
                  <span className="tool-badge">
                    {t(
                      item.conflict
                        ? "conflict"
                        : !item.head
                          ? "submoduleUninitialized"
                          : item.head !== item.expected
                            ? "submoduleChanged"
                            : "submoduleCurrent",
                    )}
                  </span>
                  {item.dirty && <span className="tool-badge">{t("submoduleDirty")}</span>}
                </div>
                <p className="tool-path">
                  {item.url}
                  {item.branch && ` · ${item.branch}`}
                </p>
                <p className="tool-path">
                  {t("submoduleRecorded")}: <code>{item.expected.slice(0, 12)}</code>
                  {item.head && (
                    <>
                      {" "}
                      · {t("submoduleCheckout")}: <code>{item.head.slice(0, 12)}</code>
                    </>
                  )}
                </p>
                <div className="tool-actions">
                  <button
                    className="plain-button"
                    disabled={disabled || !item.head}
                    onClick={() => onOpen(`${repo.path}/${item.path}`)}
                  >
                    <ArrowUpRight size={14} />
                    {t("openRepository")}
                  </button>
                  <button
                    className="plain-button"
                    disabled={disabled || item.conflict}
                    onClick={() => run({ kind: "updateSubmodule", path: item.path, remote: false })}
                  >
                    {t("updateSubmodule")}
                  </button>
                  <button
                    className="plain-button"
                    disabled={disabled || item.conflict}
                    onClick={() => run({ kind: "updateSubmodule", path: item.path, remote: true })}
                  >
                    {t("updateSubmoduleRemote")}
                  </button>
                </div>
              </article>
            ))}
            {!state.items.length && <p className="empty-list">{t("noSubmodules")}</p>}
          </div>
          <form
            className="tool-form"
            onSubmit={(event) => {
              event.preventDefault();
              run({ kind: "addSubmodule", ...module });
            }}
          >
            <h2>{t("addSubmodule")}</h2>
            <fieldset disabled={disabled}>
              {input(
                "repositoryUrl",
                module.url,
                (url) => setModule({ ...module, url }),
                "https://github.com/team/library.git",
              )}
              {input(
                "modulePath",
                module.path,
                (path) => setModule({ ...module, path }),
                "vendor/library",
              )}
              {input(
                "moduleBranch",
                module.branch,
                (branch) => setModule({ ...module, branch }),
                "main",
                false,
              )}
              <button className="primary-button" type="submit">
                {t("addSubmodule")}
              </button>
            </fieldset>
          </form>
        </>
      )}
      {state?.kind === "subtrees" && (
        <>
          {!state.available && (
            <p role="status" className="tool-error">
              {t("subtreeUnavailable")}
            </p>
          )}
          <div className="tool-list">
            {state.items.map((item) => (
              <button
                key={item.prefix}
                className="tool-card subtree-card"
                disabled={busy}
                onClick={() => {
                  setTree(item);
                  setOperation("pull");
                }}
              >
                <strong>{item.prefix}</strong>
                <span className="tool-path">
                  {item.remote ? `${item.remote} · ${item.branch}` : t("subtreeChooseRemote")}
                </span>
              </button>
            ))}
            {!state.items.length && <p className="empty-list">{t("noSubtrees")}</p>}
          </div>
          <form className="tool-form" onSubmit={submitTree}>
            <h2>{t("subtreeAction")}</h2>
            <fieldset disabled={disabled || !state.available}>
              <label className="tool-field">
                <span>{t("subtreeAction")}</span>
                <select
                  value={operation}
                  onChange={(event) => setOperation(event.target.value as SubtreeOperation)}
                >
                  {(Object.keys(subtreeLabels) as SubtreeOperation[]).map((value) => (
                    <option value={value} key={value}>
                      {t(subtreeLabels[value])}
                    </option>
                  ))}
                </select>
              </label>
              {input(
                "modulePath",
                tree.prefix,
                (prefix) => setTree({ ...tree, prefix }),
                "vendor/library",
              )}
              {operation !== "split" &&
                input(
                  "subtreeRemote",
                  tree.remote,
                  (remote) => setTree({ ...tree, remote }),
                  "origin",
                )}
              {input(
                operation === "split" ? "subtreeSplitBranch" : "subtreeRef",
                tree.branch,
                (branch) => setTree({ ...tree, branch }),
                "main",
              )}
              {(operation === "add" || operation === "pull") && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={tree.squash}
                    onChange={(event) => setTree({ ...tree, squash: event.target.checked })}
                  />
                  {t("subtreeSquash")}
                </label>
              )}
              <p className="tool-hint">
                {t(
                  operation === "push"
                    ? "subtreePushHelp"
                    : operation === "split"
                      ? "subtreeSplitHelp"
                      : "subtreeCommitHelp",
                )}
              </p>
              <button className="primary-button" type="submit">
                {t(subtreeLabels[operation])}
              </button>
            </fieldset>
          </form>
        </>
      )}
      {state?.kind === "lfs" && (
        <>
          {!state.available ? (
            <p className="tool-error" role="status">
              {t("lfsUnavailable")}
            </p>
          ) : (
            <>
              <p className="tool-path">{state.version}</p>
              <div className="tool-actions">
                <button
                  className="plain-button"
                  disabled={disabled}
                  onClick={() => run({ kind: "lfsInstall" })}
                >
                  {t("lfsInstall")}
                </button>
                <button
                  className="plain-button"
                  disabled={disabled}
                  onClick={() => run({ kind: "lfsTransfer", operation: "checkout", remote: "" })}
                >
                  {t("lfsCheckout")}
                </button>
              </div>
              <div className="tool-actions">
                <label className="tool-field">
                  <span>{t("remote")}</span>
                  <select
                    disabled={disabled || !repo.remotes.length}
                    value={selectedRemote}
                    onChange={(event) => setRemote(event.target.value)}
                  >
                    {repo.remotes.map(({ name }) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="plain-button"
                  disabled={disabled || !selectedRemote}
                  onClick={() =>
                    run({ kind: "lfsTransfer", operation: "fetch", remote: selectedRemote })
                  }
                >
                  {t("lfsFetch")}
                </button>
                <button
                  className="plain-button"
                  disabled={disabled || !selectedRemote}
                  onClick={() =>
                    run({ kind: "lfsTransfer", operation: "pull", remote: selectedRemote })
                  }
                >
                  {t("lfsPull")}
                </button>
              </div>
              <form
                className="tool-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  run({ kind: "lfsTrack", pattern, untrack: false });
                }}
              >
                <h2>{t("lfsPatterns")}</h2>
                <fieldset disabled={disabled}>
                  {input("lfsPattern", pattern, setPattern, "*.psd")}
                  <div className="tool-actions">
                    <button className="primary-button" type="submit">
                      {t("lfsTrack")}
                    </button>
                    <button
                      className="plain-button"
                      type="button"
                      disabled={!pattern.trim()}
                      onClick={() => run({ kind: "lfsTrack", pattern, untrack: true })}
                    >
                      {t("lfsUntrack")}
                    </button>
                  </div>
                  <p className="tool-hint">{t("lfsTrackHelp")}</p>
                </fieldset>
                <pre className="tool-patterns">{state.patterns || t("noLfsPatterns")}</pre>
              </form>
              <h2>{t("lfsFiles")}</h2>
              <div className="tool-list">
                {state.files.map((file) => (
                  <article className="tool-card" key={file.name}>
                    <div className="tool-card-heading">
                      <strong>{file.name}</strong>
                      <span className="tool-badge">
                        {t(
                          file.checkout
                            ? "lfsMaterialized"
                            : file.downloaded
                              ? "lfsCached"
                              : "lfsPointer",
                        )}
                      </span>
                    </div>
                    <p className="tool-path">
                      {file.size.toLocaleString()} B ·{" "}
                      <code title={file.oid}>{file.oid.slice(0, 12)}</code>
                    </p>
                  </article>
                ))}
                {!state.files.length && <p className="empty-list">{t("noLfsFiles")}</p>}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
