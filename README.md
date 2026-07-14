<h1 align="center">BlueArch Mission Control</h1>

<p align="center">
  <strong>Fleet command for your Claude Code agents.</strong><br>
  A keyboard-first terminal TUI for running up to 10 <strong>real</strong> <code>claude</code> CLI sessions at once —
  with live cost, context, and sub-agent tracking. No GUI. No Electron. No prefix keys.
</p>

<p align="center">
  <em>Ten agents, one keyboard. Open source, self-hosted, and made in the USA. 🇺🇸</em>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <a href="https://www.npmjs.com/package/@bluearch/mission-control"><img alt="npm" src="https://img.shields.io/npm/v/@bluearch/mission-control.svg"></a>
  <img alt="Node >=20" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg">
  <img alt="Platform: macOS | Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

<p align="center">
  <!-- Generated with VHS: `vhs tapes/hero.tape`. Absolute raw URL so it also renders on npmjs.com. -->
  <img alt="Mission Control demo" src="https://raw.githubusercontent.com/xxyjoel/ba-mission-control/main/assets/hero.gif" width="800">
</p>

This is not a mockup. Every session is a real `claude` CLI subprocess — tokens,
costs, context, and git status are all measured, not simulated. It runs entirely
on your machine: **no telemetry, no network service, no account beyond your own
Claude login.** `btop` × `lazygit` aesthetic, built on
[Ink](https://github.com/vadimdemedes/ink) (React for terminals) with **no build step**.

## Who this is for

- **macOS or Linux developers using [Claude Code](https://claude.com/claude-code)** who run
  more than one agent at a time and lose track of which one needs them.
- People who want **fleet-level awareness** — cost, context pressure, sub-agent
  fan-out, stuck detection, approval prompts — without babysitting each tab.
- Terminal-first, keyboard-first users who'd rather not run a GUI app or Electron.
- Anyone who wants their agent tooling to be **open source and self-hosted** —
  auditable, local-only, and yours to theme.

## Why not tmux or cmux?

Mission Control isn't a generic multiplexer or a native app — it's a purpose-built
TUI that *understands* Claude Code agents. It happily runs **alongside** tmux and
over SSH.

| | **tmux** | **[cmux](https://github.com/manaflow-ai/cmux)** | **Mission Control** |
|---|:---:|:---:|:---:|
| What it is | terminal multiplexer | native macOS GUI app | terminal TUI |
| Runs anywhere (SSH, any terminal) | ✅ | local macOS | ✅ |
| Purpose-built for Claude Code agents | ❌ | ✅ | ✅ |
| Per-agent cost / context / token tracking | ❌ | ❌ | ✅ |
| Sub-agent fan-out awareness (`⋔`) | ❌ | ❌ | ✅ |
| Approval / permission routing | ❌ | partial | ✅ |
| No prefix keys, zero config to start | ❌ | ✅ | ✅ |
| No GUI / no Electron | ✅ | native (no Electron) | ✅ |
| Open source & self-hosted | ✅ | ✅ | ✅ |

## Quick start

```sh
# Run it now, no install (npm):
npx @bluearch/mission-control

# …or install the `mc` command globally:
npm install -g @bluearch/mission-control
mc
```

Prefer to hack on it? See [From source](#from-source) below and
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Themes

Six built-in palettes ship out of the box — **BlueArch** (default), Tokyo Night,
Gruvbox Dark, Catppuccin Mocha, Solarized Dark, Amber (CRT), and the
green-phosphor **Matrix** theme. Switch live with `:theme <name>` (e.g.
`:theme matrix`) or in Settings → Colors. Self-hosted means it's yours to
re-theme — palettes live in `tui/lib/themes.js`.

## Requirements

- macOS (uses POSIX signals for pause/resume — Linux works too; Windows untested)
- Node 20+
- `claude` CLI on `$PATH` (Claude Code 2.x). Verify with `claude --version`.
- A signed-in account — either `ANTHROPIC_API_KEY`, or a stored OAuth
  session from `claude auth login`. Mission Control runs `claude auth
  status` on startup and prints the account it found:

  ```
  [mc] claude: 2.1.142 (Claude Code)
  [mc] auth · you@example.com · max plan · claude.ai
  ```

  The same info shows as a chip in the top-right of the header strip and
  can be re-probed at any time with `:whoami` (alias `:auth`). If the
  banner says `not signed in`, quit and run `claude auth login`.
- `git` on `$PATH`
- A terminal that supports 24-bit color + Unicode box-drawing (modern macOS
  Terminal / iTerm2 / Alacritty / Ghostty / wezterm all qualify)

## From source

For contributors, or to run the latest `main`:

```sh
git clone https://github.com/xxyjoel/ba-mission-control.git
cd ba-mission-control
npm install
npm start
```

The TUI takes over the terminal. To leave, press `q` (or `Ctrl-C`).

After `npm install`, you can also invoke the bin directly:

```sh
./bin/mc.mjs
```

…or link the `mc` command globally:

```sh
npm link
mc
```

Configurable env vars:

| Var            | Default        | Effect |
| -------------- | -------------- | ------ |
| `CLAUDE_BIN`   | `claude`       | Path to the `claude` CLI |
| `REPO_PARENTS` | see `server/repos.mjs` | Colon-separated parent dirs scanned for the New Session repo picker. Recursive to depth 3. Overridden by a folder chosen in-app via `:repos` (which persists to settings). |
| `MC_MOCK`      | _unset_        | Fixture name (e.g. `approval-request`) — when set, every launched session replays a JSONL fixture from `server/fixtures/` instead of spawning a real `claude` subprocess. Use for deterministic Zoom UX iteration without API spend. |

Settings (theme, density, grid columns, **max windows per pane**, ctx
threshold, etc) persist to `~/.config/claude-mc/settings.json` — open with
`Esc` in the TUI.

**Card anatomy.** Each grid tile is a pure-stats dashboard (fixed height, no
wrapping): title + status, model + branch + git, ctx bar, tok/min sparkline, a
**triage row** (`▸ 5/7 ██████░░ <next action>` — todo burndown from the
session's live `TodoWrite` list plus a status-driven next-action verb), the
**current item** (`↳ <in-progress todo>`), session vitals (small `●<score>`
health dot + turns / messages / uptime / time-in-state), and a cost + tokens
foot. It intentionally shows **no session text** — read the running
conversation by zooming (`↵`) or in the fleet log.

The triage row answers the scan-10-cards question "does this need me, when, and
what next": `check back` (working), `ready to review →` (idle, plan complete),
`needs a nudge →` (idle, plan unfinished), `needs input · answer to continue`
(waiting) — colored by urgency.

**Paging.** The grid shows at most **Max windows per pane** cards at once
(Settings → LAYOUT, `windowsPerPane`, default 9 — a 3×3); when more sessions
are live, or the terminal is too short to fit them, the extra cards spill onto
additional panes instead of being clipped. `[` / `]` switch panes; the active
pane follows the focused card.

## What's actually running

Each launched session is a long-lived `claude --print --input-format stream-json
--output-format stream-json` subprocess pinned to one slot. The fleet manager
writes user prompts as JSON-lines to stdin, reads JSON-line events from
stdout, and maps them onto UI state:

| stream-json event | UI effect |
| --- | --- |
| `system.init` | session attached; appended to tail |
| `stream_event.content_block_delta` (text) | live activity line during a turn |
| `assistant` (text) | activity line + log entry, usage → tokens, `input_tokens` → context |
| `assistant` (tool_use) | log entry `▸ <tool>: <summary>` |
| `user` (tool_result) | log entry `← tool_result <preview>` |
| `result` | `total_cost_usd` → cost, status back to `idle` |

Verifiability — every action is observable:

- The **per-session log tail** (shown in the zoom overlay and merged into the
  fleet log) records every spawn / SIGSTOP / SIGCONT / user message / tool call
  / tool result / turn-complete event with timestamps. (The grid **card** is a
  pure-stats tile — it no longer renders the tail; see *Card anatomy* below.)
- The **fleet log pane** at the bottom is a chronological merge of all live
  agents' tails — like `tail -f` over the whole fleet.
- **Costs** are summed from the `total_cost_usd` field claude emits at the
  end of each turn — not estimated client-side.
- **Context window** (`ctx`) tracks the *main thread* only: sub-agent (Task)
  turns carry `isSidechain` and are excluded so the gauge never dips to a
  sub-agent's smaller context mid-turn. `in` / `out` / `cost` are cumulative
  session totals (sub-agent spend included) and **reset on `/clear`** alongside
  `ctx`; they persist across a relaunch only through a proper save & quit.
- **Tokens `in` counts fresh input only** (`input_tokens + cache_creation`).
  With prompt caching on, claude re-reads the whole context window from cache on
  *every* assistant message, so `cache_read_input_tokens` re-counts the same
  tokens each turn and, if summed into `in`, dwarfs it ~100× (e.g. 67M "in" on a
  60k window). Those re-reads are broken out as **`cache`** (shown in Zoom,
  billed at the 0.1× cache-read rate in `cost`). `ctx` still reflects the full
  live window (fresh + cache read), which is the real size on the wire.
- **Parallel sub-agents** (`Task` / `Workflow` fan-out) are surfaced on the
  card: when any are in flight the current-item row shows `⋔{n}` (the count, or
  the single agent's label), and Zoom lists each with its elapsed time. The
  server pairs each `tool_use` with its returning `tool_result` to know what's
  live. STUCK is suppressed while sub-agents run — they work on sidechains the
  main thread can't see, so the parent's activity clock legitimately goes quiet.
- **Sub-agent token + cost consumption is counted.** Sub-agent turns are written
  to a separate tree (`<sessionId>/subagents/agent-*.jsonl`) the main tailer
  never reads, so their tokens, `cost`, and **tok/min** used to be invisible — a
  fan-out session read near-zero throughput. A dedicated sidechain tailer folds
  that usage into the parent's `in` / `cache` / `out` / `cost` / tok-min (not
  `ctx` — sidechains keep their own window). On resume, pre-existing sub-agent
  files are primed at EOF so historical spend isn't double-counted.
- **Git state** (branch, dirty count, ahead/behind) is read via `git` calls
  in the session's cwd on launch and after each turn.

### Session states

Each agent has exactly one status from this six-value enum (`server/agent.mjs`):

| State     | Meaning |
| ---       | --- |
| `idle`    | attached, no current activity |
| `working` | actively processing — streaming text, calling tools, thinking |
| `waiting` | model delivered a prompt awaiting user approval (a.k.a. "needs input") |
| `paused`  | process frozen via SIGSTOP (user pressed pause) |
| `error`   | crashed or API failure — auto-restart may retry |
| `empty`   | slot is vacant, no agent assigned |

The fleet header (`Header.jsx`) shows live counts for `work / wait / paused
/ idle / err` plus the over-context-threshold count and an aggregate
`NOMINAL / AWAITING / DEGRADED` pill.

**Not states (derived indicators):**

- `STUCK Nm` — a red chip on the card when an agent is `working` or
  `waiting` AND has been silent for ≥ 5 minutes (`agent.stuckMin`). Not a
  status — the underlying state is still `working`/`waiting`.
- `ctx high` / `ctx full` — derived from `agent.context` vs the
  warn-band / threshold settings, not from `status`.
- **Session Health dot** — when the optional
  [Session Health Benchmark](https://github.com/) Stop hook is installed, mc
  reads each project's `.project-health/history.jsonl` and shows a small
  `●<score><trend>` dot at the left of the card's vitals row (colored by
  verdict: green HEALTHY / cyan STABLE / yellow / red), plus a `health` segment
  on the zoom stats line. The dot is simply omitted until the project has logged
  a scored turn; mc only *reads* the score, it doesn't compute it
  (`tui/lib/projectHealth.js`). The untrusted verdict *string* is no longer
  rendered on the card at all — only the numeric score — so it carries no
  terminal-escape surface (zoom still shows the verdict word, `humanize()`d).

**Status accuracy — hook-driven source of truth.** The session JSONL has no
permission-prompt event and marks `end_turn` *mid-work*, so a JSONL-only status
misreads: it shows `working` when the agent is actually blocked on a tool-approval
prompt, or `idle` mid-turn. mc fixes this by injecting Claude Code's own lifecycle
hooks into every spawned session (`--settings` → `server/hooks/emit-status.mjs`
writes `PreToolUse` / `Notification` / `Stop` events to
`~/.local/state/claude-mc/status/<sid>.ndjson`; `server/statusHookTailer.mjs`
tails it). `PtyAgent.toJSON` then derives status from those events:

- `Notification:permission_prompt` → **`waiting`** (the connector is blind to
  prompts — this is the "working when it's actually asking for input" fix);
- `PreToolUse` → **`working`**, held until `Stop` (covers the mid-turn `end_turn`
  flash without terminal scraping);
- `Stop` / `Notification:idle_prompt` → **`idle`**, winning over a stale connector
  `working` (compared against a JSONL-only clock, `lastConnectorTs`, so Claude's
  constantly-repainting TUI can't keep a finished session pinned to `working`).

`detectApprovalPrompt` is kept as an **instant-INPUT fast-path** while a tool is
outstanding (the `permission_prompt` hook is delayed ~10–20s). Sessions with **no
hook events yet** — the legacy `FLEET_USE_PTY=0` `Agent`, or a PTY session before
its first event — fall back to the older terminal-scrape overlay
(`detectWorking` / `detectApprovalPrompt` in `server/ptyAgent.mjs`). Hooks are
auto-injected; nothing to configure. *(Takes effect per session on next spawn —
a session already running when mc updated keeps its old status source until
relaunched.)*

**Session summaries** (`/compact`, `/compact-restart`) are manual,
user-invoked actions — they're not bound to a state transition. There is
no automatic stage-bound summary today.

## Hotkeys

| Keys | Action |
| --- | --- |
| `← ↑ ↓ →`  (or `h j k l`) | Move focus across the grid |
| `↵` | Zoom focused session — or open New Session if nothing is live |
| `1`–`9`, `0` | Jump to slot 1–10 (slots 11+ via arrow nav or `:goto <slot>`) |
| `[` / `]` | Switch to the previous / next **pane** — only when the grid pages (see LAYOUT → *Max windows per pane*) |
| `Esc` | Open settings menu (or close current overlay) |
| `,` | Settings menu |
| `B` | Broadcast modal — types the message into each targeted session **and submits it** (no manual Enter per session) |
| `D` | Fleet dashboard — sortable one-row-per-slot table for at-scale triage |
| `n` / `N` / `Ctrl+N` | New session — appended below the last active card (fills a killed-slot hole only when there's no room to append) |
| `P` / `R` | Pause (SIGSTOP) / Resume (SIGCONT) |
| `K` | Kill — armed by first press (3s window); confirms on second `K`. `:kill <slot>` follows the same arm/confirm flow; `:kill! <slot>` bypasses. |
| `A` | Approve — send a generic "continue" message to a focused session (useful when an agent stalls asking for confirmation) |
| `Shift+Tab` | Cycle focused session's permission mode: `plan → auto → acceptEdits` |
| `?` | Help |
| `/` | Filter — type a substring (matches name/branch/model/status); non-matches dim. Press `/` again to clear. |
| `:` | Command bar (see below) |
| `Q` | Quit — opens a confirm with an explicit choice: **`[s]` save & quit** (or `Enter`) vs **`[d]` quit, no save** vs `[n]`/`Esc` cancel |
| `Ctrl-C` | Quit immediately (treated as **no save** — see below) |

### Session save / restore

**Save is opt-in; every other exit is a "clear."** Only a proper **`[s]` save &
quit** preserves the live conversations *and* their token/cost totals so
`:resume-all` can rehydrate them with `claude --resume`. Any other exit — `[d]`
quit-no-save, closing the terminal (SIGHUP), `Ctrl-C`, or a crash — records only
the open repo **locations**: `:resume-all` then reopens those repos as **fresh**
sessions (no history, in/out/cost reset to 0). Per-slot crash recovery during a
running session still resumes the conversation.

| Command | What it does |
| --- | --- |
| `:resume-all` | Restart the slots that were **open when mc last closed**. After a *save* quit each is rehydrated via `claude --resume` (conversation + totals restored); after any non-save exit each reopens **fresh** in its repo. The toast reports `resuming N · M fresh`. Killed/closed slots are excluded. On boot, a toast surfaces this if records exist. |
| `:resume <slot> [slot ...]` | Restore **specific** slots — e.g. `:resume 1 3 5` or `:resume 1,3,5`. Falls back to the focused slot with no args. |
| `:history [n]` | **View-only** browse of the last N sessions for historical reference. Never bulk-restores (by design). |
| `:sessions` (alias `:ls`) | List saved sessions (`bySlot`) for the current resumable set. |
| `:forget <slot>` | Drop one slot's saved state. |

Configurable in Settings → GENERAL:

- **Auto-resume sessions on startup** (`autoResumeOnStart`, default off) —
  when on, mc runs `:resume-all` implicitly at boot.
- **Session history limit** (`sessionHistoryLimit`, default 20) — how many
  sessions the LITE history (`:history`) remembers.

### Zoom (focused session)

`↵` on a live card opens the Zoom view. Claude's own "update available" banner
is lifted out of the body and shown as a discrete `⬆ update` chip on the right
of the zoom header so it doesn't encroach on the conversation — toggle with
**Hide claude update banner in zoom** (`hideClaudeUpdateBanner`, default on) in
Settings → LAYOUT. Keys available there:

| Keys | Action |
| --- | --- |
| `/` | Type a slash command — autocomplete dropdown appears above the composer. `Tab` fills the highlighted name (keeping any args you've typed); `↵` runs it. See below for the catalog. |
| `⌥↵`  ·  `Ctrl+J` | Newline in composer (plain `↵` submits) |
| `↑` / `↓` | Recall prior submitted prompt (history nav in composer) |
| `Ctrl+Y` | Enter **scroll mode** — view scrollback without forwarding keys to claude (the embedded session owns the screen, so mc brackets a dedicated mode rather than fighting it for arrow keys) |
| `w` / `s` _(scroll mode)_ | Scroll one line back / forward through history |
| `b` / `f` _(scroll mode)_ | Scroll half a page back / forward |
| `g` / `G` _(scroll mode)_ | Jump to the oldest / newest (live) line |
| `Esc` _(scroll mode)_ | Exit scroll mode (any other key also exits, returning input to claude) |
| `Ctrl+U` | Expand / collapse the stats panel (defaults to a compact one-liner) |
| `Ctrl+K` | Show / hide tool-call events in the log |
| `Ctrl+Q` | **Close the zoom view** |
| `Esc`, `Ctrl+T`, `Ctrl+S`, `Shift+Tab` | **Forwarded to claude** — its own cancel/back-out, todos, stash, and permission-mode cycle. mc no longer shadows these (chrome keys are `Ctrl+Q/Y/K/U`, all unused by claude). |

#### Slash commands (in zoom composer)

These are handled **client-side** — they don't round-trip to the `claude` subprocess (stream-json non-interactive mode doesn't parse slash commands). Everything except `/quit` routes through the same dispatcher that powers the `:cmd` command bar, so the two surfaces share their handler table.

| Command | Effect |
| --- | --- |
| `/help` | Open the keymap reference |
| `/cost` | Toast this session's running cost ($ session + $ week) |
| `/usage` | Show plan-side rate-limit usage (5h + 7d) |
| `/perm <mode>` | Change this session's permission mode |
| `/note <text>` | Drop a local annotation in the chat log |
| `/approve` | Send a generic "continue" reply (same as the `A` hotkey) |
| `/pause` / `/resume` | SIGSTOP / SIGCONT this session |
| `/kill` | Terminate this session (SIGTERM) |
| `/quit` (or `/exit`) | Close the zoom view (same as `Ctrl+Q`) |

A message that doesn't start with `/` is sent through to claude unchanged — slash dispatch only fires on leading-`/` inputs.

### Command bar

| Command | Effect |
| --- | --- |
| `:theme <name>` | Cycle palette (any substring match) |
| `:cols 3\|4\|5` | Change grid columns |
| `:perm <mode>` | Set default permission mode (`default`, `acceptEdits`, `bypassPermissions`, `plan`) |
| `:model` | Show the focused session's requested vs. resolved model |
| `:model <id>` | Switch the focused session's model live (restarts the subprocess) |
| `:model default <id>` | Set the fleet default model for new launches |
| `:model refresh` | Programmatically probe the live model catalog — see [Model catalog](#model-catalog) |
| `:kill [slot]` | Kill focused (or specified) session |
| `:pause` / `:resume` | SIGSTOP / SIGCONT the focused session |
| `:approve` (or `:a`) | Same as the `A` hotkey |
| `:resume [slot]` | Rehydrate the saved session in this slot from disk via `claude --resume` |
| `:sessions` | Show saved sessions (toast) |
| `:forget <slot>` | Drop the saved session for a slot |
| `:repos` | Open the folder picker to choose where repos are scanned. The chosen folder **replaces** the built-in defaults. `:repos clear` resets to defaults. |
| `:whoami` (or `:auth`) | Re-probe `claude auth status` and surface email + subscription |
| `:usage` | Re-read plan-side rate-limit telemetry (`5h` and `7d` quota %) |
| `:note <text>` (or `:n`) | Inject a local annotation into the focused session's chat log (not sent to claude) |
| `:slack <url>` | Set the Slack incoming-webhook URL. `:slack clear` removes it. |
| `:feedback <msg>` | Send feedback to Slack (includes auth + fleet + plan-usage context) |
| `:request <msg>` | Send customer request to Slack |
| `:quit` | Exit |

## Model catalog

The selectable models live in `tui/lib/models.js` — each entry maps a
friendly id (`opus-4.8`, `sonnet-4.6`, …) to the CLI model name passed to
`claude --model`, plus display metadata (context window, per-MTok pricing,
colour). The default for new sessions is **`opus-4.8`** (1M-token context);
change it in Settings → GENERAL or with `:model default <id>`.

### Programmatic refresh (`:model refresh`)

The `claude` CLI has no "list models" command, so mc learns what an alias
resolves to — and its real context window — by running a one-shot query
and reading the `modelUsage` block of the JSON result:

```sh
claude -p --model opus --output-format json 'hi'
# → "modelUsage": { "claude-opus-4-8": { "contextWindow": 1000000, … } }
```

`:model refresh` runs that probe for `opus` / `sonnet` / `haiku`
concurrently, then:

- **updates** the context window of any catalog model whose CLI name matches
  (so per-card ctx% is computed against the true window), and
- **discovers** any newly-shipped model an alias now points at, adding it to
  the catalog (pricing inherited from the same family and flagged as
  estimated until confirmed).

Each probe is a **real, billed turn** (~$0.10–0.15, ~2s), so this is
manual-only. The result is cached to `~/.config/claude-mc/models-cache.json`
and overlaid onto the static catalog **offline** on every boot — startup
never probes. Re-run `:model refresh` after a new model ships (or roughly
weekly) to stay current.

## Slack feedback / customer requests

If you set an [incoming-webhook URL](https://api.slack.com/messaging/webhooks)
via `:slack <url>`, then `:feedback <message>` and `:request <message>`
will POST a structured payload to that channel — auto-tagged with your
account email, current fleet state (live sessions, models, branches),
and plan-side usage (5h / 7d %). The webhook URL is stored in
`~/.config/claude-mc/settings.json` and never displayed in the UI;
Settings → FEEDBACK shows only whether one is configured.

## Plan-side usage

The aggregate strip shows the same numbers Claude Code's `/usage` slash
command reports — read from `~/.claude/abtop-rate-limits.json`:

```
plan  5h 1% ↻4h 50m  ·  7d 29% ↻2d 19h
```

These are **plan-side** percentages (the actual Anthropic quota), not
just what Mission Control has observed. The file is rewritten by every
`claude` invocation on the machine; we re-read it every 8 seconds. The
locally-tracked `cost·week` figure to the left of it is independent —
it's the rolling $ spend Mission Control itself has booked.

Inside modals, `Esc` closes and `Tab` cycles fields.

Errors and confirmations (launch failures, broadcasts, command results)
appear as transient toasts above the status bar.

## Project layout

```
bin/
  mc.mjs              CLI entry — registers tsx JSX loader, boots tui/main.jsx
tui/
  main.jsx            Boot: constructs Fleet, renders <App/>, wires shutdown
  App.jsx             Top-level: hotkeys, focus, modal routing, fleet sub
  Header.jsx          Top status strip
  Aggregate.jsx       Token/cost line + week budget bar + fleet sparkline
  Card.jsx            One agent tile
  FleetLog.jsx        Bottom pane — aggregated activity stream
  StatusBar.jsx       Vim-style status bar
  modals/
    Help.jsx          Keymap reference
    Broadcast.jsx     Send one prompt to N sessions
    NewSession.jsx    Single-input launcher: fuzzy-match recents or type a path
    Settings.jsx      btop-style settings (tabs: GENERAL / LAYOUT / COLORS / ALERTS / SAFETY / NOTES)
    Zoom.jsx          Single-session detail (full tail + ctx bar + msg input)
    RepoPicker.jsx    Filesystem browser to choose the repo scan folder (:repos)
  lib/
    themes.js         6 palettes (BlueArch / Tokyo Night / Gruvbox / Catppuccin / Solarized / Amber)
    format.js         bar / sparkline / fmtK / fmtMoney / trunc / fmtClock
    models.js         Claude model metadata (label, maxCtx, kind, costs)
    settings.js       Schema + defaults + on-disk persistence
    TextField.jsx     Minimal single-line input (Ink has none built-in)
server/
  fleet.mjs           10-slot fleet manager + pub-sub (EventEmitter)
  agent.mjs           One claude subprocess wrapper (stream-json I/O)
  mockAgent.mjs       Fixture-driven Agent stand-in for UX iteration (MC_MOCK)
  fixtures/           JSONL fixtures replayed by MockAgent
  git.mjs             branch / dirty / ahead-behind via `git`
  repos.mjs           Recursive repo scanner for the New Session picker
```

## Mock mode

For iterating on Zoom UX without burning real `claude` sessions, set
`MC_MOCK=<fixture>` before launching. Every session opened in the TUI
will then replay the named fixture from `server/fixtures/` instead of
spawning a real subprocess. Available fixtures:

| Fixture            | Exercises |
| ------------------ | --------- |
| `quick-reply`      | text-only assistant turn |
| `tool-loop`        | assistant → tool_use → tool_result → assistant |
| `long-thinking`    | extended-thinking block + streamed answer |
| `approval-request` | tool approval banner; pauses at `waiting`, resumes when you reply (`a`/`r` in zoom) |

Example:

```sh
MC_MOCK=approval-request npm start
```

Drop a new fixture by adding `server/fixtures/<name>.jsonl`. The
directive schema is documented at the top of `server/mockAgent.mjs`.

`server/` is the data layer — it has no Express anymore. The TUI reads
`fleet.snapshot()` directly and subscribes to `fleet.on('change', …)`.

## Permission mode

Sessions default to `acceptEdits` — claude can read and edit files in the
session cwd without prompting, but still blocks unsafe bash. Valid values are
`default`, `acceptEdits`, `bypassPermissions`, `plan`. Configurable in the
Settings menu (`Esc`) under **GENERAL → Default permission mode**, or via the
command bar with `:perm <mode>`. The mode is swappable mid-session (which is
why it isn't part of the launcher anymore). `bypassPermissions` removes all
guardrails — only use it in trusted, scratch directories.

## Resume previous sessions

Each running session is mirrored to `~/.config/claude-mc/sessions.json`
along with the claude session UUID. To pick up where you left off:

- **From the command bar** — `:resume <slot>` rehydrates in place.
- **List what's saved** — `:sessions`. Drop a record with `:forget <slot>`.

Under the hood we call `claude --resume <session-id>` against the same
working directory. claude restores the prior transcript from its own
on-disk session store.

## Quality-of-life features

Built on top of the reliability layer below.

### Fleet dashboard (`D` or `:dash`)

A single-screen table — one row per live agent — for triage when you
have more than a handful of slots running. Columns: slot, name, model,
status pill, ctx %, tok/min, $ session, age, activity. Sortable:

- `S` cycles the sort column (`slot → status → ctx → tpm → cost → age`)
- `R` reverses direction
- `↑` `↓` moves the highlight (the focused slot tracks)
- `↵` zooms the highlighted slot
- `D` or `esc` closes

The header also surfaces today's fleet spend and the configured budget
when one is set — so "how much have I spent today?" is one keystroke
from any view.

### Cost guardrails — `:cap` and `:budget`

Two tiers of cost protection, both off by default (set the values to
opt in):

- **Per-slot cap** — `:cap <slot> <usd>` rejects further user messages
  to that slot once its `costSession` crosses the cap. `:cap default
  <usd>` persists a fleet-wide default applied to every new launch.
  Raise the cap with the same command to continue (`:cap 3 10` bumps
  slot 3 to $10).
- **Daily budget** — `:budget <usd>` blocks NEW launches once today's
  fleet-wide spend exceeds the cap. Existing sessions keep running.
  Use `:budget 0` to disable. `:budget` alone shows today's spend.

Both also have form-editable rows under the SAFETY section of the
settings menu (`,` or `esc`).

### Session templates — `:template <name>`

Pre-configured bundles of N session launches with model / permission /
prompt baked in. Bundled defaults at first launch (auto-written to
`~/.config/claude-mc/templates.json`):

- **`review`** — 3 sessions (Opus architecture + 2 Sonnets) reviewing
  the same repo in plan mode.
- **`explore`** — 2-session parallel exploration: Opus deep + Sonnet
  fast.
- **`spec-then-implement`** — 2 sessions: Opus writes a spec in plan
  mode; Sonnet implements in acceptEdits.

Usage:

```sh
:template                       # list available templates
:template review                # launch into next N empty slots, using
                                # focused agent's cwd (or process.cwd)
:template review ~/my-other-repo
```

Edit `~/.config/claude-mc/templates.json` to add your own.

### `@file` mention autocomplete (in Zoom composer)

Type `@` followed by a partial filename to summon a dropdown of files
and folders under the session's working directory:

- `↑` `↓` navigates
- `Tab` or `↵` accepts (folders get a trailing `/` so you can keep
  descending — same UX as the path autocomplete in New Session)
- Suppressed while the slash dropdown owns the input — the prefixes
  (`@` vs `/`) are distinct so they never need to coexist

Useful for "look at @src/auth/oauth.ts" without copy-pasting from
another terminal.

## Reliability features

These guard against the failure modes that hit hardest at fleet scale.

- **Press-K-twice to kill.** A first press arms the kill action for 3
  seconds and shows a warning toast; the second `K` confirms and SIGTERMs
  the subprocess. Eliminates the most painful misfire (accidental loss of
  work). The `:kill` command bar entry follows the same arm-then-confirm
  flow; `:kill!` (bang) bypasses for explicit batch use.
- **Auto-restart on transient errors.** When a `claude` subprocess exits
  unprompted with a non-zero code, the slot retries up to **3 times** with
  exponential backoff (1s → 2s → 4s), restarting via `--resume <session-id>`
  so the in-progress conversation is preserved. The retry counter resets on
  the next successful `init` event, so a recovered slot is eligible again
  on its next independent failure. After 3 failed restarts the slot enters
  the errored state with `K clears slot` hint.
- **Stuck-detection.** When a slot is in `working` or `waiting` status but
  hasn't emitted any event from the subprocess in the last 5 minutes, the
  card shows a red `STUCK Nm` chip and a one-shot toast fires (`slot N ·
  stuck 5m · no events while working`). Re-arms automatically when the
  slot starts emitting again.
- **Context-pressure toasts.** Crossing 80% / 90% of the model's max
  context fires a yellow / red toast (`slot N · context 80% · consider
  /compact`). Each crossing is fired exactly once; the trigger re-arms
  when the slot drops back under the threshold (post-compaction).
- **Title-row context chip.** When the slot's context is above the warn
  threshold, the status pill on the card title gets a `· 89%` chip in the
  appropriate urgency color (yellow near, red over). Pairs with the toast
  but stays visible at-a-glance.
- **Per-session transcript on disk.** Every inbound `claude` event and
  every outbound user message is appended as a JSONL line to:

  ```
  $XDG_STATE_HOME/claude-mc/sessions/<sessionId>.jsonl
  ```

  (defaults to `~/.local/state/claude-mc/sessions/`). Survives across
  process restarts, slot reassignments, and reboots — useful for audit,
  replay, post-hoc grep, and forensics when something looks wrong. Each
  line is `{ ts, source: 'inbound'|'outbound'|'local', ... }`. Set
  `MC_NO_TRANSCRIPT=1` to disable.

## Known caveats

- **Single user.** No multi-user sessions, no per-user repos.
- **Pause via SIGSTOP** freezes the process but does not cancel in-flight API
  requests. The claude subprocess will receive their results when SIGCONT'd.
- **Permission prompts in `default` mode.** The stream-json wire format does
  not expose a structured permission event. The `A` hotkey sends a generic
  "yes, continue" message that unblocks most prompts, but for tight
  control prefer `acceptEdits` or `bypassPermissions`.

### State persisted across runs

- **Settings** (theme, layout, default model + permission mode, thresholds) →
  `~/.config/claude-mc/settings.json`.
- **Weekly cost** — every cost delta the fleet reports is folded into an
  ISO-week bucket in `~/.config/claude-mc/costs-week.json`. The week
  rotates automatically every Monday 00:00 UTC.
- **Saved sessions** — per-slot snapshot of cwd / branch / model / session-id
  in `~/.config/claude-mc/sessions.json` so the next launch can `--resume`.

## Smoke test

```sh
npm install
npm start
```

On first launch the grid is empty — you'll see the header, the aggregate
strip, and a "no sessions running" hint. Press `n` (or `Ctrl+N`) to open
the New Session picker. As you launch sessions, cards appear and
autosize to fill the row; the grid wraps to multiple rows once you pass
`settings.gridCols` columns. The bottom fleet log streams events from
every live session.

### New Session modal

One `path` input. As you type, the dropdown below it blends two sources:

- **recents** — the auto-discovered repo list, filtered by case-insensitive
  substring match on repo name or tildified path. Configure the scan
  roots with `:repos`.
- **filesystem completions** — when your query starts with `/` or `~`
  (or contains a `/`), child directories of the deepest existing parent
  are appended. Hidden dirs, `node_modules`, `dist`, and `build` are
  skipped.

Hotkeys:

| Key | Action |
| --- | ------ |
| `↑` / `↓` | move the highlight through suggestions |
| `↵` | launch the highlighted suggestion — or, if nothing is highlighted, the typed path as-is (must already exist) |
| `←` / `→` | cycle the model |
| `Ctrl+B` | open the filesystem browser (familiar `cd`/`ls`-style nav); `↵` inside the picker launches the highlighted folder |
| `esc` | cancel |

Inside the **filesystem browser** (Ctrl+B): `↑`/`↓` or `k`/`j` move the
highlight, `→`/`l` descends into the highlighted folder, `←`/`h` goes
up a level, `.` picks the folder you're currently in, `↵` launches the
highlighted folder immediately. `esc` returns to the path input.

Intentionally absent: mode toggle, create-new (mkdir + git init), resume
banner, branch input, permission picker, initial prompt. The launcher
does one thing: pick a repo and launch. Branch follows the repo's
default; permission mode and prompt are post-launch concerns and
changeable from inside the running session.

Without `claude` on `$PATH` the New Session launch will still succeed at the
fleet level, but the spawned process will exit immediately — you'll see the
error in the per-session tail.

## Tests

```sh
npm test           # run the suite once
npm run test:watch # rerun on file change
```

`npm test` runs `scripts/run-tests.mjs`, which executes every
`tests/**/*.test.*` in its own process. In headless CI (`CI=true`) it skips
the **real-terminal** suites — the node-pty recipes under `tests/recipes/` and
the `*.realparser.test.*` ink-keypress-parser tests — because the GitHub runner
has no usable TTY/PTY (node-pty emits no output; ink mis-parses control bytes).
Those run normally for you locally and on every push (the pre-push hook runs
`npm test` with `CI` unset). Set `MC_RUN_PTY=1` to force them on anywhere.

The suite uses Node's built-in `node:test` runner plus
`ink-testing-library` for component rendering. Coverage includes:

- `tests/detectPrompt.test.mjs` — structured-prompt classification
  (numbered, checkbox, lettered Option A/B/C, binary fallback, priority
  rules, the screenshot regression).
- `tests/Zoom.chips.test.jsx` — chip render + keystroke dispatch
  (letter and digit keys both work, wire format includes the original
  marker, multi-select seeds from pre-checked defaults).
- `tests/RepoPicker.test.jsx` — filesystem browser lists real subdirs
  (filtering dotfiles / node_modules / files), ↵ picks a child, `.`
  picks the current folder, esc cancels.
- `tests/NewSession.test.jsx` — single-input launcher: substring
  filtering, ↵ launches the highlighted suggestion, ↵ on a typed real
  path launches it, ←/→ cycles the model, esc closes, nonexistent
  paths show an error and don't launch.
- `tests/TextField.test.jsx` — plain `↵` submits; `⌥↵` (ESC+CR) and
  `Ctrl+J` insert a newline; the meta/shift Return paths are checked
  before the plain-return submit branch so macOS users don't
  accidentally submit half-typed messages.
- `tests/Zoom.input.test.jsx` — stats panel defaults to compact +
  `Ctrl+S` toggles; PgUp pins the log and shows the "↓ N below"
  indicator; `Ctrl+G` snaps back to live; `↑`/`↓` walk through
  composer history.
- `tests/slashCommands.test.mjs` — prefix matcher behind the dropdown:
  bare `/` returns full catalog, `/p` narrows to /perm /pause /etc.,
  matching is case-insensitive and ignores args after the first token.
- `tests/Zoom.slash.test.jsx` — typing `/` surfaces the autocomplete
  dropdown; `/cost` routes via `onSlashCommand` (not `onSendMessage`);
  `/quit` closes the modal locally; `Tab` fills the highlighted name;
  a non-slash message still sends through to claude.
- `tests/recipes/zoom.recipes.test.jsx`,
  `tests/recipes/newsession.recipes.test.jsx`,
  `tests/recipes/repopicker.recipes.test.jsx`,
  `tests/recipes/pty.recipes.test.jsx` — declarative recipe coverage for
  each surface (see the section below).

### Recipe-based QA runner

For new feature coverage, prefer the declarative recipe runner in
`tests/lib/recipe.js` over hand-writing render / stdin / assert
boilerplate. A recipe is a JSON-shaped list of steps that drive a
rendered Ink component and assert on the frame at each step. Each step
can `type` characters, `press` a key, `tick` for timers, assert on
`expectFrame` / `expectNotFrame` substrings, or check
`expectCallback` arg arrays. On failure the runner throws with the
failing step's label, the assertion, and the last frame — so you can
diff actual UI against intent.

Example, from `tests/recipes/zoom.recipes.test.jsx`:

```jsx
import { runRecipe } from '../lib/recipe.js';
import Zoom from '../../tui/modals/Zoom.jsx';
import { theme, makeAgent } from '../lib/fixtures.js';

test('recipe: Ctrl+S expands the stats panel', () => runRecipe({
  component: Zoom,
  props: { agent: makeAgent(), theme, threshold: 150000, weekCost: 0,
           onSendMessage: () => {}, onSlashCommand: () => {},
           onClose: () => {}, onCyclePerm: () => {} },
  steps: [
    { expectFrame: [/ctrl\+s expand/], expectNotFrame: [/USAGE · SESSION/] },
    { press: '\x13' },                  // Ctrl+S
    { expectFrame: [/CONTEXT/, /USAGE · SESSION/] },
  ],
}));
```

Common fixtures (`makeAgent`, `chatTail`, the active `theme`) live in
`tests/lib/fixtures.js` so recipes don't have to redefine boilerplate.
The intent: adding "press X, expect Y" coverage should feel like
writing a JSON document, not a React component.

- `tests/lib/recipe.js` — in-process runner (Ink + `ink-testing-library`).
- `tests/lib/fixtures.js` — agent / tail / theme helpers.
- `tests/recipes/*.recipes.test.jsx` — one file per UI surface.
- `tests/Card.tier.test.jsx` — Card tail filters tier-2 entries by
  default and shows a hidden-count hint.

### Full-PTY recipe backend

The in-process runner is fast but renders Ink in a fake stdout — it can't
catch terminal-specific bugs (e.g. the macOS `Option+Return` split-read
where `ESC` and `CR` arrive in two reads instead of one). The
`runRecipePty` backend in `tests/lib/recipe-pty.js` spawns a real
subprocess inside a pseudo-terminal (`node-pty`) and pipes its output
through a headless xterm.js Terminal so escape sequences are processed
exactly the way iTerm/Terminal.app would process them. Same step DSL
(`type` / `press` / `tick` / `expectFrame` / `expectNotFrame`),
different backend.

```jsx
import { runRecipePty } from '../lib/recipe-pty.js';

test('counter app: + increments', () => runRecipePty({
  command: process.execPath,
  args: ['tests/lib/pty-fixtures/counter-app.mjs'],
  bootDelayMs: 600,
  steps: [
    { expectFrame: [/counter:/, /\b0\b/] },
    { type: '++' },
    { tick: 80 },
    { expectFrame: [/counter:[^\n]*\b2\b/] },
    { press: 'q', expectExit: 1500 },
  ],
}));
```

Use the in-process runner for fast component tests and the PTY runner
for "does this work when wrapped by a real terminal." See
`tests/recipes/pty.recipes.test.jsx` for working examples.

`node-pty` ships a prebuilt `spawn-helper` whose executable bit is
sometimes dropped by `npm install`. A `postinstall` script
(`scripts/fix-node-pty.mjs`) restores it automatically — if you see
`posix_spawnp failed` after a fresh install, run `npm install` again or
re-run the script manually.
- `tests/humanize.test.mjs` — ANSI strip, path collapse, UUID shorten,
  JSON collapse, idempotency.
- `tests/MockAgent.replay.test.mjs` — every shipped fixture replays
  cleanly; approval fixture pauses at `waiting` and resumes on `send()`.

When iterating on UI without API spend, prefer:

```sh
MC_MOCK=approval-request npm start
```

…to exercise the structured-prompt + APPROVE? marker flow against the
canned fixture instead of a real `claude` session.
