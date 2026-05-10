//! History / snapshot browsing IPC.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::{Commit, Delta, DiffOptions, Repository, Sort, Tree};
use serde::Serialize;
use tauri::State;

use crate::config::{Config, WatchedFolder};
use crate::error::AppError;
use crate::storage;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub relative_path: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub commit_sha: String,
    pub timestamp: String,
    pub added_lines: u32,
    pub removed_lines: u32,
    pub is_binary: bool,
    /// Bytes(this) - bytes(parent). Negative on deletions, equal to size on creations.
    pub byte_delta: i64,
    /// True when this commit removed the file from the tree.
    pub is_tombstone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub folder_id: String,
    pub folder_path: String,
    pub folder_name: String,
    pub relative_path: String,
    pub commit_sha: String,
    pub timestamp: String,
    pub added_lines: u32,
    pub removed_lines: u32,
    pub is_binary: bool,
    pub byte_delta: i64,
    pub is_tombstone: bool,
}

#[derive(Debug, Clone, Default)]
struct DiffMetrics {
    added_lines: u32,
    removed_lines: u32,
    is_binary: bool,
    byte_delta: i64,
    is_tombstone: bool,
}

fn folder_by_id<'a>(cfg: &'a Config, id: &str) -> Result<&'a WatchedFolder, AppError> {
    cfg.watched_folders
        .iter()
        .find(|f| f.id == id)
        .ok_or_else(|| AppError::NotFound(format!("folder id {id}")))
}

fn repo_path_for_command(cfg: &Config, folder_id: &str) -> Result<PathBuf, AppError> {
    let folder = folder_by_id(cfg, folder_id)?;
    storage::resolve_repo_path(cfg, folder)
}

fn walk_tree_paths(repo: &Repository, tree: &Tree, prefix: &Path) -> Result<Vec<String>, AppError> {
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

fn rfc3339_from_secs(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
        .to_rfc3339()
}

fn parent_tree<'a>(commit: &Commit<'a>) -> Result<Option<Tree<'a>>, AppError> {
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    let parent = commit.parent(0)?;
    Ok(Some(parent.tree()?))
}

fn blob_size_at(repo: &Repository, tree: Option<&Tree>, rel: &Path) -> i64 {
    let Some(tree) = tree else { return 0 };
    let Ok(entry) = tree.get_path(rel) else {
        return 0;
    };
    let Ok(blob) = repo.find_blob(entry.id()) else {
        return 0;
    };
    blob.content().len() as i64
}

/// Compute diff metrics for a single commit, optionally scoped to one relative path.
fn compute_diff_metrics(
    repo: &Repository,
    commit: &Commit<'_>,
    rel: Option<&Path>,
) -> Result<DiffMetrics, AppError> {
    let parent = parent_tree(commit)?;
    let this_tree = commit.tree()?;

    let mut opts = DiffOptions::new();
    opts.include_typechange(true);
    if let Some(rel) = rel {
        opts.pathspec(rel);
    }

    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&this_tree), Some(&mut opts))?;

    let mut metrics = DiffMetrics::default();

    if let Some(rel) = rel {
        let new_size = blob_size_at(repo, Some(&this_tree), rel);
        let old_size = blob_size_at(repo, parent.as_ref(), rel);
        metrics.byte_delta = new_size - old_size;
    }

    diff.foreach(
        &mut |delta, _| {
            if delta.flags().is_binary() {
                metrics.is_binary = true;
            }
            if matches!(delta.status(), Delta::Deleted) {
                metrics.is_tombstone = true;
            }
            true
        },
        None,
        None,
        None,
    )?;

    if !metrics.is_binary {
        if let Ok(stats) = diff.stats() {
            metrics.added_lines = stats.insertions() as u32;
            metrics.removed_lines = stats.deletions() as u32;
        }
    }

    Ok(metrics)
}

#[tauri::command]
pub async fn list_watched_files(
    state: State<'_, Arc<Mutex<Config>>>,
    folder_id: String,
) -> Result<Vec<FileEntry>, AppError> {
    let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
    let repo_path = repo_path_for_command(&cfg, &folder_id)?;
    drop(cfg);

    let repo = match storage::open_existing_repo(&repo_path) {
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
    let repo_path = repo_path_for_command(&cfg, &folder_id)?;
    drop(cfg);

    let repo = storage::open_existing_repo(&repo_path)?;
    let rel = PathBuf::from(&relative_path);
    let mut rw = repo.revwalk()?;
    rw.set_sorting(Sort::TIME)?;
    rw.push_head()?;

    let mut out = vec![];
    for oid in rw {
        let oid = oid.map_err(|e| AppError::Config(e.to_string()))?;
        let commit = repo.find_commit(oid)?;
        let this_tree = commit.tree()?;
        let parent = parent_tree(&commit)?;

        let in_this = this_tree.get_path(&rel).is_ok();
        let in_parent = parent.as_ref().is_some_and(|p| p.get_path(&rel).is_ok());
        if !in_this && !in_parent {
            continue;
        }

        let metrics = compute_diff_metrics(&repo, &commit, Some(&rel))?;
        let snapshot_metrics = if !in_this && in_parent {
            DiffMetrics {
                is_tombstone: true,
                ..metrics
            }
        } else {
            metrics
        };

        out.push(Snapshot {
            commit_sha: oid.to_string(),
            timestamp: rfc3339_from_secs(commit.time().seconds()),
            added_lines: snapshot_metrics.added_lines,
            removed_lines: snapshot_metrics.removed_lines,
            is_binary: snapshot_metrics.is_binary,
            byte_delta: snapshot_metrics.byte_delta,
            is_tombstone: snapshot_metrics.is_tombstone,
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
    let repo_path = repo_path_for_command(&cfg, &folder_id)?;
    drop(cfg);
    storage::read_blob_at_commit(&repo_path, &commit_sha, &relative_path)
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

/// Walk every enabled folder's repo, expand each commit into one entry per
/// changed file, merge by timestamp DESC, take `limit` entries.
#[tauri::command]
pub async fn list_recent_changes(
    state: State<'_, Arc<Mutex<Config>>>,
    limit: Option<usize>,
) -> Result<Vec<ActivityEntry>, AppError> {
    let limit = limit.unwrap_or(200);
    let (folders, cfg_snapshot): (Vec<WatchedFolder>, Config) = {
        let cfg = state.lock().map_err(|e| AppError::Config(e.to_string()))?;
        (
            cfg.watched_folders
                .iter()
                .filter(|f| f.enabled)
                .cloned()
                .collect(),
            cfg.clone(),
        )
    };

    let mut all: Vec<ActivityEntry> = vec![];

    for folder in folders {
        let repo_path = match storage::resolve_repo_path(&cfg_snapshot, &folder) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let repo = match storage::open_existing_repo(&repo_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let mut rw = match repo.revwalk() {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rw.set_sorting(Sort::TIME).is_err() {
            continue;
        }
        if rw.push_head().is_err() {
            continue;
        }

        let folder_name = folder
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| folder.path.to_string_lossy().to_string());
        let folder_path_str = folder.path.to_string_lossy().to_string();

        let mut count_for_folder = 0usize;
        let folder_cap = limit.saturating_mul(2).max(50);

        for oid in rw {
            if count_for_folder >= folder_cap {
                break;
            }
            let Ok(oid) = oid else { continue };
            let Ok(commit) = repo.find_commit(oid) else {
                continue;
            };

            let parent = match parent_tree(&commit) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let this_tree = match commit.tree() {
                Ok(t) => t,
                Err(_) => continue,
            };

            let diff = match repo.diff_tree_to_tree(parent.as_ref(), Some(&this_tree), None) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let timestamp = rfc3339_from_secs(commit.time().seconds());
            let sha_str = oid.to_string();

            for delta in diff.deltas() {
                let path_buf = delta
                    .new_file()
                    .path()
                    .or_else(|| delta.old_file().path())
                    .map(|p| p.to_path_buf());
                let Some(path_buf) = path_buf else { continue };

                let metrics = match compute_diff_metrics(&repo, &commit, Some(path_buf.as_path())) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let is_tombstone = matches!(delta.status(), Delta::Deleted);

                all.push(ActivityEntry {
                    folder_id: folder.id.clone(),
                    folder_path: folder_path_str.clone(),
                    folder_name: folder_name.clone(),
                    relative_path: path_buf.to_string_lossy().replace('\\', "/"),
                    commit_sha: sha_str.clone(),
                    timestamp: timestamp.clone(),
                    added_lines: metrics.added_lines,
                    removed_lines: metrics.removed_lines,
                    is_binary: metrics.is_binary,
                    byte_delta: metrics.byte_delta,
                    is_tombstone,
                });
                count_for_folder += 1;
            }
        }
    }

    all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if all.len() > limit {
        all.truncate(limit);
    }
    Ok(all)
}
