# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-07-26

### Added
- **In-app shell overlay** (`!`) — a persistent `$SHELL` pane for `aws sso login`,
  `git`, `kubectl`, etc. without leaving mc. `Ctrl+Q` closes; every other key
  forwards to the shell. Hardened against the freeze / can't-exit class.
- **Opt-in heap instrumentation** for diagnosing long-uptime memory growth:
  `MC_HEAP_LOG=1` logs rss/heap + per-structure counts every 60 s to
  `~/.local/state/claude-mc/heap/`; `kill -USR2 <pid>` writes a heap snapshot
  on demand. Inert in normal use.

### Changed
- **Zoom revive-on-zoom**: zooming/resuming a session whose PTY is mid-restart
  now revives it instead of throwing `attachZoomView: agent.pty not running`
  (the reported `:resume-all` failure). A deliberately-killed slot still refuses.
- **Reliability**: swallow `SIGTSTP` so `Ctrl+Z` can't strand the fleet; the
  terminal bell is gated to the zoomed agent (no more background-agent screen
  flash); fleet re-renders are coalesced for lower idle CPU/battery.
- **Metrics accuracy**: tok/min excludes cache reads (was inflated ~100×);
  weekly cost is no longer duplicated per card; token/cost totals reset on
  `/clear`.
- **Memory hygiene**: bounded the `_usageByMsg` and `pendingSubagents` maps so
  they stay flat across long no-`/clear` sessions.
- Removed the 200k cap on the context-window warning threshold.

## [1.0.0] — 2026-07-26

First public open-source release.

### Added
- **Matrix** green-phosphor theme, selectable in Settings → Colors or via
  `:theme matrix`. BlueArch remains the default palette.
- `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and a PR
  template for open-source contribution.
- npm packaging as the scoped public package `@bluearch/mission-control`
  (`npx @bluearch/mission-control`), with a `files` allowlist so only runtime
  code ships.
- CI dependency-audit job (`npm audit`).

### Changed
- Hardened hook-settings command construction to quote executable/emitter paths
  (safe under install directories containing spaces).

### Notes
- Everything runs locally: no telemetry, no network service, no account beyond
  your own Claude authentication.
