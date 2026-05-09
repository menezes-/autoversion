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

Outputs `.app` and `.dmg` in `src-tauri/target/release/bundle/`. Drag the `.app` to `/Applications`. On first launch macOS will block it (unsigned build) — right-click → Open, or:

```bash
xattr -cr /Applications/AutoVersion.app
```

## Where things live

| | |
|---|---|
| Config | `~/Library/Application Support/AutoVersion/config.json` |
| Snapshots | `~/Library/Application Support/AutoVersion/repos/<folder-id>/` |
| Logs | `~/Library/Logs/AutoVersion/autoversion.log` |

Snapshots are stored as real git repos via `libgit2` — no `git` binary required on the host.

## Stack

Tauri 2 · `notify` + `notify-debouncer-full` · `git2` (vendored libgit2) · React 18 · Tailwind v4 · shadcn/ui · `@git-diff-view/react` · `mammoth`

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — design, IPC surface, edge cases
- [`AGENTS.md`](AGENTS.md) — contributor + agent workflow
- [`CHANGELOG.md`](CHANGELOG.md)

## License

[MIT](LICENSE) © Gabriel Menezes
