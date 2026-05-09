# AutoVersion

macOS menu-bar app (Tauri 2) that snapshots watched files into hidden per-folder git repos.

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm build
pnpm tauri build
```

Artifacts: `src-tauri/target/release/bundle/` (`.app`, `.dmg`).

## Gatekeeper (unsigned)

On first launch, macOS may block the app. Either **right-click → Open**, or run:

```bash
xattr -cr /Applications/AutoVersion.app
```

## Config & data

- Config: `~/Library/Application Support/AutoVersion/config.json`
- Snapshot repos: `~/Library/Application Support/AutoVersion/repos/<folder-id>/`
- Logs: `~/Library/Logs/AutoVersion/autoversion.log`

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — product / system design
- [AGENTS.md](AGENTS.md) — contributor / agent workflow
