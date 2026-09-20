# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.16] — 2026-09-20

1.1.15 never published. Its release failed on two tests that pass on a
developer machine and cannot pass on a headless runner.

### Fixed
- **Colour-dependent assertions no longer depend on the environment.** The
  ShellOverlay tests locate the cursor by the background colour it is painted
  in. chalk picks its colour level once, at import, from the environment:
  truecolor on a terminal, and none at all on a CI runner with no TTY — so a
  correct frame carried no escape to match and the assertion failed. The fix
  pins the level inside the test rather than widening what it matches. A first
  attempt widened the matcher to the 16-colour palette and appeared to work,
  because the author's shell exports FORCE_COLOR=3 and the simulated CI run
  therefore still had colour. Verified with FORCE_COLOR unset: 156 files, 1096
  tests, 0 failures.

## [1.1.15] — 2026-09-20

Correctness pass on the things the fleet view was quietly getting wrong, and an
audit of the npm page against the code.

Entries for 1.1.2 through 1.1.14 were never written; the git log is the record
for those.

### Fixed
- **The fleet log was empty after every resume or restart.** Attaching to a
  session replayed the last 256 KiB of its transcript into a scratch object and
  threw the parsed tail away, then moved the read offset past it. Four earlier
  commits enlarged the ring buffer from 16 entries to 320; the ring they
  enlarged was empty.
- **Background agents started by a workflow were never counted.** The usage scan
  listed one directory. Claude Code writes workflow sub-agents to
  `subagents/workflows/<runId>/`, one level deeper. Measured on a live session:
  20 files seen, 60 skipped. Their token spend was never folded into the parent
  either, so fan-out sessions under-reported their cost.
- **A restart destroyed the terminal scrollback,** so the zoom view had nothing
  to scroll. `start()` disposed the emulator and built a new one every time it
  ran, including on auto-restart, model change and permission change.
- **PageUp and PageDown stopped reaching a pager** in the `!` shell overlay. The
  keys were intercepted and never forwarded, and on the alternate screen there
  is no scrollback to move, so inside `less`, `man` or `vim` they did nothing at
  all. Neither view checked which buffer the child was on.
- **A resize threw a scrolled-back reader to the bottom** of the zoom view. The
  row count changes whenever a panel opens, so reading history was interrupted
  by an unrelated toast.
- **The card's session clock measured the wrong thing.** It read how long
  Mission Control had held the agent object, so sessions launched together all
  showed the same value and a conversation days old rendered as minutes. It now
  reads the first timestamp in the session transcript.
- **Hiding the fleet log did not return its rows to the grid.** The
  `showFleetLog` setting never reached the layout, which charged its full line
  count either way. The `[` and `]` pane keys read the same wrong page size.
- **The cursor painted on the wrong row** when the shell overlay was scrolled
  back, comparing a window index against a buffer-relative row.

### Changed
- The background chip on the card no longer repeats the agent count that the row
  below it already shows. The label stays, because it is the only thing on the
  card that distinguishes background work when the count is unknown.
- README and package metadata corrected against the code. Costs are computed
  from token counts against a rate table, not read from a field the default path
  does not emit; the fleet ceiling is 64, not 10; the architecture section
  described a rollback path as if it were the default. Seven palettes, not six.

### Removed
- forge is no longer wired into this repository.

## [1.1.1] — 2026-07-27

Stability + release-integrity patch.

### Fixed
- **`!` shell overlay no longer crashes the app.** On hosts where node-pty's
  prebuilt `spawn-helper` lost its executable bit (npm/npx skip the `postinstall`
  that chmods it), `pty.spawn` threw `posix_spawnp failed` out of a React effect
  and took down the whole TUI. Now: (a) the helper is chmod'd **at runtime on
  boot** (not just postinstall), fixing the root cause for `npx`/global installs;
  (b) `getShellSession` catches the spawn and shows an error banner instead of
  throwing; (c) `resolveShell()` falls back through `[$SHELL, /bin/bash, /bin/sh]`.
- **Global crash net:** an uncaught exception now restores the terminal and exits
  cleanly with a report pointer, instead of dumping a raw stack over the alt-screen.

### Added
- `npm run start:diag` — instrumented launch (`MC_HEAP_LOG` + heap-snapshot at the
  ceiling) to capture the long-uptime OOM under investigation.
- **Release pipeline:** tag-driven, CI-published, provenance-signed
  (`.github/workflows/release.yml`) so the published npm build is verifiably the
  tested, tagged commit. See `RELEASING.md`.

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
