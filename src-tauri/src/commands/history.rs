//! History / snapshot browsing IPC.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::Sort;
use serde::Serialize;
use tauri::State;

use crate::config::Config;
use crate::error::AppError;
use crate::storage;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub commit_sha: String,
    pub timestamp: String,
}

fn folder_by_id<'a>(
    cfg: &'a Config,
    id: &str,
) -> Result<&'a crate::config::WatchedFolder, AppError> {
    cfg.watched_folders
        .iter()
        .find(|f| f.id == id)
        .ok_or_else(|| AppError::NotFound(format!("folder id {id}")))
}

fn walk_tree_paths(
    repo: &git2::Repository,
    tree: &git2::Tree,
    prefix: &Path,
) -> Result<Vec<String>, AppError> {
    let mut out = vec![];
    for e in tree.iter() {
        let name = std::str::from_utf8(e.name_bytes())
            .map_err(|_| AppError::Config("invalid utf-8 path in git tree".to_string()))?;
        let path = prefix.join(name);
        let obj = e.to_object(repo)?;
        if let Ok(sub) = obj.peel_to_tree() {
            out.extend(walk_tree_paths(repo, &sub, &path)?);
        } else {
            out.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_watched_files(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
) -> Result<Vec<FileEntry>, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let _folder = folder_by_id(&cfg, &folder_id)?;
    drop(cfg);

    let repo = match storage::open_existing_repo(&folder_id) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    let commit = head.peel_to_commit()?;
    let tree = commit.tree()?;
    let paths = walk_tree_paths(&repo, &tree, Path::new(""))?;
    Ok(paths
        .into_iter()
        .map(|relative_path| FileEntry { relative_path })
        .collect())
}

#[tauri::command]
pub async fn list_snapshots(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    relative_path: String,
) -> Result<Vec<Snapshot>, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let _folder = folder_by_id(&cfg, &folder_id)?;
    drop(cfg);

    let repo = storage::open_existing_repo(&folder_id)?;
    let rel = PathBuf::from(&relative_path);
    let mut rw = repo.revwalk()?;
    rw.set_sorting(Sort::TIME)?;
    rw.push_head()?;

    let mut out = vec![];
    for oid in rw {
        let oid = oid.map_err(|e| AppError::Config(e.to_string()))?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        if tree.get_path(&rel).is_err() {
            continue;
        }
        let ts = commit.time().seconds();
        let dt = chrono::DateTime::from_timestamp(ts, 0)
            .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
            .to_rfc3339();
        out.push(Snapshot {
            commit_sha: oid.to_string(),
            timestamp: dt,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_snapshot_content(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    commit_sha: String,
    relative_path: String,
) -> Result<Vec<u8>, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let _folder = folder_by_id(&cfg, &folder_id)?;
    drop(cfg);
    storage::read_blob_at_commit(&folder_id, &commit_sha, &relative_path)
}

#[tauri::command]
pub async fn get_current_content(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
    relative_path: String,
) -> Result<Vec<u8>, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let folder = folder_by_id(&cfg, &folder_id)?;
    let abs = folder.path.join(&relative_path);
    drop(cfg);
    if !abs.exists() {
        return Err(AppError::NotFound(abs.display().to_string()));
    }
    std::fs::read(&abs).map_err(|e| e.into())
}
