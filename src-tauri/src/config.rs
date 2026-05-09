//! User config persisted under Application Support.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// Top-level persisted config (see `ARCHITECTURE.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub watched_folders: Vec<WatchedFolder>,
    pub start_at_login: bool,
    pub retention_policy: RetentionPolicy,
    /// When true, debounced events are ignored (menu bar + settings).
    #[serde(default)]
    pub watching_paused: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            watched_folders: vec![],
            start_at_login: true,
            retention_policy: RetentionPolicy::default(),
            watching_paused: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum RetentionPolicy {
    #[default]
    KeepEverything,
    ThinAfter7Days,
    ThinAfter30Days,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    /// Stable id: hex SHA-256 of the canonical watched path.
    pub id: String,
    pub path: PathBuf,
    /// Lowercase extensions without dot; empty means "all files".
    pub extensions: Vec<String>,
    pub user_ignore_patterns: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolderPatch {
    pub path: Option<PathBuf>,
    pub extensions: Option<Vec<String>>,
    pub user_ignore_patterns: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

pub fn config_file_path() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Config("could not resolve config directory".to_string()))?;
    Ok(base.join("AutoVersion").join("config.json"))
}

pub fn stable_folder_id(canonical_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn load_config_from_disk() -> Result<Config, AppError> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&path)?;
    let cfg: Config = serde_json::from_str(&text).map_err(|e| AppError::Config(e.to_string()))?;
    Ok(cfg)
}

pub fn save_config_to_disk(cfg: &Config) -> Result<(), AppError> {
    let path = config_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| AppError::Config(e.to_string()))?;
    std::fs::write(path, text)?;
    Ok(())
}
