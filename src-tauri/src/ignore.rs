//! Glob-based ignore rules for watched paths (built-in + per-folder user patterns).

use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};

use crate::config::WatchedFolder;
use crate::error::AppError;
use crate::formats::{self, find_handler};

/// Collect ignore globs for a watched folder (universal + format registry + user).
pub fn patterns_for_folder(folder: &WatchedFolder) -> Vec<String> {
    let mut out: Vec<String> = formats::universal_ignore_patterns()
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    if folder.extensions.is_empty() {
        for h in formats::HANDLERS
            .iter()
            .take(formats::HANDLERS.len().saturating_sub(1))
        {
            for p in h.ignore_patterns {
                out.push((*p).to_string());
            }
        }
    } else {
        for ext in &folder.extensions {
            let h = find_handler(ext);
            for p in h.ignore_patterns {
                out.push((*p).to_string());
            }
        }
    }

    for p in &folder.user_ignore_patterns {
        let t = p.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }

    out.sort();
    out.dedup();
    out
}

pub fn compile_globset(patterns: &[String]) -> Result<GlobSet, AppError> {
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| AppError::Config(format!("invalid glob {p:?}: {e}")))?;
        builder.add(g);
    }
    builder
        .build()
        .map_err(|e| AppError::Config(format!("globset build: {e}")))
}

/// `path` must be relative to the watched folder root (POSIX-style `/` segments recommended).
pub fn glob_matches(set: &GlobSet, relative_path: &Path) -> bool {
    let s = path_for_glob(relative_path);
    set.is_match(&s)
}

fn path_for_glob(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

pub fn extension_allowed(path: &Path, folder: &WatchedFolder) -> bool {
    if folder.extensions.is_empty() {
        return true;
    }
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let e = ext.to_lowercase();
    folder.extensions.iter().any(|x| x.eq_ignore_ascii_case(&e))
}

/// Strip `root` from `path` if it is inside `root`.
pub fn try_relative(root: &Path, path: &Path) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(Path::to_path_buf)
}
