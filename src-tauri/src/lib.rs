//! AutoVersion Tauri shell: menu-bar accessory, tray, plugins.

mod autostart;
mod commands;
mod config;
mod error;
mod events;
mod formats;
mod hash;
mod ignore;
mod storage;
mod watcher;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tracing::error;

use crate::autostart::reconcile_autostart;
use crate::config::Config;

/// Notify the background watcher thread to rebuild watches from `Arc<Mutex<Config>>`.
#[derive(Clone)]
pub struct WatcherTx(pub mpsc::Sender<()>);

pub(crate) fn notify_watcher_reload(app: &AppHandle) {
    if let Some(tx) = app.try_state::<WatcherTx>() {
        let _ = tx.0.send(());
    }
}

fn log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/Logs/AutoVersion")
}

fn init_tracing_file() {
    let dir = log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("AutoVersion: could not create log dir {dir:?}: {e}");
        return;
    }
    let log_file = dir.join("autoversion.log");
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("AutoVersion: could not open log file {log_file:?}: {e}");
            return;
        }
    };

    if let Err(e) = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::sync::Mutex::new(file))
        .try_init()
    {
        eprintln!("AutoVersion: tracing subscriber not installed: {e}");
    } else {
        eprintln!("AutoVersion: file logging at {}", log_file.display());
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn build_tray_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open AutoVersion", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause Watching", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &quit])
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("icon"));

    let click_handle = app.handle().clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            if event.id == "open" {
                toggle_main_window(app);
            } else if event.id == "pause" {
                if let Some(cfg_arc) = app.try_state::<std::sync::Arc<std::sync::Mutex<Config>>>() {
                    if let Ok(mut c) = cfg_arc.lock() {
                        c.watching_paused = !c.watching_paused;
                        if let Err(e) = config::save_config_to_disk(&c) {
                            tracing::error!("save config: {e}");
                        } else {
                            notify_watcher_reload(app);
                        }
                    }
                }
            } else if event.id == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(&click_handle);
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing_file();
    tracing::info!(
        "AutoVersion starting up (version {})",
        env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.get_webview_window("main").map(|w| {
                let _ = w.show();
                w.set_focus()
            });
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Detect first launch BEFORE we materialise a default config: if
            // there is no config file on disk yet, we want to surface the
            // window so the user sees the wizard instead of a silent menubar.
            let first_launch = match config::config_file_path() {
                Ok(p) => !p.exists(),
                Err(_) => true,
            };
            let initial_config = match config::load_config_from_disk() {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("failed to load config, using defaults: {e}");
                    Config::default()
                }
            };
            let needs_onboarding = first_launch || initial_config.watched_folders.is_empty();
            let start_at_login = initial_config.start_at_login;
            let shared_config = Arc::new(Mutex::new(initial_config));
            app.manage(shared_config.clone());

            if let Err(e) = reconcile_autostart(app.handle().clone(), start_at_login) {
                tracing::warn!("autostart reconcile on launch: {e}");
            }

            let (watcher_tx, watcher_rx) = mpsc::channel::<()>();
            app.manage(WatcherTx(watcher_tx.clone()));

            let app_for_watcher = app.handle().clone();
            let cfg_for_watcher = shared_config.clone();
            std::thread::spawn(move || {
                watcher::run_watcher(app_for_watcher, cfg_for_watcher, watcher_rx);
            });
            let _ = watcher_tx.send(());

            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            setup_tray(app)?;

            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Err(e) = win_clone.hide() {
                            error!("failed to hide main window: {e}");
                        }
                    }
                });

                if needs_onboarding {
                    if let Err(e) = win.show() {
                        tracing::warn!("first-launch window show: {e}");
                    }
                    if let Err(e) = win.set_focus() {
                        tracing::warn!("first-launch window focus: {e}");
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::set_config,
            commands::config::add_watched_folder,
            commands::config::update_watched_folder,
            commands::config::remove_watched_folder,
            commands::config::preview_folder_matches,
            commands::config::get_system_snapshot_parent,
            commands::config::set_default_snapshot_root,
            commands::config::set_folder_snapshot_root,
            commands::config::delete_folder_snapshots,
            commands::history::list_watched_files,
            commands::history::list_snapshots,
            commands::history::list_recent_changes,
            commands::history::get_snapshot_content,
            commands::history::get_current_content,
            commands::actions::restore_snapshot,
            commands::actions::trigger_manual_snapshot,
            commands::actions::pause_watching,
            commands::actions::resume_watching,
            commands::actions::reveal_path,
            commands::actions::open_path,
            commands::actions::open_watched_file,
            commands::status::get_status,
            commands::status::get_storage_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
