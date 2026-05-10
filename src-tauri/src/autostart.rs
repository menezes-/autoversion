//! Sync `config.start_at_login` with the OS via `tauri-plugin-autostart`.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;

/// Enable or disable the LaunchAgent so it matches `desired`.
pub fn reconcile_autostart(app: AppHandle, desired: bool) -> Result<(), AppError> {
    let mgr = app.autolaunch();
    let is_on = mgr
        .is_enabled()
        .map_err(|e| AppError::Autostart(e.to_string()))?;
    match (desired, is_on) {
        (true, false) => mgr.enable().map_err(|e| AppError::Autostart(e.to_string())),
        (false, true) => mgr
            .disable()
            .map_err(|e| AppError::Autostart(e.to_string())),
        _ => Ok(()),
    }
}
