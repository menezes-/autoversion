//! Config-related IPC commands.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::autostart::reconcile_autostart;
use crate::config::{self, Config, WatchedFolder, WatchedFolderPatch};
use crate::error::AppError;
use crate::events::ConfigChangedPayload;
use crate::ignore;
use crate::ignore::{compile_globset, extension_allowed, glob_matches, try_relative};
use crate::notify_watcher_reload;
use crate::storage;

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
        *g = config.clone();
    }
    reconcile_autostart(app.clone(), config.start_at_login)?;
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
        snapshot_root_override: None,
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
    if let Some(root) = patch.snapshot_root_override {
        let canonical = root
            .canonicalize()
            .map_err(|e| AppError::BadRequest(format!("could not resolve snapshot root: {e}")))?;
        cfg.watched_folders[pos].snapshot_root_override = Some(canonical);
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

fn canonical_parent_dir(s: &str) -> Result<PathBuf, AppError> {
    let p = PathBuf::from(s);
    p.canonicalize()
        .map_err(|e| AppError::BadRequest(format!("could not resolve directory: {e}")))
}

/// Canonical path to the built-in default snapshot parent (`…/AutoVersion/repos`).
#[tauri::command]
pub async fn get_system_snapshot_parent() -> Result<String, AppError> {
    Ok(storage::system_repos_base()?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn set_folder_snapshot_root(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    new_root: Option<String>,
    move_existing: bool,
) -> Result<WatchedFolder, AppError> {
    let new_override = match new_root {
        None => None,
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(canonical_parent_dir(&s)?),
    };

    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let pos = cfg
        .watched_folders
        .iter()
        .position(|f| f.id == folder_id)
        .ok_or_else(|| AppError::NotFound(format!("folder id {folder_id}")))?;

    let folder = cfg.watched_folders[pos].clone();
    let old_path = storage::resolve_repo_path(&cfg, &folder)?;

    let mut patched = folder.clone();
    patched.snapshot_root_override = new_override.clone();
    let new_path = storage::resolve_repo_path(&cfg, &patched)?;

    if old_path == new_path {
        cfg.watched_folders[pos].snapshot_root_override = new_override;
        config::save_config_to_disk(&cfg)?;
        let updated = cfg.watched_folders[pos].clone();
        drop(cfg);
        emit_config_changed(&app);
        notify_watcher_reload(&app);
        return Ok(updated);
    }

    if new_path.exists() {
        return Err(AppError::BadRequest(format!(
            "snapshot destination already exists: {}",
            new_path.display()
        )));
    }

    if move_existing && old_path.exists() {
        storage::move_repo_dir(&old_path, &new_path)?;
    }

    cfg.watched_folders[pos].snapshot_root_override = new_override;
    config::save_config_to_disk(&cfg)?;
    let updated = cfg.watched_folders[pos].clone();
    drop(cfg);
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(updated)
}

#[tauri::command]
pub async fn set_default_snapshot_root(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Config>>>,
    new_root: Option<String>,
    move_existing: bool,
) -> Result<(), AppError> {
    let new_default = match new_root {
        None => None,
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(canonical_parent_dir(&s)?),
    };

    let mut cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;

    let mut pending = cfg.clone();
    pending.default_snapshot_root = new_default.clone();

    for f in &cfg.watched_folders {
        if f.snapshot_root_override.is_some() {
            continue;
        }
        let old_path = storage::resolve_repo_path(&cfg, f)?;
        let new_path = storage::resolve_repo_path(&pending, f)?;
        if old_path == new_path {
            continue;
        }
        if new_path.exists() {
            return Err(AppError::BadRequest(format!(
                "snapshot destination already exists for folder {}: {}",
                f.id,
                new_path.display()
            )));
        }
    }

    for f in &cfg.watched_folders {
        if f.snapshot_root_override.is_some() {
            continue;
        }
        let old_path = storage::resolve_repo_path(&cfg, f)?;
        let new_path = storage::resolve_repo_path(&pending, f)?;
        if old_path == new_path {
            continue;
        }
        if move_existing && old_path.exists() {
            storage::move_repo_dir(&old_path, &new_path)?;
        }
    }

    cfg.default_snapshot_root = new_default;
    config::save_config_to_disk(&cfg)?;
    drop(cfg);
    emit_config_changed(&app);
    notify_watcher_reload(&app);
    Ok(())
}

#[tauri::command]
pub async fn delete_folder_snapshots(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
) -> Result<(), AppError> {
    let (cfg, folder, repo_path) = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        let folder = cfg
            .watched_folders
            .iter()
            .find(|f| f.id == folder_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("folder id {folder_id}")))?;
        let repo_path = storage::resolve_repo_path(&cfg, &folder)?;
        (cfg.clone(), folder, repo_path)
    };
    storage::delete_repo_at_resolved_path(&cfg, &folder, &repo_path)
}
