# AutoVersion — Architecture Specification

## Goal

A macOS application that automatically versions files in a watched folder. Designed for non-technical users (e.g. someone writing a thesis in Word while an AI agent also edits the file). Acts as an invisible safety net: every meaningful save becomes a recoverable snapshot, with a friendly UI to browse history and view diffs.

**Format-agnostic by design.** The watcher, snapshot store, and restore flow treat every file as opaque bytes. The user picks any folder and any extension(s) — `.docx`, `.md`, `.tex`, `.py`, `.indd`, whatever. The system versions all of them the same way.

**Format-aware where it matters.** Two thin layers know about specific formats:
1. The **temp-file ignore list** must know which sidecar/lock files each editor produces, so we don't snapshot garbage.
2. The **diff viewer** needs format-specific renderers to show a meaningful diff to a human (raw byte diffs of a `.docx` zip are useless).

For everything else — watching, hashing, dedup, snapshotting, retention, restore — the file's format does not matter. Adding support for a new format means adding entries to the ignore list and (optionally) a diff renderer. It does not mean changing the storage or watcher.

## High-Level Design

Three components in a single Tauri app:

1. **Background watcher** (Rust) — runs as a menu bar agent, watches configured folders, snapshots changed files into a hidden git repo.
2. **Frontend UI** (web — React + TypeScript + Vite) — opened via menu bar click or dock icon. Configuration, history browsing, diff viewing, restore actions.
3. **Local IPC** — Tauri's built-in command system bridges the Rust backend and the web frontend. No separate HTTP server needed.

**Why Tauri over Electron:** smaller binary (~10MB vs ~100MB), uses macOS WebKit so it feels native, Rust backend gives us a robust file watcher and git integration, and the menu-bar-only mode is well supported.

**Why not a pure web app:** needs persistent background watching, file system access outside the browser sandbox, and no friction for a non-technical user. A menu bar agent is the right shape.

## Component Detail

### 1. Background Watcher (Rust)

**Responsibilities:**
- Load config (watched folders + extensions) from `~/Library/Application Support/AutoVersion/config.json`.
- Watch each folder recursively using the `notify` crate (which uses FSEvents on macOS).
- Filter events to configured extensions only.
- Debounce events per-file: wait for 2 seconds of inactivity on a file before snapshotting. This is critical — many editors (Word, Pages, vim with backup files, JetBrains IDEs, etc.) do atomic-rename saves or write multiple events per save.
- Apply the ignore-pattern registry (see below) so we don't snapshot temp/lock/swap files.
- On a debounced "file is settled" event:
    1. Hash the file contents (SHA-256). If unchanged from last snapshot, skip.
    2. Copy file into the snapshot store and commit (see Storage below).
    3. Emit a Tauri event `snapshot-created` so the UI updates live if open.

**Crates:**
- `notify` + `notify-debouncer-full` — file watching with built-in debouncing.
- `git2` — libgit2 bindings for the snapshot store (`vendored-libgit2`; no system `git` binary).
- `serde` + `serde_json` — config and IPC.
- `sha2` — content hashing for dedup.
- `globset` — compile user + built-in ignore globs for fast matching.
- `dirs` — resolve `~/Library/Application Support/AutoVersion/` paths.
- `chrono` — ISO timestamps in commit messages and UI-facing metadata.
- `tracing` (+ `tracing-subscriber`) — structured logs to `~/Library/Logs/AutoVersion/autoversion.log` (Rust only; no `tauri-plugin-log` to avoid double global logger initialization).
- `anyhow` / `thiserror` — app vs. typed IPC errors.
- `tauri` — app shell, IPC, menu bar, tray.

**Lifecycle:** the watcher starts when the app launches (on login if user enables "start at login" — Tauri has a plugin for this). It runs whether or not the UI window is open. Closing the window does *not* quit the app; only "Quit" from the menu does.

### 2. Storage — Hidden Git Repo per Watched Folder

For each watched folder, AutoVersion maintains a parallel git repository at:

```
<snapshot-parent>/<folder-id>/
```

where `<folder-id>` is a stable hash of the absolute **watched** folder path, and `<snapshot-parent>` resolves in order:

1. Per-folder `snapshotRootOverride` in config (if set), else  
2. Global `defaultSnapshotRoot` in config (if set), else  
3. Built-in default `~/Library/Application Support/AutoVersion/repos`

**Why a separate repo, not a `.git` inside the watched folder:**
- The user doesn't see or interact with git.
- Doesn't conflict if they ever do use git in that folder.
- Survives if the watched folder is on a synced drive (iCloud, Dropbox).

**On each snapshot:**
1. Copy the changed file into the repo working tree (preserving relative path within the watched folder).
2. Stage the file and create a commit with message `auto: <filename> @ <ISO timestamp>`.
3. Include metadata in the commit message body: original mtime, file size, content hash.

**All git operations go through the `git2` crate (libgit2 bindings), which is statically linked into the app binary. The user does NOT need the `git` command-line tool installed.** Do not shell out to `git` via `std::process::Command` — use the `git2` API exclusively. This keeps the app self-contained and avoids a dependency the target user almost certainly doesn't have.

**Why git as the storage format and not a custom store:** free deduplication via packfiles, free integrity, free history walking, and `git2` makes it all programmatic. The user never sees a git command — and never needs git installed.

**Retention policy** (configurable, sensible defaults):
- Keep all snapshots from the last 24 hours.
- Keep hourly snapshots for the last 7 days.
- Keep daily snapshots beyond that.
- Run a thinning pass once a day. Implement with `git2` by listing commits and rewriting refs; or keep it simple in v1 and just keep everything (a thesis is a few MB; this is fine for a long time).

### 3. Application Flow and UI (React + TypeScript)

The UI is a single-window React app. The window is hidden by default; the menu bar icon is the entry point.

#### Application states

The app has four user-facing states:

- **First run** — no folders configured yet. Opens onto onboarding.
- **Idle** — at least one folder configured, watcher running, no recent activity.
- **Active** — a snapshot was just taken (last 30 seconds). Menu bar icon pulses briefly.
- **Error** — watcher errored, a folder is unreachable, or permissions are missing. Menu bar icon shows a warning glyph.

The menu bar icon reflects state at all times. Right-click on the icon shows a native menu: *Open AutoVersion · Pause Watching · Quit*. Left-click toggles the main window.

#### Onboarding (first run)

A single full-window screen, no sidebar:

1. Welcome line: "AutoVersion keeps a history of every save, so nothing ever gets lost."
2. Big primary button: **Pick a folder to protect** → opens native folder picker.
3. After folder is picked, second step inline: *Which files in this folder?*
    - Default: a list of common presets the user can tap (Word documents, Markdown, Plain text, Code files, Everything).
    - Custom: free-text field for extensions, comma-separated.
4. A small "Start AutoVersion automatically when I log in" checkbox, default ON.
5. **Done** button → closes onboarding, drops user into the History view (which is empty until the first save).
6. After onboarding completes, a system notification confirms: "AutoVersion is now protecting *<folder name>*."

#### Main UI layout

After onboarding, the window is a three-pane layout with a left sidebar:

```
┌───────────────────────────────────────────────────────────┐
│ [Sidebar]   │ [File list]      │ [Diff viewer]            │
│             │                  │                          │
│ • Folders   │ Files in folder  │ Selected snapshot diff   │
│ • Settings  │ + their version  │ vs. previous (or current │
│ • About     │   timeline       │ vs. selected)            │
└───────────────────────────────────────────────────────────┘
```

**Sidebar** — navigation between *Folders*, *Settings*, *About*. Persistent.

**File list pane** — for the selected folder, a tree of every file that has ever been snapshotted. Each file expands to show its timeline of snapshots (newest first), with relative timestamps ("2 minutes ago", "yesterday at 3:14 PM", "March 5"). Active file is highlighted. The pane updates live when a `snapshot-created` event fires.

**Diff viewer pane** — when a snapshot is selected, shows the diff against the immediately preceding snapshot by default. A small dropdown at the top lets the user compare against: *Previous version*, *Current file on disk*, or *Pick another version…*. Below the dropdown: the rendered diff (text, docx, or metadata-only fallback per the format registry). A persistent **Restore this version** button at the top right.

#### Settings page

Accessed from the sidebar. Sections:

**(a) Watched folders.** A card per folder showing path, file selection rules (see below), enable/disable toggle, and a remove button. Bottom of section: **Add folder** button.

**(b) Per-folder file selection** — clicking a folder card opens a sub-panel:
- *What to include* — list of extensions (chips). Add by typing, remove with the × button. Special chip *Everything* matches all files.
- *What to ignore* — list of glob patterns the user can edit (chips). Defaults are populated from the format registry for the selected extensions, but the user can add their own (e.g. `drafts/*`, `*.backup`, `Untitled*.docx`). Built-in registry patterns are shown grayed-out and labeled "built-in" so the user knows they're not editable but understands they're active.
- Live preview: "This folder currently contains 12 files matching your rules. 3 files are ignored: …" — helps the user verify their patterns before saving.

**(c) Global settings**
- Start at login (toggle).
- Retention policy (dropdown: *Keep everything* / *Thin after 30 days* / *Thin after 7 days* / *Custom…*).
- Snapshot storage: global default parent directory and per-folder overrides (with optional move of existing repos, and "Reveal in Finder").
- Storage used (auto-calculated, e.g. "147 MB across 3 folders").

**(d) Pause / resume watching** — a global toggle, also accessible from the menu bar right-click. When paused, the menu bar icon dims and the watcher does nothing. State persists across restarts.

#### Restore flow

1. User clicks **Restore this version** in the diff viewer.
2. Modal appears: "Replace *<filename>* with the version from *<timestamp>*? The current file will be saved as a new snapshot first, so nothing is lost."
3. Buttons: *Cancel* (default focus) and *Restore*.
4. On confirm: backend emits a `snapshot-created` event for the current state, writes the chosen version back to disk, emits a `restore-completed` event. UI shows a transient toast: "Restored. New snapshot saved at *<timestamp>*."

If the file is currently open in another app (Word, an editor), the restore still writes to disk — but the user is warned in the modal: "*<filename>* is currently open in Word. Close it before restoring, or your changes there may overwrite the restored version."

#### Empty states

- No folders yet → onboarding screen.
- Folder selected, no files yet snapshotted → "No saves yet. As soon as a watched file is changed, it will appear here."
- File selected, only one snapshot → diff viewer shows: "This is the only saved version of this file." with the rendered file content (no diff, just preview).

#### Live updates

The UI listens for `snapshot-created` and `watcher-error` events and updates the file list, timelines, and status indicators live without requiring a refresh. Newly created snapshots animate briefly (subtle highlight that fades over 2 seconds) so the user can see when versioning is happening.

#### Libraries

- **Tailwind CSS v4** (`tailwindcss`, `@tailwindcss/vite`) — utility-first styling integrated with Vite.
- **shadcn/ui** — Radix-based primitives generated into the repo (`src/components/ui/`). Chosen over hand-rolled-only Tailwind for accessible, consistent buttons/modals/toggles/chips while keeping components as owned source (not an opaque design-system package).
- `@git-diff-view/react` — diff rendering with GitHub-style UI, split/unified views, syntax highlighting, dark mode, and Web Worker support for large files. Actively maintained, modern API, accepts two file contents directly (no git-diff-text intermediate). This is the diff renderer for `Text` mode and the inner renderer used by the docx mode after content extraction.
- `diff` (jsdiff) — the underlying diffing primitives. `@git-diff-view/react` handles most cases; we only reach for `diff` directly when we need word-level diffing inside the docx renderer (after mammoth extracts plain text from each version).
- `mammoth` — docx → plain text / HTML for the docx renderer.
- `date-fns` — relative timestamps ("2 minutes ago").

We deliberately do NOT use Monaco Diff Editor: it adds 10-20 MB to the bundle (compared to ~600 KB for a baseline Tauri app), needs special Vite plugin configuration, and offers no diff-quality benefit over `@git-diff-view/react` for our use case.

We also deliberately do NOT use `react-diff-viewer-continued`: it's a fork of an unmaintained 6-year-old library, kept alive mostly through dependency updates. `@git-diff-view/react` is purpose-built, actively developed, and has better performance characteristics on long files (which thesis chapters become).

### 4. Tauri Commands (the IPC surface)

The config model:

```rust
struct Config {
    watched_folders: Vec<WatchedFolder>,
    start_at_login: bool,
    retention_policy: RetentionPolicy,
    default_snapshot_root: Option<PathBuf>, // parent dir for repos without per-folder override
}

struct WatchedFolder {
    id: String,                 // stable hash of path, used everywhere
    path: PathBuf,
    extensions: Vec<String>,    // e.g. ["docx", "md"]; empty means "everything"
    user_ignore_patterns: Vec<String>,  // user-defined globs (in addition to built-in)
    enabled: bool,
    snapshot_root_override: Option<PathBuf>, // parent dir for this folder’s `<id>/` repo
}
```

The watcher's actual ignore filter for a folder is `universal_patterns ∪ format_registry_patterns(extensions) ∪ user_ignore_patterns`. The user can add but not remove built-in patterns.

```rust
// Config
get_config() -> Config
set_config(config: Config) -> ()  // persists disk + in-memory; syncs start_at_login to OS via tauri-plugin-autostart (LaunchAgent on macOS)
add_watched_folder(path: String, extensions: Vec<String>) -> WatchedFolder
update_watched_folder(id: String, patch: WatchedFolderPatch) -> WatchedFolder
remove_watched_folder(id: String) -> ()
get_system_snapshot_parent() -> String   // built-in default repos parent (canonical)
set_default_snapshot_root(new_root: Option<String>, move_existing: bool) -> ()
set_folder_snapshot_root(folder_id: String, new_root: Option<String>, move_existing: bool) -> WatchedFolder
delete_folder_snapshots(folder_id: String) -> ()   // removes `<parent>/<id>/` for that folder only

// Pattern preview (for the settings UI's "live preview")
preview_folder_matches(id: String) -> FolderMatchPreview
// Returns: { matched: Vec<String>, ignored: Vec<(String, IgnoreReason)> }

// History
list_watched_files(folder_id: String) -> Vec<FileEntry>
list_snapshots(folder_id: String, relative_path: String) -> Vec<Snapshot>
get_snapshot_content(folder_id: String, commit_sha: String, relative_path: String) -> Vec<u8>
get_current_content(folder_id: String, relative_path: String) -> Vec<u8>

// Actions
restore_snapshot(folder_id: String, commit_sha: String, relative_path: String) -> ()
trigger_manual_snapshot(folder_id: String, relative_path: String) -> ()
pause_watching() -> ()
resume_watching() -> ()

// Status
get_status() -> Status  // last snapshot time per folder, watcher health, paused state
get_storage_usage() -> StorageUsage  // bytes per folder + total
```

Events emitted from backend → frontend:
- `snapshot-created` `{ folder_id, relative_path, commit_sha, timestamp }`
- `watcher-error` `{ folder_id, message }`
- `restore-completed` `{ folder_id, relative_path, restored_from_sha }`
- `config-changed` `{ }` — fired whenever config is updated (the watcher reloads).

## File format handling

The system is format-agnostic at its core but needs format-specific knowledge in two narrow places. Both live in a single registry so the rules are easy to find and extend.

### The registry

A single source of truth in `src-tauri/src/formats.rs` (Rust side) and a mirror in `src/lib/formats.ts` (frontend side, for the diff viewer). Each entry describes one file format:

```rust
pub struct FormatHandler {
    pub extensions: &'static [&'static str],   // e.g. ["docx"], ["md", "markdown"]
    pub ignore_patterns: &'static [&'static str], // glob patterns for sidecar/lock/temp files
    pub diff_kind: DiffKind,                   // Text, Docx, OpaqueBinary
    pub display_name: &'static str,            // "Microsoft Word", "Markdown"
}
```

Built-in handlers (v1):
- **Word (`.docx`)** — ignore `~$*.docx` (Word lock files), `.~lock.*.docx#` (LibreOffice), `*.docx.tmp`. Diff kind: `Docx` (mammoth + word-level diff in the frontend).
- **Markdown (`.md`, `.markdown`)** — ignore `*.md.swp`, `*.md~`. Diff kind: `Text`.
- **Plain text (`.txt`)** — ignore `*.txt.swp`, `*.txt~`. Diff kind: `Text`.
- **LaTeX (`.tex`)** — ignore `*.aux`, `*.log`, `*.synctex.gz`, `*.toc`, `*.out`, `*.bbl`, `*.blg`, `*.fls`, `*.fdb_latexmk` (LaTeX build artifacts; user typically only watches `.tex` so these aren't snapshotted, but list them defensively in case the user adds `*` as an extension). Diff kind: `Text`.
- **Source code (catch-all for `.py`, `.js`, `.ts`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.rb`, etc.)** — ignore `*.swp`, `*.swo`, `*~`, `.#*`, `*.orig`. Diff kind: `Text`.
- **Catch-all / unknown** — ignore the universal patterns below. Diff kind: `OpaqueBinary` (metadata only).

Universal ignore patterns applied regardless of format:
- `.DS_Store`, `Thumbs.db`, `desktop.ini` — OS metadata.
- `.~lock.*` — generic LibreOffice lock prefix.
- Anything starting with `.` and ending with `.swp`, `.swo`, `.swn` — vim swap files.
- `*~` — Emacs/vim backup files.
- Any path component starting with `.git`, `.svn`, `.hg` — VCS internals.

### What the registry is used for

1. **Watcher ignore filter.** Before debouncing, the watcher checks the path against three sources of ignore patterns: the universal patterns (always applied), the patterns for the file's matched format from the registry, and the user's per-folder custom patterns from config. If any match, the event is dropped silently. The user can add patterns but cannot remove built-in ones — those represent things we *know* are not user content.

2. **Diff viewer dispatch.** When the user opens a snapshot diff, the frontend looks up the file's extension in the registry, finds the `diff_kind`, and renders accordingly. Unknown extensions fall through to `OpaqueBinary` which shows metadata only.

The registry does NOT affect the snapshot store, the watcher's debouncer, the hashing/dedup logic, or the restore flow. Adding a new format means adding one struct entry. It never means modifying core logic.

### Adding a new format later

To add support for, say, `.pages` (Apple Pages):
1. Add a `FormatHandler` entry to `formats.rs` with the right ignore patterns (Pages writes `.pages.tmp` and uses bundle-style packages — investigate before adding).
2. If you want a real diff (not just metadata), add a `DiffKind::Pages` variant and a frontend renderer for it.
3. That's it. No watcher changes, no storage changes, no command changes.

## Critical Edge Cases

These are the things that will bite you if not handled. Several are format-specific — they come from how particular editors interact with the file system, not from any inherent property of the format.

1. **Word's atomic save dance (docx).** Word writes a temp file, renames the original to a backup (`~$file.docx`), renames temp to original, deletes the backup. The watcher will see CREATE / RENAME / DELETE / MODIFY events in rapid succession. The 2-second debounce + the `~$*.docx` ignore pattern together solve this — wait until the dust settles, then snapshot whatever ends up at the watched path.

2. **Word lock files survive crashes.** If Word crashes, `~$file.docx` can be left behind. Our ignore pattern means we don't snapshot it, but be aware it exists in the folder — don't get confused by it during debugging.

3. **vim/emacs swap and backup files.** `vim` writes `.file.swp` while editing and `file~` on save (depending on settings). Covered by the universal ignore patterns. If a user opens a docx with a hex editor in vim (cursed, but possible), our universal patterns still catch the swap file.

4. **JetBrains and VS Code "safe write."** They write to a temp file then rename. Same as Word's dance, same solution: debounce handles it.

5. **iCloud / Dropbox folders.** If the watched folder is synced, files may "download" and trigger events without user action. Compare content hash to the latest snapshot — if identical, do nothing. Already covered by the dedup step. Format doesn't matter here.

6. **File not present at debounce time.** If the file was deleted (or moved out and back), the snapshot step should handle "file does not exist" gracefully and record a tombstone snapshot (an empty commit with a "deleted" message) so the timeline reflects reality and the user can restore from the previous snapshot.

7. **Large files / many simultaneous changes.** A thesis is fine, but if someone points this at their Downloads folder, the repo grows fast. Enforce a max file size per snapshot (e.g. 50MB, configurable). Skip and warn above that. This matters more for binary formats (videos, images, large PDFs) than text.

8. **Bundle-style "files" on macOS.** Some macOS document formats (`.pages`, `.numbers`, `.key`, Xcode `.xcodeproj`) are actually directories that Finder displays as a single file. If we ever support these, the watcher and snapshot logic need different handling (recursive copy, not single-file copy). Out of scope for v1 — mention this as a known limitation.

9. **First-run UX.** When the app starts, the user sees nothing happen. Add an onboarding flow: "Welcome — pick a folder to protect" → folder picker → done. Show a non-intrusive notification on the first auto-snapshot so the user knows it's working.

10. **Permission prompts.** macOS will prompt for Full Disk Access or folder access depending on the location. Document this and surface a clear error if access is denied (the watcher will fail silently otherwise).

11. **App not running = no protection.** Make this obvious. The menu bar icon should change state if the watcher is paused or has errored. "Start at login" should default to ON during onboarding.

## Recommended Build Order

1. Tauri scaffold with menu bar icon, hidden main window, `ActivationPolicy::Accessory`.
2. Config storage (load/save to JSON), basic IPC commands for `get_config` / `set_config` / `add_watched_folder` / `remove_watched_folder`.
3. The format registry (Rust + TS), with built-in handlers for docx, markdown, plain text, and source code. Just data and lookup functions, no behavior wired up yet.
4. File watcher + debouncer + ignore-pattern filter (uses the registry from step 3, plus user patterns from config). Log events to console — verify the right events fire for Word, vim, VS Code saves.
5. Git-based snapshot store. Verify snapshots accumulate and dedup by hash.
6. Onboarding screen — folder picker + extension presets + start-at-login toggle.
7. Settings page — folder list, add/remove folders, per-folder extension and user ignore-pattern editor with live preview.
8. History view — file list pane + snapshot timeline. No diffing yet.
9. Diff viewer dispatcher: hook up `Text` and `OpaqueBinary` renderers. Most file types now show sensible diffs.
10. `Docx` renderer (mammoth + word-level diff).
11. Restore flow with confirmation modal.
12. Live updates (event listeners), menu bar icon state changes, pause/resume.
13. Polish, packaging (`pnpm tauri build`).

## Distribution

Personal-use tool, no App Store, no paid signing certificate. Release bundles use **ad-hoc code signing** (`signingIdentity: "-"`) so Gatekeeper on Apple Silicon does not falsely report the app as “damaged.”

- `pnpm tauri build` produces a `.app` and `.dmg` in `src-tauri/target/release/bundle/`.
- Install by dragging the `.app` to `/Applications`, or just run from anywhere.
- First launch: Gatekeeper treats the app as from an unidentified developer — use right-click → Open. If a browser added quarantine and the app still refuses to open, run `xattr -cr /Applications/AutoVersion.app` in Terminal.
- No auto-update mechanism. New versions = rebuild and reinstall manually.

This is a deliberate tradeoff: zero ongoing cost and zero account setup, in exchange for a one-time "right-click to open" step on install.

