#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod preferences;
mod watch;
use git::{CredentialAccount, CredentialAccountRequest, CredentialTarget, CredentialUpdate};
use git::{ToolKind, ToolState};

use git::{
    AuthorPlan, Cancellation, CommitSearch, CommitSearchRequest, Comparison, Conflict, Diff,
    DiffOptions, DiscardPlan, GitError, HistoryPage, HistoryPageRequest, RebasePlan, RemoteRefKind,
    RemoteRefs, Repo, Result as CommandResult, Snapshot, Transfer, WorkingState,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, Weak},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct GitGates(Mutex<HashMap<PathBuf, Weak<GitGate>>>);

#[derive(Default)]
struct GitGate {
    running: Mutex<()>,
    waiters: Mutex<Vec<Weak<mpsc::Sender<()>>>>,
}

impl GitGate {
    fn run<T>(&self, run: impl FnOnce() -> CommandResult<T>) -> CommandResult<T> {
        struct WakeWaiters<'a>(&'a GitGate);
        impl Drop for WakeWaiters<'_> {
            fn drop(&mut self) {
                for waiter in self
                    .0
                    .waiters
                    .lock()
                    .unwrap()
                    .drain(..)
                    .filter_map(|weak| weak.upgrade())
                {
                    let _ = waiter.send(());
                }
            }
        }
        let (sender, wake) = mpsc::channel();
        let sender = Arc::new(sender);
        if let Some(cancel) = git::operation_cancellation() {
            cancel.wake_on_cancel(&sender);
        }
        let guard = loop {
            // Subscribe under the same mutex used to notify on release.
            let mut waiting = self.waiters.lock().map_err(|_| "workerLocked")?;
            git::check_operation()?;
            match self.running.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(_)) => return Err("workerLocked".into()),
                Err(std::sync::TryLockError::WouldBlock) => {
                    waiting.retain(|waiter| waiter.strong_count() > 0);
                    waiting.push(Arc::downgrade(&sender));
                }
            }
            drop(waiting);
            wake.recv().map_err(|_| "workerLocked")?;
        };
        let _notify = WakeWaiters(self);
        let _guard = guard; // Release the repository before waking its waiters, including on unwind.
        run()
    }
}

#[derive(Default)]
struct Transfers(Mutex<HashMap<String, Arc<Cancellation>>>);

async fn with_transfer<T>(
    app: &AppHandle,
    id: String,
    progress: Channel<u8>,
    run: impl AsyncFnOnce(Arc<Cancellation>, Channel<u8>) -> CommandResult<T>,
) -> CommandResult<T> {
    let state = app.state::<Transfers>();
    let cancelled = Arc::new(Cancellation::default());
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
            let gate = Arc::new(GitGate::default());
            gates.insert(key, Arc::downgrade(&gate));
            gate
        }
    };
    gate.run(run)
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
    cancelled: Arc<Cancellation>,
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
async fn history_page(
    app: AppHandle,
    path: String,
    request: HistoryPageRequest,
) -> CommandResult<HistoryPage> {
    repo_worker(app, path, move |repo| repo.history_page(request)).await
}

#[tauri::command]
async fn search_commits(
    app: AppHandle,
    path: String,
    request: CommitSearchRequest,
    progress: Channel<u8>,
) -> CommandResult<CommitSearch> {
    with_transfer(&app, request.id, progress, async |cancelled, progress| {
        controlled_repo_worker(app.clone(), path, cancelled, progress, move |repo| {
            repo.search_commits(&request.query, request.field, request.case_sensitive)
        })
        .await
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
        transfer.cancel();
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
            history_page,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn cancelled_waiter_leaves_an_occupied_repository_and_the_next_waiter_runs() {
        let gate = GitGate::default();
        let cancelled = Arc::new(Cancellation::default());
        let (entered, held) = mpsc::channel();
        let (release, released) = mpsc::channel();
        thread::scope(|scope| {
            let gate = &gate;
            let holder = scope.spawn(move || {
                gate.run(|| {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                })
            });
            held.recv().unwrap();
            let token = cancelled.clone();
            let (finished, result) = mpsc::channel();
            scope.spawn(move || {
                let status: CommandResult<()> = git::with_operation(
                    token,
                    |_| {},
                    || gate.run(|| panic!("cancelled waiter ran")),
                );
                finished.send(status).unwrap();
            });
            let start = std::time::Instant::now();
            while gate.waiters.lock().unwrap().is_empty() {
                assert!(start.elapsed() < Duration::from_secs(3));
                thread::yield_now();
            }
            cancelled.cancel();
            assert!(result
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .is_err_and(|err: GitError| {
                    serde_json::to_value(err).unwrap()["key"] == "operationInterrupted"
                }));
            let next = scope.spawn(|| gate.run(|| Ok(42)));
            release.send(()).unwrap();
            holder.join().unwrap().unwrap();
            assert_eq!(next.join().unwrap().unwrap(), 42);
        });
    }
}
