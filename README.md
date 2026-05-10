# AutoVersion

A macOS menu-bar app that auto-snapshots your files into hidden per-folder git repos. Every save becomes a recoverable version, with diffs and one-click restore. Built for non-technical users (think: writing a thesis in Word while an AI agent edits the same file).

> macOS only. Tauri 2 (Rust) + React + TypeScript.

## Why

- Works with **any file type** — `.docx`, `.md`, `.tex`, `.py`, anything.
- **No git knowledge required.** The user never sees a commit.
- **Format-aware diffs** for Word documents, Markdown, code, etc.
- Lives in the menu bar.

## Develop

Requires [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

Outputs `.app` and `.dmg` in `src-tauri/target/release/bundle/`. Drag the `.app` to `/Applications`.

The app is **unsigned** (`signingIdentity: null` in [`tauri.conf.json`](src-tauri/tauri.conf.json)) — empirically this is friendlier than ad-hoc signing on current macOS, which can produce a "damaged" Gatekeeper prompt. On first launch:

- Right-click the app → **Open** → Open again. macOS remembers your choice.

If you do see "damaged and can't be opened", remove the quarantine flag manually:

```bash
xattr -cr /Applications/AutoVersion.app
open /Applications/AutoVersion.app
```

## Where things live

| | |
|---|---|
| Config | `~/Library/Application Support/AutoVersion/config.json` |
| Snapshots | `~/Library/Application Support/AutoVersion/repos/<folder-id>/` |
| Logs | `~/Library/Logs/AutoVersion/autoversion.log` |
| Start at login (when enabled) | `~/Library/LaunchAgents/io.autoversion.plist` (LaunchAgent installed by `tauri-plugin-autostart`) |

Snapshots are stored as real git repos via `libgit2` — no `git` binary required on the host.

### Start at login (macOS)

Turn **Start AutoVersion automatically when I log in** on in **Settings** (or during the first-run wizard). AutoVersion then enables its LaunchAgent. Recent macOS versions often surface that as a notification titled **App Background Activity** (“can run in the background… Login Items & Extensions”) rather than literally saying “starts at login”—that banner still means the registration succeeded. Check **System Settings → General → Login Items & Extensions** (or **Login Items**) to see the entry; the list may show the **binary name** (`autoversion`) from the Rust package, not the window title “AutoVersion”. Confirming it worked: that settings entry exists and/or the plist file above is present. Turn the option off in Settings to remove the LaunchAgent.

## Stack

Tauri 2 · `notify` + `notify-debouncer-full` · `git2` (vendored libgit2) · React 18 · Tailwind v4 · shadcn/ui · `@git-diff-view/react` · `mammoth`

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — design, IPC surface, edge cases
- [`AGENTS.md`](AGENTS.md) — contributor + agent workflow
- [`CHANGELOG.md`](CHANGELOG.md)

## License

[MIT](LICENSE) © Gabriel Menezes
