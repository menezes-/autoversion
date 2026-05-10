//! Status and storage usage.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::config::Config;
use crate::error::AppError;
use crate::storage;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub watching_paused: bool,
    pub watched_folder_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub total_bytes: u64,
    pub per_folder: Vec<FolderStorage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStorage {
    pub folder_id: String,
    pub bytes: u64,
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(read) = std::fs::read_dir(path) {
        for e in read.flatten() {
            let p = e.path();
            if let Ok(m) = e.metadata() {
                if m.is_dir() {
                    total += dir_size(&p);
                } else {
                    total += m.len();
                }
            }
        }
    }
    total
}

#[tauri::command]
pub async fn get_status(state: State<'_, Arc<Mutex<Config>>>) -> Result<Status, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    Ok(Status {
        watching_paused: cfg.watching_paused,
        watched_folder_count: cfg.watched_folders.len(),
    })
}

#[tauri::command]
pub async fn get_storage_usage(
    state: State<'_, Arc<Mutex<Config>>>,
) -> Result<StorageUsage, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let mut per_folder = vec![];
    let mut total_bytes = 0u64;
    for f in &cfg.watched_folders {
        let Ok(repo_path) = storage::resolve_repo_path(&cfg, f) else {
            continue;
        };
        let bytes = if repo_path.exists() {
            dir_size(&repo_path)
        } else {
            0
        };
        total_bytes += bytes;
        per_folder.push(FolderStorage {
            folder_id: f.id.clone(),
            bytes,
        });
    }
    Ok(StorageUsage {
        total_bytes,
        per_folder,
    })
}
