#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod preferences;
mod watch;
use git::{CredentialAccount, CredentialAccountRequest, CredentialTarget, CredentialUpdate};
use git::{ToolKind, ToolState};

use git::{
    AuthorPlan, CommitSearch, Comparison, Conflict, Diff, DiffOptions, DiscardPlan, GitError,
    RebasePlan, RemoteRefKind, RemoteRefs, Repo, Result as CommandResult, SearchField, Snapshot,
    Transfer, WorkingState,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct GitGates(Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>);

#[derive(Default)]
struct Transfers(Mutex<HashMap<String, Arc<AtomicBool>>>);

async fn with_transfer<T>(
    app: &AppHandle,
    id: String,
    progress: Channel<u8>,
    run: impl AsyncFnOnce(Arc<AtomicBool>, Channel<u8>) -> CommandResult<T>,
) -> CommandResult<T> {
    let state = app.state::<Transfers>();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.0.lock().map_err(|_| "workerLocked")?;
        if active.contains_key(&id) {
            return Err("workerLocked".into());
        }
        active.insert(id.clone(), cancelled.clone());
    }
    let _ = progress.send(0);
    let result = run(cancelled, progress).await;
    state.0.lock().map_err(|_| "workerLocked")?.remove(&id);
    result
}

fn with_gate<T>(
    app: &AppHandle,
    key: PathBuf,
    run: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
    let state = app.state::<GitGates>();
    let gate = {
        let mut gates = state.0.lock().map_err(|_| "workerLocked")?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
            gate
        } else {
            let gate = Arc::new(Mutex::new(()));
            gates.insert(key, Arc::downgrade(&gate));
            gate
        }
    };
    let _guard = loop {
        git::check_operation()?;
        match gate.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("workerLocked".into()),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(80))
            }
        }
    };
    run()
}

async fn worker<T: Send + 'static>(
    run: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|error| GitError::new("workerStopped", error))?
}

async fn repo_worker<T: Send + 'static>(
    app: AppHandle,
    path: String,
    run: impl FnOnce(Repo) -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    worker(move || {
        let repo = Repo::discover(path)?;
        let key = repo
            .common_dir()?
            .canonicalize()
            .map_err(|error| GitError::new("gitIoFailed", error))?;
        with_gate(&app, key, || run(repo))
    })
    .await
}

async fn controlled_repo_worker<T: Send + 'static>(
    app: AppHandle,
    path: String,
    cancelled: Arc<AtomicBool>,
    progress: Channel<u8>,
    run: impl FnOnce(Repo) -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    worker(move || {
        git::with_operation(
            cancelled,
            move |percent| {
                let _ = progress.send(percent);
            },
            || {
                let repo = Repo::discover(path)?;
                let key = repo
                    .common_dir()?
                    .canonicalize()
                    .map_err(|error| GitError::new("gitIoFailed", error))?;
                with_gate(&app, key, || run(repo))
            },
        )
    })
    .await
}

#[tauri::command]
async fn choose_folder(app: AppHandle, title: String) -> CommandResult<Option<String>> {
    let (sender, receiver) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(title)
        .pick_folder(move |selection| {
            let _ = sender.try_send(selection);
        });
    let mut receiver = receiver;
    receiver
        .recv()
        .await
        .flatten()
        .map(|folder| {
            let path = folder
                .into_path()
                .map_err(|error| GitError::new("gitOutput", error))?;
            path.into_os_string()
                .into_string()
                .map_err(|_| "folderPathEncoding".into())
        })
        .transpose()
}

#[tauri::command]
async fn snapshot(
    app: AppHandle,
    path: String,
    history_limit: Option<usize>,
    hidden_branches: Option<Vec<String>>,
) -> CommandResult<Snapshot> {
    repo_worker(app, path, move |repo| {
        repo.snapshot_with_branches(history_limit, &hidden_branches.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn search_commits(
    app: AppHandle,
    path: String,
    query: String,
    field: SearchField,
    case_sensitive: bool,
) -> CommandResult<CommitSearch> {
    repo_worker(app, path, move |repo| {
        repo.search_commits(&query, field, case_sensitive)
    })
    .await
}

#[tauri::command]
async fn working_state(app: AppHandle, path: String) -> CommandResult<WorkingState> {
    repo_worker(app, path, |repo| repo.working_state()).await
}

#[tauri::command]
async fn init_repository(app: AppHandle, path: String) -> CommandResult<Snapshot> {
    worker(move || {
        let path = Path::new(&path);
        if let Ok(repo) = Repo::discover(path) {
            let root = repo
                .root()
                .canonicalize()
                .map_err(|error| GitError::new("gitIoFailed", error))?;
            if path.canonicalize().ok().as_ref() == Some(&root) {
                let key = repo
                    .common_dir()?
                    .canonicalize()
                    .map_err(|error| GitError::new("gitIoFailed", error))?;
                return with_gate(&app, key, || Repo::init(path)?.snapshot());
            }
        }
        Repo::init(path)?.snapshot()
    })
    .await
}

#[tauri::command]
async fn clone_repository(
    app: AppHandle,
    url: String,
    parent: String,
    name: String,
    id: String,
    progress: Channel<u8>,
) -> CommandResult<Snapshot> {
    with_transfer(&app, id, progress, async move |cancelled, progress| {
        worker(move || {
            let report = |percent| {
                let _ = progress.send(percent);
            };
            let transfer = Transfer {
                cancelled: &cancelled,
                progress: &report,
            };
            Repo::clone(&url, Path::new(&parent), &name, Some(&transfer))?.snapshot()
        })
        .await
    })
    .await
}

#[tauri::command]
async fn fetch_repository(
    app: AppHandle,
    path: String,
    prune: bool,
    id: String,
    progress: Channel<u8>,
) -> CommandResult<&'static str> {
    with_transfer(&app, id, progress, async |cancelled, progress| {
        repo_worker(app.clone(), path, move |repo| {
            let report = |percent| {
                let _ = progress.send(percent);
            };
            repo.fetch(
                prune,
                Some(&Transfer {
                    cancelled: &cancelled,
                    progress: &report,
                }),
            )
        })
        .await
    })
    .await
}

#[tauri::command]
fn cancel_transfer(transfers: State<'_, Transfers>, id: String) -> CommandResult<()> {
    if let Some(transfer) = transfers.0.lock().map_err(|_| "workerLocked")?.get(&id) {
        transfer.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn file_diff(
    app: AppHandle,
    path: String,
    id: String,
    staged: bool,
    options: Option<DiffOptions>,
) -> CommandResult<Diff> {
    repo_worker(app, path, move |repo| {
        repo.file_diff(&id, staged, options.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn changes_diff(
    app: AppHandle,
    path: String,
    staged: bool,
    options: Option<DiffOptions>,
) -> CommandResult<Diff> {
    repo_worker(app, path, move |repo| {
        repo.working_diff(staged, options.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn commit_diff(
    app: AppHandle,
    path: String,
    id: String,
    options: Option<DiffOptions>,
) -> CommandResult<Diff> {
    repo_worker(app, path, move |repo| {
        repo.history_diff(&id, options.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn compare(
    app: AppHandle,
    path: String,
    base: String,
    target: String,
    from_merge_base: bool,
) -> CommandResult<Comparison> {
    repo_worker(app, path, move |repo| {
        repo.compare(&base, &target, from_merge_base)
    })
    .await
}

#[tauri::command]
async fn compare_file(
    app: AppHandle,
    path: String,
    base: String,
    target: String,
    id: String,
    options: DiffOptions,
) -> CommandResult<Diff> {
    repo_worker(app, path, move |repo| {
        repo.compare_file(&base, &target, &id, options)
    })
    .await
}

#[tauri::command]
async fn discard_plan(app: AppHandle, path: String, id: String) -> CommandResult<DiscardPlan> {
    repo_worker(app, path, move |repo| repo.discard_plan(&id)).await
}

#[tauri::command]
async fn conflict(app: AppHandle, path: String, id: String) -> CommandResult<Conflict> {
    repo_worker(app, path, move |repo| repo.conflict(&id)).await
}

#[tauri::command]
async fn commit_message(app: AppHandle, path: String, id: String) -> CommandResult<String> {
    repo_worker(app, path, move |repo| repo.commit_message(&id)).await
}

#[tauri::command]
async fn author_plan(app: AppHandle, path: String, id: String) -> CommandResult<AuthorPlan> {
    repo_worker(app, path, move |repo| repo.author_plan(&id)).await
}

#[tauri::command]
async fn rebase_plan(
    app: AppHandle,
    path: String,
    base: String,
    from_root: Option<bool>,
) -> CommandResult<RebasePlan> {
    repo_worker(app, path, move |repo| {
        repo.rebase_plan(&base, from_root.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn remote_refs(
    app: AppHandle,
    path: String,
    remote: String,
    kind: RemoteRefKind,
) -> CommandResult<RemoteRefs> {
    repo_worker(app, path, move |repo| repo.remote_refs(&remote, kind)).await
}

#[tauri::command]
async fn credential_targets(
    app: AppHandle,
    path: String,
    remote: String,
) -> CommandResult<Vec<CredentialTarget>> {
    repo_worker(app, path, move |repo| repo.credential_targets(&remote)).await
}

#[tauri::command]
async fn credential_account(
    app: AppHandle,
    path: String,
    request: CredentialAccountRequest,
) -> CommandResult<CredentialAccount> {
    repo_worker(app, path, move |repo| repo.credential_account(request)).await
}

#[tauri::command]
async fn update_credentials(
    app: AppHandle,
    path: String,
    update: CredentialUpdate,
) -> CommandResult<&'static str> {
    repo_worker(app, path, move |repo| repo.update_credentials(update)).await
}

#[tauri::command]
async fn inspect_file(
    app: AppHandle,
    path: String,
    request: git::FileInspectionRequest,
    id: String,
    progress: Channel<u8>,
) -> CommandResult<git::FileInspectionResult> {
    with_transfer(&app, id, progress, async |cancelled, progress| {
        controlled_repo_worker(app.clone(), path, cancelled, progress, move |repo| {
            repo.inspect_file(request)
        })
        .await
    })
    .await
}

#[tauri::command]
async fn git_action(
    app: AppHandle,
    path: String,
    request: git::GitActionRequest,
    progress: Channel<u8>,
) -> CommandResult<&'static str> {
    with_transfer(&app, request.id, progress, async |cancelled, progress| {
        controlled_repo_worker(app.clone(), path, cancelled, progress, move |repo| {
            repo.action(request.action)
        })
        .await
    })
    .await
}

#[tauri::command]
async fn repository_tools(
    app: AppHandle,
    path: String,
    kind: ToolKind,
) -> CommandResult<ToolState> {
    repo_worker(app, path, move |repo| repo.repository_tools(kind)).await
}

fn main() {
    tauri::Builder::default()
        .manage(GitGates::default())
        .manage(Transfers::default())
        .manage(watch::RepositoryWatches::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            if let Err(error) = preferences::initialize(app.handle()) {
                eprintln!("Could not load Diffinch preferences: {error}");
            }
            Ok(())
        })
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            // Tauri's default About item is first in the app menu on macOS,
            // and first in Help on Windows/Linux. Keep the other native items.
            #[cfg(target_os = "macos")]
            let parent = menu.items()?.into_iter().next();
            #[cfg(not(target_os = "macos"))]
            let parent = menu.get(tauri::menu::HELP_SUBMENU_ID);
            if let Some(tauri::menu::MenuItemKind::Submenu(parent)) = parent {
                parent.remove_at(0)?;
                parent.insert(
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "about-diffinch",
                        "About Diffinch",
                        true,
                        None::<&str>,
                    )?,
                    0,
                )?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about-diffinch" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("show-about", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            choose_folder,
            snapshot,
            search_commits,
            init_repository,
            clone_repository,
            fetch_repository,
            cancel_transfer,
            file_diff,
            changes_diff,
            commit_diff,
            commit_message,
            rebase_plan,
            author_plan,
            remote_refs,
            credential_targets,
            credential_account,
            update_credentials,
            git_action,
            inspect_file,
            repository_tools,
            working_state,
            compare,
            compare_file,
            conflict,
            discard_plan,
            watch::watch_repository,
            watch::unwatch_repository
        ])
        .run(tauri::generate_context!())
        .expect("Diffinch could not launch");
}
