# Changelog

## [0.4.1] — 2026-05-10

### Distribution

- **Ad-hoc code signing restored** (`bundle.macOS.signingIdentity: "-"`). v0.4.0 release builds used `null`, which on Apple Silicon often triggers Gatekeeper’s misleading **“AutoVersion.app is damaged and can’t be opened”** instead of the normal unidentified-developer flow. README, `AGENTS.md`, and `ARCHITECTURE.md` now describe ad-hoc signing and quarantine (`xattr`) correctly.

## [0.4.0] — 2026-05-10

### Settings & storage

- **Configurable snapshot locations**: each watched folder can use its own snapshot parent directory (`<parent>/<folder-id>/`), and there is a **global default parent** for folders without an override. Both default to `~/Library/Application Support/AutoVersion/repos`. Changing location prompts **Move / Don’t move / Cancel**; “Don’t move” updates config only and leaves old data on disk as an orphan.
- **Remove folder** now asks **Remove only** vs **Remove and delete snapshots** (deletes the hidden git store for that folder before removing it from config).
- **Add folder** from Settings opens a modal with the **same extension preset picker** as the wizard (including new **PDF** preset).
- New IPC: `get_system_snapshot_parent`, `set_default_snapshot_root`, `set_folder_snapshot_root`, `delete_folder_snapshots`. Config gains `defaultSnapshotRoot` and per-folder `snapshotRootOverride`.
- Removed the **Run retention now** Settings control and the `run_retention_now` command (it was a no-op until real retention work lands).

### Formats

- **PDF** (`.pdf`) in the format registry with conservative temp-file ignores; diff kind remains opaque binary (metadata-only in the UI).

### UI

- Reusable **`ExtensionPicker`**, **`ConfirmDialog`**, and **`AddFolderModal`** components; snapshot path labels simplified in i18n.

## [0.3.0] — 2026-05-10

### Wizard

- New **language step** as the first thing the wizard asks (Settings → Language still works for later changes).
- **Multi-select extensions**: presets are now checkboxes you can combine (Word + Markdown + Code), and **Custom** is its own checkbox with a comma-separated input. Selected extensions are unioned. Wizard is now 5 steps.
- The wizard window is **shown automatically on first launch** (when no folders are configured). Previously the app stayed silent in the menu bar so first-time users had to find the tray icon to start onboarding.

### Fixed

- "No snapshots yet for this file" used to show even when the snapshot list had rows — the diff pane now distinguishes "no snapshots at all" from "snapshots exist, none selected", and **auto-selects the most recent snapshot** when a file is picked.
- DocxDiff no longer crashes with `End of data reached / Corrupted zip ?` when one side is empty bytes (tombstoned snapshot or missing-on-disk file). It now treats empty input as empty text.

### Distribution

- **Intel macOS build** (`x86_64-apple-darwin`) shipped alongside Apple Silicon (`aarch64-apple-darwin`).

### Internal

- Start-at-login is now properly reconciled with the OS via `tauri-plugin-autostart` (`reconcile_autostart` in [`src-tauri/src/autostart.rs`](src-tauri/src/autostart.rs)). `set_config` syncs the LaunchAgent state when the toggle changes; the same reconcile runs once on launch.

## [0.2.0] — 2026-05-09

### Added

- **Open file** action in the Folders pane (next to Restore) — opens the selected file in the OS default application via `tauri-plugin-opener`. New IPC commands `open_path` and `open_watched_file`.
- **Two-pane GitHub-style diff** ([`src/components/TwoPaneLineDiff.tsx`](src/components/TwoPaneLineDiff.tsx)): equal-height rows, removals on the left only (red), additions on the right only (green), unchanged on both, with linked vertical scroll. Used for both text diffs and `.docx` (after Mammoth text extraction). Diff column headers reflect the active compare mode (previous / current on disk / picked revision).

### Fixed

- **Start at login** now calls `tauri-plugin-autostart` (`enable` / `disable`) so macOS actually gets a LaunchAgent (`~/Library/LaunchAgents/io.autoversion.plist`) and the app can appear under **System Settings → General → Login Items**. Previously only `config.json` was updated. Reconciliation also runs once on app launch from saved config. New **Settings → Startup** toggle to change the option after onboarding.
- **Language switching now actually applies translations.** The previous config combined `nonExplicitSupportedLngs: true` with `supportedLngs: ["en", "pt-BR"]`, which made i18next set `language = "pt-BR"` while resolving lookups under bare `pt` (no bundle) and silently falling back to English. Now: `supportedLngs: ["en", "pt", "pt-BR"]`, `load: "currentOnly"`, and the Portuguese bundle is registered under both `pt-BR` and `pt`.
- App-level forced re-render on `i18n.on("languageChanged")` so the entire tree refreshes regardless of react-i18next's internal subscription behavior under StrictMode.
- **macOS "AutoVersion.app is damaged" Gatekeeper error**: bundles are now ad-hoc code-signed (`signingIdentity: "-"` in [`tauri.conf.json`](src-tauri/tauri.conf.json)) so Gatekeeper shows the standard "unknown developer" prompt (right-click → Open) instead of refusing the launch. Existing v0.2.0 release assets re-uploaded with this fix.

## [0.1.0] — 2026-05-09

### First-launch wizard

- Replaced single-screen Onboarding with a 4-step wizard: Welcome → Pick folder → Choose extensions (presets: Word / Markdown & text / Code / Custom) → Confirm + start at login. Progress dots, Back/Next/Finish, plus a discreet **Skip setup** shortcut.
- Triggers whenever `cfg.watchedFolders.length === 0` (so it also reappears if the user removes their last folder).

### Activity feed

- New **Activity** sidebar tab with a global feed of every snapshot across every watched folder, grouped by day (Today / Yesterday / explicit date), refreshes live on `snapshot-created`.
- Clicking an entry deep-links into the Folders pane, selects the file + commit, and switches compare mode to "previous version".
- Backend: new `list_recent_changes(limit)` IPC command that merges per-folder revwalks by timestamp DESC and returns one `ActivityEntry` per (commit, file).

### Inline change stats

- `Snapshot` and `ActivityEntry` now include `addedLines`, `removedLines`, `isBinary`, `byteDelta`, and `isTombstone`. Computed on the Rust side via `git2::DiffStats` against the parent tree, scoped per file via `DiffOptions::pathspec`.
- Snapshot rows in the Folders pane and Activity feed render a `+N -M` badge (or `modified` / `deleted` for binary / tombstone commits).

### Folders pane polish

- Two-line snapshot rows with relative time, stat badge, and copyable 7-char SHA.
- Header row above the diff: filename · short-SHA (with copy button) · relative time, with the right-side stat badge.
- Loading skeleton for snapshots, "No differences" empty state when both sides are byte-equal, "Pick a file to see its history" / "No snapshots yet" empty states.
- Selected items (folder, file, snapshot, sidebar tab) get a left accent border for clearer focus.

### Restore UX

- Post-restore delay is gone: `Restore this version` now flips an inline spinner + disables itself, and the moment the IPC resolves we proactively refresh `listSnapshots` and `getCurrentContent` instead of waiting on the watcher's 2 s debouncer. The `restore-completed` toast still fires off the backend event.

### In-app Help

- New **Help** sidebar tab with five topics: How AutoVersion works, Restoring a version, Pause / Resume, Where AutoVersion stores your data, Troubleshooting.
- Topics are typed React components in `src/App.tsx` (Help* helpers), prose lives in the i18n catalog, so pt-BR translations come for free.

### i18n (English + Português Brasil)

- Added `i18next` + `react-i18next` + `i18next-browser-languagedetector`.
- `src/i18n/index.ts` initializes detection (localStorage → navigator), fallback `en`, supported `["en", "pt-BR"]`, cache key `autoversion.lang`.
- Locales in `src/i18n/locales/{en,pt-BR}.json` cover navigation, wizard, folders, activity, settings, help, about, and common actions.
- Settings → **Language** radio (English / Português (Brasil)) bound to `i18n.changeLanguage`.
- `date-fns` locale picked from `i18n.resolvedLanguage` so relative times in snapshot rows and the Activity feed match the UI language.

### Fixed

- Startup panic from `tauri-plugin-log` (“logger already initialized”) by removing that plugin; Rust logs still go to `~/Library/Logs/AutoVersion/autoversion.log` via `tracing-subscriber` (`init_tracing_file`).
- Onboarding silently dropped the just-added folder because the old `setConfig({ ...cfg, startAtLogin })` call overwrote the config with a stale `cfg` snapshot. The new wizard refetches the live config before persisting `startAtLogin`.

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
- Settings: enable toggle, remove, match preview, Reveal in Finder (`opener`), pause/resume, storage usage.

### Packaging (step 13)

- `pnpm tauri build` produces unsigned macOS bundle; Gatekeeper notes in README.
