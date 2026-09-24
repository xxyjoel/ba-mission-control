# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] — 2026-09-24

### Fixed
- Release CI: wait for Settings disconnect re-probe; skip hung characterize
  pins under CI (macOS · node 20 wall-clock).

## [1.2.0] — 2026-09-24

### Added
- **Subscriptions — run Cursor next to Claude.** Settings → SUBSCRIPTIONS
  connects Cursor (`cursor-agent`); New Session picks a provider when two are
  enabled; a Cursor slot zooms into the real interactive Cursor TUI. Same
  fleet grid and card shape; cost/tokens stay honestly unmeasured (`$-.--` /
  `-`) until optional usage sync.
- **Per-subscription Aggregate / Header** when more than one provider is on —
  each row keeps its own plan meters; nothing is blended across vendors.

### Fixed
- **Zoom/Card `ctx ?%` and missing model chip after resume.** Launch/`resume`
  often stores a CLI id (`claude-opus-5`) as `model`; resolve that back to the
  catalog so maxCtx and `[OPUS …]` render.
- **`:resume-all` looked like a crash when Claude held a “background session”.**
  Claude 2.1.273 says `background session` (not only `background agent`); the
  refusal classifier now matches and tips `claude stop <id>` instead of
  auto-restarting into the same refusal.

## [1.1.17] — 2026-09-21

1.1.16 never published either — its macOS job wedged and GitHub killed it at the
six-hour cap, so the run is recorded as cancelled and named no file.

### Fixed
- **The zoom view and the card showed different status for one session.** The
  card renders the DERIVED status from the fleet snapshot; zoom rendered the
  live agent instance, where `.status` is only the connector's opinion and the
  hook feed, approval scrape and freshness gates have not been applied. They
  disagreed exactly when the derivation overrode the connector, which is the
  reason the derivation exists. Reported four times as "says WORKING in zoom,
  says IDLE in the fleet view".
- **Scrolling back in the zoom view went dead after the pane changed height.**
  1.1.15 stopped a resize throwing a scrolled-back reader to the bottom, but
  left the scroll-back counter measured in the old geometry. Shrinking the pane
  opened phantom room that key presses were spent on, while the renderer
  ignores that region once you are scrolled back — so N presses moved the
  counter and no rows, where N is the number of rows the pane lost. The trigger
  needs no keystroke: a toast landing or claude editing its todo list resizes
  the pane under you.
- **A wedged test file could burn a whole release.** The runner used a
  sequential `spawnSync` with no timeout, so one file that never exits stopped
  the suite indefinitely. Each file now gets a five minute wall clock and a
  timeout is reported by name.

### Changed
- **The card's title row shows one status word.** It used to carry a second one
  for background work, in a different colour, which left a reader unable to tell
  which described the session. Background work is now listed in the body row
  with the sub-agents: `⋔3 agents running`, or `⋔ background agents running`
  when the server can see work it cannot count.

### Known
- Scrolling back through history is still limited by what the terminal emulator
  retains, and claude repaints its frame in place rather than letting lines
  scroll off, so little accumulates during normal operation. Measured: 120 lines
  of output left the buffer at its starting size. Sourcing history from the
  session transcript instead is a design change, not a patch.

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
