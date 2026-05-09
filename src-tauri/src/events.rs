//! Backend → frontend event payloads.

use serde::Serialize;

/// Fired whenever config is mutated (watcher should reload).
#[derive(Clone, Serialize)]
pub struct ConfigChangedPayload {}

#[derive(Clone, Serialize)]
pub struct SnapshotCreatedPayload {
    pub folder_id: String,
    pub relative_path: String,
    pub commit_sha: String,
    pub timestamp: String,
}

#[derive(Clone, Serialize)]
pub struct WatcherErrorPayload {
    pub folder_id: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[allow(dead_code)] // emitted from restore flow (step 11+)
pub struct RestoreCompletedPayload {
    pub folder_id: String,
    pub relative_path: String,
    pub restored_from_sha: String,
}
