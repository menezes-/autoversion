//! Config-related IPC commands.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::config::{self, Config, WatchedFolder, WatchedFolderPatch};
use crate::error::AppError;
use crate::events::ConfigChangedPayload;
use crate::ignore;
use crate::ignore::{compile_globset, extension_allowed, glob_matches, try_relative};
use crate::notify_watcher_reload;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredPath {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMatchPreview {
    pub matched: Vec<String>,
    pub ignored: Vec<IgnoredPath>,
}

fn emit_config_changed(app: &AppHandle) {
    let _ = app.emit("config-changed", ConfigChangedPayload {});
}

#[tauri::command]
pub async fn get_config(state: State<'_, Arc<Mutex<Config>>>) -> Result<Config, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn set_config(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    config: Config,
) -> Result<(), AppError> {
    config::save_config_to_disk(&config)?;
    {
        let mut g = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        *g = config;
    }
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(())
}

#[tauri::command]
pub async fn add_watched_folder(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    path: String,
    extensions: Vec<String>,
) -> Result<WatchedFolder, AppError> {
    let path_buf = PathBuf::from(path);
    let canonical = path_buf
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("could not resolve folder path: {e}")))?;

    let id = config::stable_folder_id(&canonical);
    let normalized_ext: Vec<String> = extensions
        .into_iter()
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let folder = WatchedFolder {
        id,
        path: canonical,
        extensions: normalized_ext,
        user_ignore_patterns: vec![],
        enabled: true,
    };

    {
        let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        if cfg.watched_folders.iter().any(|f| f.id == folder.id) {
            return Err(AppError::BadRequest(
                "this folder is already being watched".to_string(),
            ));
        }
        cfg.watched_folders.push(folder.clone());
        config::save_config_to_disk(&cfg)?;
    }
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(folder)
}

#[tauri::command]
pub async fn update_watched_folder(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    id: String,
    patch: WatchedFolderPatch,
) -> Result<WatchedFolder, AppError> {
    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let pos = cfg
        .watched_folders
        .iter()
        .position(|f| f.id == id)
        .ok_or_else(|| AppError::NotFound(format!("folder id {id}")))?;

    if let Some(p) = patch.path {
        let canonical = p
            .canonicalize()
            .map_err(|e| AppError::BadRequest(format!("could not resolve folder path: {e}")))?;
        let new_id = config::stable_folder_id(&canonical);
        if new_id != cfg.watched_folders[pos].id
            && cfg.watched_folders.iter().any(|f| f.id == new_id)
        {
            return Err(AppError::BadRequest(
                "another watched folder already uses this path".to_string(),
            ));
        }
        cfg.watched_folders[pos].path = canonical;
        cfg.watched_folders[pos].id = new_id;
    }
    if let Some(ext) = patch.extensions {
        cfg.watched_folders[pos].extensions = ext
            .into_iter()
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
    }
    if let Some(ign) = patch.user_ignore_patterns {
        cfg.watched_folders[pos].user_ignore_patterns = ign;
    }
    if let Some(en) = patch.enabled {
        cfg.watched_folders[pos].enabled = en;
    }

    let updated = cfg.watched_folders[pos].clone();
    config::save_config_to_disk(&cfg)?;
    drop(cfg);
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(updated)
}

#[tauri::command]
pub async fn remove_watched_folder(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    id: String,
) -> Result<(), AppError> {
    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let before = cfg.watched_folders.len();
    cfg.watched_folders.retain(|f| f.id != id);
    if cfg.watched_folders.len() == before {
        return Err(AppError::NotFound(format!("folder id {id}")));
    }
    config::save_config_to_disk(&cfg)?;
    drop(cfg);
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(())
}

fn walk_dir_files(
    root: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), AppError> {
    let read = std::fs::read_dir(root)?;
    for e in read {
        let e = e?;
        let p = e.path();
        let meta = e.metadata()?;
        if meta.is_dir() {
            walk_dir_files(&p, out)?;
        } else if meta.is_file() {
            out.push(p);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_folder_matches(
    state: State<'_, Arc<Mutex<Config>>>,
    id: String,
) -> Result<FolderMatchPreview, AppError> {
    let folder = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        cfg.watched_folders
            .iter()
            .find(|f| f.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("folder id {id}")))?
    };

    let patterns = ignore::patterns_for_folder(&folder);
    let globset = compile_globset(&patterns)?;

    let mut all_files = vec![];
    walk_dir_files(&folder.path, &mut all_files)?;

    let mut matched = vec![];
    let mut ignored = vec![];

    for abs in all_files {
        let Some(rel) = try_relative(&folder.path, &abs) else {
            continue;
        };
        if !extension_allowed(&abs, &folder) {
            ignored.push(IgnoredPath {
                path: rel.to_string_lossy().to_string(),
                reason: "extension not included for this folder".to_string(),
            });
            continue;
        }
        if glob_matches(&globset, &rel) {
            ignored.push(IgnoredPath {
                path: rel.to_string_lossy().to_string(),
                reason: "matched ignore pattern".to_string(),
            });
            continue;
        }
        matched.push(rel.to_string_lossy().replace('\\', "/"));
    }

    matched.sort();
    Ok(FolderMatchPreview { matched, ignored })
}
