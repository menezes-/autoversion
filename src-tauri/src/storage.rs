//! Hidden per-folder git snapshot stores under Application Support (or user-chosen roots).

use std::path::{Path, PathBuf};

use chrono::Utc;
use git2::{Repository, Signature};
use tauri::{AppHandle, Emitter};

use crate::config::{Config, WatchedFolder};
use crate::error::AppError;
use crate::events::SnapshotCreatedPayload;
use crate::hash;

pub const MAX_SNAPSHOT_BYTES: u64 = 50 * 1024 * 1024;

/// Default parent directory: `~/Library/Application Support/AutoVersion/repos`.
pub fn system_repos_base() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir().ok_or_else(|| {
        AppError::Config("could not resolve Application Support directory".to_string())
    })?;
    Ok(base.join("AutoVersion").join("repos"))
}

fn repos_base() -> Result<PathBuf, AppError> {
    system_repos_base()
}

/// Parent directory for this folder's git repo, then `<folder.id>/`.
pub fn resolve_repo_parent(config: &Config, folder: &WatchedFolder) -> Result<PathBuf, AppError> {
    if let Some(ref o) = folder.snapshot_root_override {
        return Ok(o.clone());
    }
    if let Some(ref d) = config.default_snapshot_root {
        return Ok(d.clone());
    }
    repos_base()
}

/// Full path to the git working tree for this watched folder.
pub fn resolve_repo_path(config: &Config, folder: &WatchedFolder) -> Result<PathBuf, AppError> {
    Ok(resolve_repo_parent(config, folder)?.join(&folder.id))
}

pub fn open_existing_repo(repo_path: &Path) -> Result<Repository, AppError> {
    if !repo_path.join(".git").exists() {
        return Err(AppError::NotFound(format!(
            "no snapshot repo at {}",
            repo_path.display()
        )));
    }
    Repository::open(repo_path).map_err(AppError::from)
}

fn open_repo(repo_path: &Path) -> Result<Repository, AppError> {
    std::fs::create_dir_all(repo_path)?;
    if repo_path.join(".git").exists() {
        return Repository::open(repo_path).map_err(AppError::from);
    }
    let repo = Repository::init(repo_path).map_err(AppError::from)?;
    let mut cfg = repo.config().map_err(AppError::from)?;
    let _ = cfg.set_str("user.name", "AutoVersion");
    let _ = cfg.set_str("user.email", "autoversion@local");
    Ok(repo)
}

fn blob_sha256_at_head(repo: &Repository, rel: &Path) -> Result<Option<Vec<u8>>, AppError> {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(None),
    };
    let commit = head.peel_to_commit()?;
    let tree = commit.tree()?;
    let entry = match tree.get_path(rel) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let blob = repo.find_blob(entry.id())?;
    Ok(Some(hash::sha256_bytes(blob.content())))
}

fn write_worktree_file(repo: &Repository, rel: &Path, src: &Path) -> Result<(), AppError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Config("repo has no workdir".to_string()))?;
    let dest = workdir.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &dest)?;
    Ok(())
}

fn remove_worktree_file(repo: &Repository, rel: &Path) -> Result<(), AppError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Config("repo has no workdir".to_string()))?;
    let dest = workdir.join(rel);
    if dest.exists() {
        std::fs::remove_file(&dest)?;
    }
    Ok(())
}

/// Snapshot `abs_file` (must be inside `folder.path`). Returns new commit hex if a commit was created.
pub fn snapshot_watched_file(
    app: &AppHandle,
    config: &Config,
    folder: &WatchedFolder,
    abs_file: &Path,
) -> Result<Option<String>, AppError> {
    if !folder.enabled {
        return Ok(None);
    }

    let rel = abs_file
        .strip_prefix(&folder.path)
        .map_err(|_| AppError::BadRequest("file is outside watched folder".to_string()))?
        .to_path_buf();

    let repo_path = resolve_repo_path(config, folder)?;
    let repo = open_repo(&repo_path)?;

    if abs_file.exists() {
        let meta = std::fs::metadata(abs_file)?;
        if meta.len() > MAX_SNAPSHOT_BYTES {
            tracing::warn!(
                "skip snapshot (>{MAX_SNAPSHOT_BYTES} B): {}",
                abs_file.display()
            );
            return Ok(None);
        }

        let file_hash = hash::sha256_file(abs_file)?;
        if let Some(prev) = blob_sha256_at_head(&repo, &rel)? {
            if prev == file_hash {
                tracing::debug!("skip snapshot (unchanged hash): {}", abs_file.display());
                return Ok(None);
            }
        }

        write_worktree_file(&repo, &rel, abs_file)?;

        let mut index = repo.index()?;
        if let Ok(head) = repo.head() {
            let tree = head.peel_to_commit()?.tree()?;
            index.read_tree(&tree)?;
        }
        index.add_path(&rel)?;
        index.write()?;

        let tree_id = index.write_tree()?;
        let msg = commit_message_for_file(abs_file, meta.len(), &file_hash)?;
        let oid = commit_tree(&repo, &msg, tree_id)?;
        emit_snapshot(app, folder, &rel, &oid)?;
        Ok(Some(oid.to_string()))
    } else {
        if blob_sha256_at_head(&repo, &rel)?.is_none() {
            tracing::debug!(
                "skip tombstone (path never tracked): {}",
                abs_file.display()
            );
            return Ok(None);
        }

        remove_worktree_file(&repo, &rel)?;

        let mut index = repo.index()?;
        if let Ok(head) = repo.head() {
            let tree = head.peel_to_commit()?.tree()?;
            index.read_tree(&tree)?;
        }
        index.remove_path(&rel)?;
        index.write()?;

        let tree_id = index.write_tree()?;
        let msg = format!(
            "auto: deleted: {} @ {}\n\n(path missing at snapshot time)",
            rel.display(),
            Utc::now().to_rfc3339()
        );
        let oid = commit_tree(&repo, &msg, tree_id)?;
        emit_snapshot(app, folder, &rel, &oid)?;
        Ok(Some(oid.to_string()))
    }
}

fn commit_message_for_file(abs: &Path, size: u64, hash: &[u8]) -> Result<String, AppError> {
    let name = abs.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let ts = Utc::now().to_rfc3339();
    let meta = format!("size={size}\nsha256={}", hash::hex_hash(hash));
    Ok(format!("auto: {name} @ {ts}\n\n{meta}"))
}

fn commit_tree(
    repo: &Repository,
    message: &str,
    tree_id: git2::Oid,
) -> Result<git2::Oid, AppError> {
    let sig = Signature::now("AutoVersion", "autoversion@local")?;
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(head) => {
            let c = head.peel_to_commit()?;
            vec![c]
        }
        Err(_) => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &repo.find_tree(tree_id)?,
        &parent_refs,
    )?;
    Ok(oid)
}

fn emit_snapshot(
    app: &AppHandle,
    folder: &WatchedFolder,
    rel: &Path,
    commit: &git2::Oid,
) -> Result<(), AppError> {
    let payload = SnapshotCreatedPayload {
        folder_id: folder.id.clone(),
        relative_path: rel.to_string_lossy().to_string(),
        commit_sha: commit.to_string(),
        timestamp: Utc::now().to_rfc3339(),
    };
    let _ = app.emit("snapshot-created", payload);
    Ok(())
}

/// Manual snapshot used before restore (step 11); same as `snapshot_watched_file` for existing files.
#[allow(dead_code)]
pub fn snapshot_current_if_exists(
    app: &AppHandle,
    config: &Config,
    folder: &WatchedFolder,
    abs_file: &Path,
) -> Result<Option<String>, AppError> {
    if abs_file.exists() {
        snapshot_watched_file(app, config, folder, abs_file)
    } else {
        Ok(None)
    }
}

/// Read object bytes for `relative_path` at `commit_sha`.
pub fn read_blob_at_commit(
    repo_path: &Path,
    commit_sha: &str,
    relative_path: &str,
) -> Result<Vec<u8>, AppError> {
    let repo = open_existing_repo(repo_path)?;
    let oid = git2::Oid::from_str(commit_sha).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let rel = Path::new(relative_path);
    let entry = tree
        .get_path(rel)
        .map_err(|_| AppError::NotFound(format!("path {relative_path} not in commit")))?;
    let blob = repo.find_blob(entry.id())?;
    Ok(blob.content().to_vec())
}

/// Write `bytes` to `dest` on disk (creates parent dirs).
pub fn write_bytes_to_disk(dest: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(dest, bytes)?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() || ty.is_symlink() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a snapshot repo directory to a new path (same-disk rename, else copy + remove source).
pub fn move_repo_dir(from: &Path, to: &Path) -> Result<(), AppError> {
    if from == to {
        return Ok(());
    }
    if to.exists() {
        return Err(AppError::BadRequest(format!(
            "destination already exists: {}",
            to.display()
        )));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            copy_dir_recursive(from, to)?;
            std::fs::remove_dir_all(from).map_err(AppError::from)
        }
        Err(e) => Err(AppError::from(e)),
    }
}

/// Delete `repo_path` only if it resolves to the canonical path for this folder (safety guard).
pub fn delete_repo_at_resolved_path(
    config: &Config,
    folder: &WatchedFolder,
    repo_path: &Path,
) -> Result<(), AppError> {
    let expected = resolve_repo_path(config, folder)?;
    let exp_canon = expected.canonicalize().unwrap_or(expected);
    let got_canon = repo_path
        .canonicalize()
        .unwrap_or_else(|_| repo_path.to_path_buf());
    if exp_canon != got_canon {
        return Err(AppError::BadRequest(
            "refusing to delete snapshot store: path mismatch".to_string(),
        ));
    }
    if !repo_path.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(repo_path).map_err(AppError::from)
}
