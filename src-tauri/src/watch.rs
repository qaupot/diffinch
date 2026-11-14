use crate::{
    git::{GitError, Repo, Result},
    worker,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[derive(Default)]
pub struct RepositoryWatches(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refresh {
    Working,
    Full,
    Unavailable,
}

fn classify(path: &Path, root: &Path, common: &Path, worktree: &Path) -> Option<Refresh> {
    if let Ok(path) = path.strip_prefix(worktree) {
        if matches!(path.to_str(), Some("index" | "index.lock")) {
            return Some(Refresh::Working);
        }
    }
    if let Some(relative) = path
        .strip_prefix(common)
        .ok()
        .or_else(|| path.strip_prefix(worktree).ok())
    {
        if relative.starts_with("objects") || relative.starts_with("logs/refs/remotes") {
            return None;
        }
        return Some(Refresh::Full);
    }
    path.strip_prefix(root).ok().map(|relative| {
        if relative.as_os_str().is_empty() || relative == Path::new(".git") {
            Refresh::Full
        } else {
            Refresh::Working
        }
    })
}

fn refresh_for(
    event: notify::Result<Event>,
    root: &Path,
    common: &Path,
    git_dir: &Path,
) -> Option<Refresh> {
    let Ok(event) = event else {
        return Some(Refresh::Unavailable);
    };
    if event.need_rescan() || event.paths.is_empty() {
        return Some(Refresh::Full);
    }
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    event
        .paths
        .iter()
        .filter_map(|path| classify(path, root, common, git_dir))
        .max()
}

#[tauri::command]
pub async fn watch_repository(
    app: AppHandle,
    path: String,
    id: String,
    changes: Channel<Refresh>,
) -> Result<()> {
    worker(move || {
        let repo = Repo::discover(path)?;
        let canonical = |path: PathBuf| {
            path.canonicalize()
                .map_err(|error| GitError::new("gitIoFailed", error))
        };
        let root = canonical(repo.root().to_path_buf())?;
        let common = canonical(repo.common_dir()?)?;
        let git_dir = canonical(repo.git_dir()?)?;
        let mut roots = vec![root.clone(), common.clone(), git_dir.clone()];
        roots.sort_by_key(|path| path.components().count());
        let callback = move |event| {
            if let Some(scope) = refresh_for(event, &root, &common, &git_dir) {
                let _ = changes.send(scope);
            }
        };
        let watch_error = |error: notify::Error| GitError::new("gitIoFailed", error);
        let mut watcher = notify::recommended_watcher(callback).map_err(watch_error)?;
        let mut watched: Vec<PathBuf> = Vec::new();
        for root in roots {
            if !watched.iter().any(|parent| root.starts_with(parent)) {
                watcher
                    .watch(&root, RecursiveMode::Recursive)
                    .map_err(watch_error)?;
                watched.push(root);
            }
        }
        app.state::<RepositoryWatches>()
            .0
            .lock()
            .map_err(|_| "workerLocked")?
            .insert(id, watcher);
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn unwatch_repository(watches: State<'_, RepositoryWatches>, id: String) -> Result<()> {
    let watcher = watches.0.lock().map_err(|_| "workerLocked")?.remove(&id);
    drop(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_linked_worktree_updates_separate_from_shared_ref_changes() {
        let root = Path::new("/feature");
        let common = Path::new("/project/.git");
        let git_dir = common.join("worktrees/feature");
        let scope = |path: &Path| classify(path, root, common, &git_dir);
        assert!(scope(&root.join("src/lib.rs")) == Some(Refresh::Working));
        assert!(scope(&git_dir.join("index")) == Some(Refresh::Working));
        assert!(scope(&git_dir.join("HEAD")) == Some(Refresh::Full));
        assert!(scope(&common.join("refs/heads/main")) == Some(Refresh::Full));
        assert!(scope(&common.join("objects/ab/123")).is_none());
    }
}
