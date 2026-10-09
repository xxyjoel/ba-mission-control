# Project: BlueArch Mission Control

Keyboard-first terminal TUI for managing real `claude` CLI agent sessions
(10 slots by default; the `maxSlots` setting allows up to 64). Stack: Node 20+ ·
Ink (React for terminals) · `tsx` for JSX runtime · no build step.

## Repo layout (orient yourself before edits)

- `bin/mc.mjs` — CLI entry, registers `tsx` JSX loader, imports `tui/main.jsx`
- `tui/main.jsx` — boots the Fleet, renders `<App/>`, wires shutdown
- `tui/App.jsx` — top-level: hotkeys, focus, modal routing, fleet subscription
- `tui/Card.jsx`, `Header.jsx`, `Aggregate.jsx`, `FleetLog.jsx`, `StatusBar.jsx`
- `tui/modals/{Help,Broadcast,NewSession,Settings,Zoom,Dashboard,QuitConfirm,…}.jsx`
- `tui/zoom/PtyPane.jsx` — zoom body: draws the slot's own terminal emulator and
  forwards keys to claude; `tui/zoom/zoomKeys.js` holds the few keys zoom keeps
- `tui/lib/{themes,format,models,settings,sessionStore,gridLayout,TextField,…}` —
  palettes, render helpers, Claude-model metadata, settings persistence, saved
  sessions, card-grid geometry, minimal text input
- `server/` — **data layer only, no HTTP.**
  - `Fleet` (EventEmitter; 10 slots by default, 1–64) picks the agent class.
  - Default path: one interactive `claude` per slot in a node-pty.
    `ptyCore.mjs` is the provider-neutral PTY (spawn, emulator, send queue,
    pause/kill/restart); `ptyAgent.mjs` is claude on top of it (argv, hooks).
    Cursor slots use `providers/cursor/cursorAgent.mjs` on the same core.
  - State comes from what claude writes, not from a wire protocol:
    `sessionFileTailer` + `jsonlConnector` read claude's session JSONL,
    `statusHookTailer` reads the hook status file that `hooks/emit-status.mjs`
    appends, `subagentUsageTailer` adds sub-agent usage, and
    `deriveStatus.mjs` turns those signals into one status.
  - `agent.mjs` (stream-json I/O) is the legacy path behind `FLEET_USE_PTY=0`;
    `mockAgent.mjs` replays fixtures under `MC_MOCK`. `git.mjs` reads git state;
    `repos.mjs` scans for repos.
  - `server/zoomSession.mjs` is gone (0444): zoom never spawns its own claude.

The TUI reads `fleet.snapshot()` directly and subscribes to
`fleet.on('change', …)`. There is no HTTP/SSE layer anymore.

## Conventions

- ESM only. `"type": "module"`. Files use `.jsx` extension; `tsx` handles JSX
  at runtime — there is **no build step**.
- Never spawn shell strings with environment-variable or user-input
  interpolation. Always use argv-form helpers (`execFile`, `execFileSync`,
  `spawn`). `CLAUDE_BIN` is user-controlled — treat it as untrusted.
- Ink layout: when placing cards in a horizontal flex row, give each child an
  explicit `width={N}` (computed from `stdout.columns`) — `flexGrow={1}` alone
  biases earlier children content-first. See `App.jsx` for the pattern.
- Modals replace the main view. Don't attempt absolute positioning to overlay
  — Ink's `position: 'absolute'` is unreliable for terminal stacking.
- `useInput` requires a real TTY. In tests / non-TTY environments it errors
  with "Raw mode is not supported"; that's expected and not a code bug.
- Settings live in `~/.config/claude-mc/settings.json`. Schema is in
  `tui/lib/settings.js` — extend the `SETTINGS_SCHEMA` array, not ad-hoc.

## Workflow rules

- **Update `README.md` after every merge to `main`.** Whatever changed in the
  merged PR — new hotkey, new modal, changed env var, new dep, new layout
  constraint — needs to be reflected in the user-facing README before the
  next merge. If you can't tell what changed from the diff, run
  `git log main..HEAD` against the previous merge point.
- Before touching `server/ptyCore.mjs`, `server/ptyAgent.mjs` or
  `server/agent.mjs`, recognize that they manage a real `claude` process.
  Pause/resume/kill signal claude's whole process tree (SIGSTOP/SIGCONT,
  SIGTERM then SIGKILL). Don't introduce sleeps in a data or event handler:
  the PTY and the legacy stream-json stdout must both be drained.
- Run tests only through `node scripts/run-tests.mjs` (or `npm test`). It gives
  each file a temporary HOME. Real-claude tests need `MC_RUN_REAL=1` and cost money.
- Always prefer adding a TODO comment over deferring work in chat. Format:
  `// TODO(<short-tag>): <what + why>` at the relevant line.

## Records — task db only (org directive, 2026-08-15)

The task db (`tasks/`) is the single record for this project. The HANDOFF
method is retired (archive: `docs/archive/HANDOFF-retired-2026-08-15.md`).

- Write the narrative context of a change in the task's **Why** section.
- Write the outcome (sha, files, test result) in the task's **Result** section.
- For an incident that spans tasks, put the full story in the first task's
  Why section. Link the other tasks by id inside the task files.
- Do **not** create `HANDOFF.md` or `NOTES.md`. A narrative document goes stale
  the moment it is written and competes with the task files for authority.
- Cross-session continuity comes from `tasks/_index.md`, the task files, and
  the git log — not from a narrative document.

## Non-goals (don't add)

- Web frontend / HTTP server. We deleted Express on purpose — the CLI is the
  product. Resurrecting `server/index.mjs` needs an explicit decision.
- Mouse support. Hotkeys are the contract.
- Multi-user, auth, network exposure. Localhost / single user only.
