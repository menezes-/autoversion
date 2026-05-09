//! Mutating actions (restore, manual snapshot, pause).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::config::{self, Config};
use crate::error::AppError;
use crate::events::RestoreCompletedPayload;
use crate::notify_watcher_reload;
use crate::storage;

fn folder_by_id<'a>(
    cfg: &'a Config,
    id: &str,
) -> Result<&'a crate::config::WatchedFolder, AppError> {
    cfg.watched_folders
        .iter()
        .find(|f| f.id == id)
        .ok_or_else(|| AppError::NotFound(format!("folder id {id}")))
}

#[tauri::command]
pub async fn restore_snapshot(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    commit_sha: String,
    relative_path: String,
) -> Result<(), AppError> {
    let folder = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        folder_by_id(&cfg, &folder_id)?.clone()
    };

    let abs = folder.path.join(&relative_path);
    let _ = storage::snapshot_current_if_exists(&app, &folder, &abs)?;

    let bytes = storage::read_blob_at_commit(&folder_id, &commit_sha, &relative_path)?;
    storage::write_bytes_to_disk(&abs, &bytes)?;

    let _ = app.emit(
        "restore-completed",
        RestoreCompletedPayload {
            folder_id: folder_id.clone(),
            relative_path: relative_path.clone(),
            restored_from_sha: commit_sha,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn trigger_manual_snapshot(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    relative_path: String,
) -> Result<(), AppError> {
    let folder = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        folder_by_id(&cfg, &folder_id)?.clone()
    };
    let abs = folder.path.join(&relative_path);
    let _ = storage::snapshot_watched_file(&app, &folder, &abs)?;
    Ok(())
}

#[tauri::command]
pub async fn pause_watching(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
) -> Result<(), AppError> {
    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    cfg.watching_paused = true;
    config::save_config_to_disk(&cfg)?;
    drop(cfg);
    notify_watcher_reload(&app);
    Ok(())
}

#[tauri::command]
pub async fn resume_watching(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
) -> Result<(), AppError> {
    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    cfg.watching_paused = false;
    config::save_config_to_disk(&cfg)?;
    drop(cfg);
    notify_watcher_reload(&app);
    Ok(())
}

#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> Result<(), AppError> {
    let p = PathBuf::from(path);
    app.opener()
        .reveal_item_in_dir(&p)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Open a file in the OS default application (macOS `open` equivalent).
#[tauri::command]
pub async fn open_path(app: AppHandle, path: String) -> Result<(), AppError> {
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::NotFound(path));
    }
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Open a file inside a watched folder by `(folder_id, relative_path)`.
#[tauri::command]
pub async fn open_watched_file(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    relative_path: String,
) -> Result<(), AppError> {
    let abs = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        let folder = folder_by_id(&cfg, &folder_id)?;
        folder.path.join(&relative_path)
    };
    if !abs.exists() {
        return Err(AppError::NotFound(abs.display().to_string()));
    }
    app.opener()
        .open_path(abs.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}
