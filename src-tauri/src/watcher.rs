//! Filesystem watcher + debounce + ignore filter; snapshots via `storage`.

use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{
    new_debouncer, DebounceEventHandler, DebounceEventResult, DebouncedEvent,
};
use tauri::{AppHandle, Emitter};

use crate::config::Config;
use crate::events::WatcherErrorPayload;
use crate::ignore::{self, compile_globset, extension_allowed, glob_matches, try_relative};
use crate::storage;

#[derive(Clone)]
struct FolderWatchState {
    root: std::path::PathBuf,
    globset: globset::GlobSet,
}

fn emit_watcher_error(app: &AppHandle, folder_id: &str, message: &str) {
    let _ = app.emit(
        "watcher-error",
        WatcherErrorPayload {
            folder_id: folder_id.to_string(),
            message: message.to_string(),
        },
    );
}

fn build_folder_states(config: &Config) -> Result<Vec<FolderWatchState>, String> {
    let mut out = vec![];
    for f in &config.watched_folders {
        if !f.enabled {
            continue;
        }
        let patterns = ignore::patterns_for_folder(f);
        let globset = compile_globset(&patterns).map_err(|e| e.to_string())?;
        out.push(FolderWatchState {
            root: f.path.clone(),
            globset,
        });
    }
    Ok(out)
}

fn find_folder_for_path<'a>(
    config: &'a Config,
    path: &Path,
) -> Option<&'a crate::config::WatchedFolder> {
    config
        .watched_folders
        .iter()
        .find(|f| f.enabled && path.starts_with(&f.path))
}

fn handle_debounced_event(
    app: &AppHandle,
    config: &Arc<Mutex<Config>>,
    states: &[FolderWatchState],
    event: &DebouncedEvent,
) {
    let Ok(cfg) = config.lock() else {
        return;
    };
    if cfg.watching_paused {
        return;
    }

    for path in &event.paths {
        if path.is_dir() {
            continue;
        }

        let Some(folder) = find_folder_for_path(&cfg, path) else {
            continue;
        };

        let Some(state) = states.iter().find(|s| s.root == folder.path) else {
            continue;
        };

        if !extension_allowed(path, folder) {
            continue;
        }

        let Some(rel) = try_relative(&state.root, path) else {
            continue;
        };

        if glob_matches(&state.globset, &rel) {
            tracing::debug!("ignored by pattern: {}", path.display());
            continue;
        }

        tracing::info!("snapshot settle: {}", path.display());
        if let Err(e) = storage::snapshot_watched_file(app, &cfg, folder, path) {
            tracing::error!("snapshot failed: {e}");
            emit_watcher_error(app, &folder.id, &e.to_string());
        }
    }
}

struct DebounceHandler {
    app: AppHandle,
    config: Arc<Mutex<Config>>,
    states: Arc<Mutex<Vec<FolderWatchState>>>,
}

impl DebounceEventHandler for DebounceHandler {
    fn handle_event(&mut self, result: DebounceEventResult) {
        match result {
            Ok(events) => {
                let states = match self.states.lock() {
                    Ok(s) => s.clone(),
                    Err(_) => return,
                };
                for ev in events {
                    handle_debounced_event(&self.app, &self.config, &states, &ev);
                }
            }
            Err(errs) => {
                for e in errs {
                    tracing::error!("notify debouncer error: {e:?}");
                }
            }
        }
    }
}

/// Run on a dedicated thread. Recreates the debouncer whenever `rx` receives a tick.
pub fn run_watcher(app: AppHandle, config: Arc<Mutex<Config>>, rx: Receiver<()>) {
    let states_holder: Arc<Mutex<Vec<FolderWatchState>>> = Arc::new(Mutex::new(vec![]));

    let mut debouncer_opt = None;

    while rx.recv().is_ok() {
        debouncer_opt.take();

        let cfg_snapshot = match config.lock() {
            Ok(c) => c.clone(),
            Err(e) => {
                tracing::error!("config mutex poisoned: {e}");
                continue;
            }
        };

        let states = match build_folder_states(&cfg_snapshot) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("watcher rebuild failed: {e}");
                continue;
            }
        };

        if let Ok(mut g) = states_holder.lock() {
            *g = states.clone();
        }

        let handler = DebounceHandler {
            app: app.clone(),
            config: config.clone(),
            states: states_holder.clone(),
        };

        let mut debouncer = match new_debouncer(Duration::from_secs(2), None, handler) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("failed to create debouncer: {e}");
                continue;
            }
        };

        for s in &states {
            if let Err(e) = debouncer.watch(&s.root, RecursiveMode::Recursive) {
                tracing::error!("watch {:?} failed: {e}", s.root);
                emit_watcher_error(&app, "", &format!("watch {} failed: {e}", s.root.display()));
            }
        }

        debouncer_opt = Some(debouncer);
    }
}
