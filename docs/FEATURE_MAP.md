# Feature map — ba-mission-control

A new-session orientation doc. Read this before opening a file you've
never touched.

Pairs with: `docs/HOTKEYS.md` (every key, with claude conflict
analysis), `CLAUDE.md` (workflow rules), and the deeper audits in
`docs/audit/` (snapshots — may be stale).

---

## What mc is

A keyboard-first terminal TUI that runs up to **10 real `claude` CLI
subprocesses** side-by-side in a grid. The product is "supervise the
fleet, drop into any agent at full Claude Code fidelity, never leave
the terminal."

Stack: Node 20+ · Ink (React for terminals) · `tsx` JSX runtime ·
**no build step** · ESM-only.

Boot: `bin/mc.mjs` → registers tsx loader → `tui/main.jsx` → renders
`<App/>` from `tui/App.jsx`. Shutdown wires through main.jsx.

---

## Major surfaces (where users live)

### Fleet view (default)

`tui/App.jsx` orchestrates. Components:
- `tui/Header.jsx` — top strip: cost, model, perm mode, day/week
- `tui/Aggregate.jsx` — fleet-level rollups
- `tui/Card.jsx` × 10 — one per slot (only non-empty slots render)
- `tui/FleetLog.jsx` — merged tail across agents
- `tui/StatusBar.jsx` — bottom strip: filter, command bar, hints

Sees fleet state via `fleet.snapshot()` + subscribes to `'change'`.

### Zoom modal (post-2026-06-17 refactor)

`tui/modals/Zoom.jsx` owns the chrome (header, OPEN TASKS, Ctrl+T tools
strip, Ctrl+S stats strip, footer). Its body is **a real
`claude --resume <sid>` PTY child**, blitted into Ink via
`@xterm/headless`. See `.claude/plans/we-are-still-having-parsed-parrot.md`
for the design and `tui/zoom/CAPABILITIES.md` for the VT/OSC capability
audit.

PTY surface lives in `tui/zoom/`:
- `PtyPane.jsx` — lifecycle, event-driven render, key dispatcher
- `ptyKeys.js` — Ink event → raw byte sequences
- `ptyCells.js` — xterm-headless cell grid → Ink `<Text>` runs

PTY entry/exit lifecycle in `server/zoomSession.mjs`:
1. Zoom entry → kill the stream-json sibling (suppress its auto-restart),
   spawn interactive `claude --resume <sid>` in node-pty
2. While zoomed → `server/sessionFileTailer.mjs` tails claude's session
   JSONL so `agent.todos` + `agent.tail` (user/asst/tool entries) stay
   live for the FleetLog
3. Zoom exit → kill PTY, `agent.start()` with `resuming=true` →
   stream-json sibling re-reads the JSONL and picks up where the PTY
   child left off

### Other modals

Each is one file in `tui/modals/`:
- `NewSession.jsx` — pick a repo (recents + fs browser via `RepoPicker.jsx`), choose model, launch
- `Broadcast.jsx` — send one message to N selected agents
- `Settings.jsx` — tabbed config UI driven by `tui/lib/settings.js` schema
- `Help.jsx` — hotkey reference (contextually highlighted by current view)
- `Dashboard.jsx` — sortable table of all live agents (slot/status/ctx/tpm/cost/age)
- `QuitConfirm.jsx` — modal between `q` and process exit
- `RepoPicker.jsx` — directory browser used by NewSession

### Command bar (`:verb arg`)

Inline at the bottom. Dispatched by `runCommand` in `App.jsx`. Verbs:

| Verb | Effect |
|---|---|
| `:model [default] <id>` | Switch focused agent's model (or fleet default) |
| `:perm [default] <mode>` | Switch focused permission mode (or default) |
| `:kill[!] [<slot>]` | Kill focused agent (`!` skips arm-press) |
| `:pause` / `:resume` | SIGSTOP / SIGCONT focused agent |
| `:note <text>` | Drop a local annotation into the agent's chat log |
| `:approve` / `:a` | Approve a pending tool call |
| `:resume <slot..>` / `:resume-all` | Restore one or all saved sessions |
| `:history [n]` | View rolling LITE memory of last N sessions |
| `:forget <slot>` | Drop a saved session record |
| `:sessions` / `:ls` | List saved sessions |
| `:tasks` / `:todo` / `:t` | Fetch GitHub Issues for focused repo via `gh` CLI |
| `:transcript` / `:tx` / `:log` | Show mc's own transcript path for focused agent |
| `:budget <usd>` | Set daily fleet-wide budget |
| `:cap <usd>` | Set per-slot cost cap |
| `:cost` | Show today / week cost |
| `:template <name>` | Launch a pre-baked template into next free slots |
| `:cap` / `:budget` / `:cost` | Cost surfaces |
| `:remember <text>` | Append to `<cwd>/.mc/MEMORY.md` (L2 plugin) |
| `:memory` | Show project memory contents |
| `:mcp` | List MCP servers from `~/.claude/.mcp.json` + project |
| `:debug-keys [on/off/clear/path]` | Toggle raw key recording (REC chip) |
| `:repos [clear]` | Pick repo scan folder |
| `:whoami` / `:auth` | Check signed-in claude account |
| `:version` / `:ver` | Show build (version, git sha, dirty?) |
| `:help` / `:?` | Open Help modal |

### Slash commands (inside Zoom composer — legacy, mostly delegated)

`/compact`, `/clear`, `/compact-restart` are mc-handled; everything else
(`/help`, `/resume`, `/btw`, …) is forwarded to claude and rendered by
the PTY child natively.

---

## Server / data layer (`server/`)

| File | Role |
|---|---|
| `fleet.mjs` | EventEmitter + 10-slot registry; `launch()`, `resume()`, `kill()`, `broadcast()`, `snapshot()` |
| `agent.mjs` | One claude subprocess per slot; stream-json parser, auto-restart with backoff, transcript writer, SIGSTOP/SIGCONT pause, cost tracking |
| `mockAgent.mjs` | Fixture-driven replay for offline dev (`MC_USE_MOCK=1`) |
| `git.mjs` | Branch / ahead / behind / dirty status via argv-form `execFile` |
| `repos.mjs` | Discover candidate repos under configured parents |
| `zoomSession.mjs` | PTY lifecycle for Zoom (post-2026-06-17) — kill sibling, spawn PTY, respawn sibling on exit |
| `sessionFileTailer.mjs` | Tail claude's `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` during zoom; forward TodoWrite + user/assistant text into `agent.todos`/`agent.tail` |

**No HTTP layer.** Express was deleted on purpose — the CLI is the
product. Reintroducing a server needs an explicit decision (CLAUDE.md
non-goal).

**No background work beyond per-agent subprocesses.** Single-process Node
event loop.

---

## On-disk state

Override base dir with `MC_CONFIG_DIR=…` (used by tests and dev
sandboxes). Default: `~/.config/claude-mc/`.

| File | Owner | Format |
|---|---|---|
| `~/.config/claude-mc/settings.json` | `tui/lib/settings.js` | v1; atomic write + `.bak` rollback |
| `~/.config/claude-mc/sessions.json` | `tui/lib/sessionStore.js` | v2 `{bySlot, history}`; UUID-guarded on load (post-2026-06-17 hotfix) |
| `~/.config/claude-mc/costs-week.json` | `tui/lib/costStore.js` | ISO-week-bucketed |
| `~/.config/claude-mc/templates.json` | `tui/lib/templateStore.js` | named launch presets |
| `~/.local/state/claude-mc/sessions/<sid>.jsonl` | `server/agent.mjs` (`MC_NO_TRANSCRIPT=1` to disable) | every inbound event + every outbound message |
| `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | **claude itself** — encoded-cwd is `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`; mc reads but never writes | claude's canonical session record |
| `<cwd>/.mc/MEMORY.md` | L2 project memory plugin | optional; injected into prompt on launch |

---

## Settings / plugins

Settings schema is the single source of truth at
`tui/lib/settings.js`. Add new keys there, not ad-hoc. The Settings UI
auto-generates tabs from the schema.

Plugins are toggleable surfaces gated by `settings.plugin_*` flags:
- `plugin_projectMemory` — read/write `<cwd>/.mc/MEMORY.md`
- (others wired through `tui/lib/plugins.js`)

Permissions and dry-run guards live in the same store.

---

## Forge integration

This repo is `forge-init`'d. See `tasks/`, `~/.claude/forge/`, and the
CLAUDE.md "Forge integration" section. Hard rules:
- Tasks > 3 files or > 100 LOC must be split
- Pre-commit hook: 5-file / 200-LOC max (override: `FORGE_SKIP=1`,
  logged to `tasks/archive/_overrides.log`)
- Pre-push hook: tests must pass, HANDOFF.md must reflect code
  changes
- Every cloud deploy goes through `/forge-deploy` — never raw IaC

`/forge-status`, `/forge-goal`, `/forge-deploy`, `/forge-improve`,
`/forge-context-check` are the entry points.

---

## Testing posture

`npm test` runs the node-test suite. Test buckets:

| Pattern | Purpose |
|---|---|
| `tests/agent.*.test.mjs` | Agent reliability, respawn race, cost cap |
| `tests/sessionStore.backup.test.mjs` / `stores.backup.test.mjs` | Atomic write + .bak recovery |
| `tests/App.*.test.jsx` | Render-loop, grid layout, hotkeys (15 assertions) |
| `tests/TextField.*.test.jsx` | Cursor, wordjump, multi-line |
| `tests/NewSession.test.jsx`, `RepoPicker.test.jsx` | Modal behavior |
| `tests/slashCommands.test.mjs`, `slashCompactClear.test.mjs` | `/compact` `/clear` |
| `tests/plugins.test.mjs` | Settings-gated surfaces |
| `tests/MockAgent.replay.test.mjs` | Fixture playback |
| `tests/smoke.test.mjs` | Module-load smoke |
| `tests/recipes/*.test.jsx` | End-to-end PTY recipes (currently hang headlessly — known gotcha) |

Real-TTY surfaces (most of the TUI) can't be unit-tested; rely on
manual smoke + `ink-testing-library` where it works. The PTY zoom is
manually verified.

---

## Where things have moved (post-2026-06-17 PTY zoom)

If you're reading old code references and they don't match what's on
disk:

- `Zoom.jsx` no longer has `wrapText`, `allRows`, the message log,
  the composer, prompt history, slash dropdown, `@`-mention picker, or
  numeric quick-reply. ~500 LOC deleted. The body is `<PtyPane>`.
- `tests/Zoom.*.test.jsx` were deleted — they covered the composer
  path that no longer exists.
- `server/zoomSession.mjs` and `server/sessionFileTailer.mjs` are new.
- `agent.pause()` / `agent.resume()` (SIGSTOP / SIGCONT) are still
  bound to the user's `P` / `R` hotkeys but are **no longer used by
  zoom** — zoom kills and respawns the sibling instead, to avoid
  stale-state divergence.

---

## Critical invariants (don't break)

- One `claude` process writes to `~/.claude/projects/<cwd>/<sid>.jsonl`
  at a time — enforced by killing the stream-json sibling before
  spawning the PTY (post-hotfix). Two-writer race is a known data
  corruption hazard.
- All subprocess spawns use argv form (`execFile`, `spawn`) — never
  shell strings with interpolated env vars or user input. `CLAUDE_BIN`
  is untrusted.
- Ink horizontal flex rows need explicit `width` on each child;
  `flexGrow={1}` alone biases content-first (see `App.jsx` for the
  pattern).
- `useInput` requires a real TTY; tests that import App must mock or
  skip.
- Saved session records (`sessions.json`) must have a UUID-shaped
  `sessionId` — `tryRead` in `sessionStore.js` drops anything else
  on load (post-hotfix).
- claude encodes cwd as `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` —
  underscores, dots, `@`, and spaces all become `-`. Use
  `claudeSessionPath()` from `sessionFileTailer.mjs`, never roll
  your own.
