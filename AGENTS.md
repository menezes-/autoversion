# AGENTS.md — AutoVersion

Coding handbook for AI agents on this project. Read `ARCHITECTURE.md` for *what* to build; this file is *how* to work.

## Stack

- **Tauri 2** (pinned exact patch — see [Pinned versions](#pinned-versions)), Rust backend, React + TypeScript + Vite frontend.
- **Tailwind CSS v4** (`tailwindcss` + `@tailwindcss/vite`) for styling.
- **shadcn/ui** — Radix-based components generated into `src/components/ui/` (we own the source; polished primitives without shipping a heavy design-system bundle as a black box).
- **Diff / time / docx (frontend):** `@git-diff-view/react`, `mammoth`, `diff` (jsdiff), `date-fns`.
- **macOS only.** No cross-platform conditionals.
- **Package manager: pnpm.** Do not use `npm` or `npx` in docs or scripts; use `pnpm` / `pnpm dlx`.
- Project layout: `src/` (frontend), `src-tauri/src/` (backend), `src-tauri/capabilities/` (Tauri ACL).

## Workflow

1. Follow the build order in `ARCHITECTURE.md`. **Stop after each numbered step**, verify with `pnpm tauri dev`, report back. Never implement multiple steps in one shot.
2. Verify with `pnpm tauri dev`, not `cargo build` alone.
3. Before any commit: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `pnpm build`.
4. Update `CHANGELOG.md` per milestone with what changed and any caveats.
5. If `ARCHITECTURE.md` and reality diverge during implementation, update the doc and flag the change.

## Definition of done (per milestone)

1. `pnpm tauri build` succeeds with no warnings (or only documented ones).
2. The manual test checklist below passes for the relevant scope.
3. `ARCHITECTURE.md` matches what was built.
4. `CHANGELOG.md` updated.

## Manual test checklist

Run the subset relevant to the current milestone. Use `pnpm tauri dev` for interactive verification.

1. Save a `.docx` in Word — exactly one snapshot appears (not 10).
2. Save the same file with no changes — no new snapshot.
3. Edit a `.md` file in any text editor — one snapshot, text diff renders.
4. Edit a source file (`.py`, `.ts`) — one snapshot, text diff renders.
5. Drop a file with a random extension (`.xyz`) — snapshot created, metadata-only fallback shown, no crash.
6. Quit and reopen — config and history persist.
7. Restore an old snapshot — current state is snapshotted first, then file is replaced.
8. Delete a watched file — tombstone recorded; restore brings it back.
9. With a vim swap file (`.file.docx.swp`) in the folder, save the docx — swap file is NOT snapshotted.

For docx-related milestones, test against real Word, not `echo "x" > file.docx`. The save behavior is the whole point of the debouncer.

## Code style

**Rust**
- `anyhow::Result` for app-level errors; `thiserror` for typed errors on public module APIs.
- No `unwrap()` / `expect()` / `panic!` on file I/O, git, or user input. Propagate errors.
- `tracing` for logs (not `println!`), output to `~/Library/Logs/AutoVersion/autoversion.log`.
- Async only where Tauri requires it. The watcher runs on a regular thread.
- Files over ~300 lines should be split.

**TypeScript**
- Strict mode. No `any` without an inline comment justifying it.
- All Tauri `invoke` calls go through a typed wrapper module (`src/lib/tauri.ts`). Don't sprinkle `invoke()` across components.
- Functional components and hooks only.
- Tailwind utilities inline. Custom CSS only when genuinely needed (e.g. diff viewer).

**Both**
- Names describe intent: `snapshot_file`, not `do_git_commit`.
- Comments explain *why*, not *what*.

## Tauri specifics

### Commands
- Organize by topic in `src-tauri/src/commands/*.rs`. Register all in one `generate_handler!` in `lib.rs` (or `main.rs` if preferred — keep one place).
- All commands return `Result<T, AppError>`. Define `AppError` in `src-tauri/src/error.rs` with `thiserror` + manual `serde::Serialize` impl.
- Async commands are the default. snake_case names, identical on both sides of the IPC.
- For each new Rust command, add the typed TS wrapper in the same change.

### State
- Default to `std::sync::Mutex`, NOT `tokio::sync::Mutex` / `tauri::async_runtime::Mutex`. Only use the async one if you must hold the lock across an `.await`.
- Don't wrap state in `Arc` manually — Tauri does this for you.
- Register with `app.manage(Mutex::new(...))` in `setup`. Access via `State<'_, Mutex<T>>`.
- The `State<'_, T>` parameter type must exactly match what was registered, or you get a runtime panic (not a compile error).
- For background threads, pass `AppHandle` (cheap to clone) and call `app_handle.state::<Mutex<T>>()` inside the thread. Never pass `State` directly to a thread.

### Capabilities (ACL)
- Files in `src-tauri/capabilities/` are auto-enabled. Default file is `default.json`.
- **Adding a plugin requires also adding its permission to a capability file.** This is the #1 source of "why isn't it working" — the call fails at runtime with a vague "not allowed" error.
- Grant the minimum. The user's watched folders are accessed only from Rust, so the `fs` plugin permission is NOT needed.
- Per-window capability files for narrower permission scopes if we add a second window.

### Events
- `app_handle.emit("event-name", payload)` for backend → frontend updates.
- Payloads: `#[derive(Clone, Serialize)]` structs in `src-tauri/src/events.rs`, mirrored as TS types in `src/lib/events.ts`.
- Frontend: `import { listen } from '@tauri-apps/api/event'`. Always unsubscribe in `useEffect` cleanups (HMR otherwise leaks listeners).

### Window / menu bar
- `app.windows[0].visible: false` in `tauri.conf.json` — window doesn't pop on launch.
- `app.set_activation_policy(tauri::ActivationPolicy::Accessory)` in setup — hides dock icon for true menu-bar-only behavior.
- Window close → `window.hide()`, not actual close. Quit only via menu.
- **Bundle identifier** in `tauri.conf.json`: `io.autoversion` (reverse-DNS for autoversion.io; avoid an identifier ending in `.app`, which confuses macOS).

### Plugins to use
- `tauri-plugin-autostart` — start at login.
- `tauri-plugin-notification` — first-snapshot toast, error notifications.
- `tauri-plugin-dialog` — folder picker.
- File logging: `tracing` + `tracing-subscriber` to `~/Library/Logs/AutoVersion/autoversion.log` (no `tauri-plugin-log` — it conflicts with an already-installed global logger when tracing is initialized first).
- `tauri-plugin-single-instance` — prevent duplicate watchers.
- `tauri-plugin-opener` — "Reveal in Finder" (Settings); add when that UI ships.

Each plugin needs its permission added to a capability file. No exceptions.

### Dependency pinning

Pin Tauri and related crates/plugins to the **same minor** as the `tauri` crate. Mismatched versions cause cryptic build failures.

#### Pinned versions (canonical)

**Rust (`Cargo.toml`)**

```toml
tauri = { version = "=2.11.1", features = ["tray-icon", "image-png"] }
tauri-build = { version = "2.6", features = [] }

notify-debouncer-full = "0.5"
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2"] }
sha2 = "0.10"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
globset = "0.4"
dirs = "6"
chrono = { version = "0.4", features = ["serde"] }

tauri-plugin-autostart = "2"
tauri-plugin-notification = "2"
tauri-plugin-dialog = "2"
tauri-plugin-single-instance = "2"
tauri-plugin-opener = "2"
```

Adjust plugin patch versions in lockfile as needed; keep **`tauri` on `=2.11.1`** and **`tauri-build` on `2.6.x`** unless upgrading deliberately.

**JavaScript (`package.json`)**

- Pin `@tauri-apps/api` and `@tauri-apps/cli` to **2.11.0** (or the latest **2.11.x** published on npm — `2.11.1` may not exist for JS yet).
- **Core:** `react` ^18.3, `react-dom` ^18.3, `typescript` ~5.6, `vite` ^6, `@vitejs/plugin-react` ^4.
- **Styling:** `tailwindcss` ^4, `@tailwindcss/vite` ^4.
- **UI:** shadcn/ui (components under `src/components/ui/`), plus its peer deps (`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/*` as pulled in by generated components).
- **App libs:** `mammoth`, `@git-diff-view/react`, `diff`, `date-fns`.

**Tauri plugins → capability permissions (default window)**

Add each permission string to `src-tauri/capabilities/default.json` for the window(s) that need the API:

| Plugin | Example capability permission |
|--------|-------------------------------|
| autostart | `autostart:default` |
| notification | `notification:default` |
| dialog | `dialog:default` |
| single-instance | `single-instance:default` |
| opener | `opener:default` |

Grant only what the window uses. Regenerate schema if needed: `pnpm tauri permission add <plugin>:default`.

Personal use, no Apple Developer ID. `pnpm tauri build` produces `.app` and `.dmg`. In `tauri.conf.json`, set `bundle.macOS.signingIdentity` to `"-"` (ad-hoc code signing) so Apple Silicon Gatekeeper does not show the misleading “app is damaged” dialog for an actually valid bundle; do not add a `bundle.updater` block. First launch: right-click → Open; if the download was quarantined, `xattr -cr /Applications/AutoVersion.app`. Document both in the README for the end user.

`git2`: always use the `vendored-libgit2` feature so the binary is self-contained (no system `git`).

Don't upgrade Tauri mid-project unless fixing a specific bug.

### Frontend setup

- **Tailwind v4:** configure via `@tailwindcss/vite` in `vite.config.ts` and `@import "tailwindcss"` in the main CSS entry. No separate PostCSS config required for the default pipeline.
- **shadcn/ui:** initialize with `pnpm dlx shadcn@latest init` (not `npx`). Generated primitives live in `src/components/ui/`.
- **Icons / theme:** follow shadcn defaults unless the product spec says otherwise.

## Hard rules

- **Never panic in command handlers.** It crashes the entire app process.
- **Never block the main thread** with long-running sync work. Use `tauri::async_runtime::spawn` or `std::thread::spawn`.
- **Never delete files in the user's watched folder.** The hidden snapshot repo is fair game; user files are not.
- **Never shell out** to `git` or any other CLI. Use the corresponding Rust crate.
- **Never hardcode format checks** outside the format registry (`formats.rs` / `formats.ts`). See ARCHITECTURE.md.
- **Never use `tauri-plugin-shell`.** We don't need it; it widens the attack surface.
- **Never commit** secrets, signing keys, `.env` files, or generated build artifacts.

## Testing

- **Rust:** unit tests for pure logic (config parsing, hash dedup, path filtering, debounce logic if extracted). No integration tests for the watcher in v1 — they're flaky and high-cost.
- **Frontend:** no test framework in v1. Manual testing via `pnpm tauri dev`.

## When stuck

- File watcher acting weird → log raw events before the debouncer. Usually FSEvents coalescing or an editor's atomic-rename save.
- `git2` errors → confirm repo is initialized for that folder, working tree path matches repo path, default author is set.
- Tauri "not allowed" errors → check `capabilities/*.json` first.
- Tauri permission prompts on macOS → surface the error to the user, don't swallow it.

## Ask the human, don't guess

- New dependency over ~500KB or with a non-MIT/Apache license.
- Adding support for a file format beyond what's in the registry.
- Retention policy changes if storage gets large.
- Anything that touches the user's watched folder destructively.

## Distribution

Personal use, no Apple Developer ID. `pnpm tauri build` produces `.app` and `.dmg`. In `tauri.conf.json`, set `bundle.macOS.signingIdentity` to `"-"` (ad-hoc code signing) so Apple Silicon Gatekeeper does not show the misleading “app is damaged” dialog for an actually valid bundle; do not add a `bundle.updater` block. First launch: right-click → Open; if the download was quarantined, `xattr -cr /Applications/AutoVersion.app`. Document both in the README for the end user.
