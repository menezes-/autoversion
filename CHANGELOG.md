# Changelog

## [0.1.0] — Unreleased

### Fixed

- Startup panic from `tauri-plugin-log` (“logger already initialized”) by removing that plugin; Rust logs still go to `~/Library/Logs/AutoVersion/autoversion.log` via `tracing-subscriber` (`init_tracing_file`).

### Documentation

- **AGENTS.md** — pnpm workflow, pinned stack (`tauri` 2.11.1, `tauri-build` 2.6.x, JS `@tauri-apps/*` 2.11.0), dependency tables, `tauri-plugin-opener`, no standalone `notify` crate (use debouncer re-export).
- **ARCHITECTURE.md** — extra watcher crates, Tailwind v4 + shadcn-style UI, `pnpm tauri build`.

### App shell (step 1)

- Menu-bar accessory (`ActivationPolicy::Accessory`), tray (Open / Pause / Quit), hidden main window, close → hide.
- Plugins: autostart, notification, dialog, single-instance, opener. ACL in `capabilities/default.json`. File logging uses `tracing-subscriber` only (no `tauri-plugin-log`, avoids double global logger init).
- Bundle id `io.autoversion.app`, product name **AutoVersion**.

### Config & IPC (step 2)

- `Config` / `WatchedFolder` persisted under Application Support; commands `get_config`, `set_config`, `add_watched_folder`, `update_watched_folder`, `remove_watched_folder`.
- `config-changed` event; typed TS wrappers in `src/lib/tauri.ts`.

### Format registry (step 3)

- `src-tauri/src/formats.rs` + `src/lib/formats.ts` (docx, markdown, text, LaTeX, source catch-all, universal ignores).

### Watcher & snapshot store (steps 4–5)

- `notify-debouncer-full` (2s debounce), `globset` ignore filter, extension allow-list per folder.
- Per-folder git repo under `repos/<folder-id>/`, SHA-256 dedup, 50 MB max file, tombstones when file missing.
- `watching_paused` flag; tray **Pause** toggles pause + saves config.

### UI (steps 6–12 consolidated)

- Onboarding when no folders; folder picker via `@tauri-apps/plugin-dialog`.
- Main layout: Folders / Settings / About; history columns; diff modes (previous / current / pick); text line diff, docx word diff (`mammoth` + `diff`), opaque metadata.
- Restore with confirmation; `restore-completed` toast; live `snapshot-created` / `watcher-error` listeners.
- Settings: enable toggle, remove, match preview, Reveal in Finder (`opener`), pause/resume, storage usage, retention button (no-op until policy work).

### Packaging (step 13)

- `pnpm tauri build` produces unsigned macOS bundle; Gatekeeper notes in README.
- `run_retention_now` is a logged no-op (default keep-everything).
