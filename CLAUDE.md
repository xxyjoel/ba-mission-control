# Project: BlueArch Mission Control

Keyboard-first terminal TUI for managing up to 10 real `claude` CLI agent
sessions. Stack: Node 20+ · Ink (React for terminals) · `tsx` for JSX runtime ·
no build step.

## Repo layout (orient yourself before edits)

- `bin/mc.mjs` — CLI entry, registers `tsx` JSX loader, imports `tui/main.jsx`
- `tui/main.jsx` — boots the Fleet, renders `<App/>`, wires shutdown
- `tui/App.jsx` — top-level: hotkeys, focus, modal routing, fleet subscription
- `tui/Card.jsx`, `Header.jsx`, `Aggregate.jsx`, `FleetLog.jsx`, `StatusBar.jsx`
- `tui/modals/{Help,Broadcast,NewSession,Settings,Zoom}.jsx`
- `tui/lib/{themes,format,models,settings,TextField}` — palettes, render helpers,
  Claude-model metadata, on-disk settings persistence, minimal text input
- `server/` — **data layer only, no HTTP.** `Fleet` (EventEmitter, 10 slots),
  `Agent` (one `claude` subprocess per slot, stream-json I/O), `git`, `repos`

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
- Before touching anything in `server/agent.mjs`, recognize that it is
  managing a real `claude` subprocess. Pause/resume use POSIX signals
  (SIGSTOP/SIGCONT). Don't introduce sleeps in the event handler — the
  stream-json wire format is line-oriented and we must drain stdout.
- Always prefer adding a TODO comment over deferring work in chat. Format:
  `// TODO(<short-tag>): <what + why>` at the relevant line.

## Records — task db only (org directive, 2026-08-15)

The task db (`tasks/`) is the single record for this project. The HANDOFF
method is retired (archive: `docs/archive/HANDOFF-retired-2026-08-15.md`).

- Write the narrative context of a change in the task's **Why** section.
- Write the outcome (sha, files, test result) in the task's **Result** section.
- For an incident that spans tasks, put the full story in the first task's
  Why section. Link the other tasks by id inside the task files.
- Do **not** create `HANDOFF.md` or `NOTES.md`. The forge pre-push gate
  activates when such a file exists, and it would block pushes again.
- Cross-session continuity comes from `tasks/_index.md`, the task files, and
  the git log — not from a narrative document.

## Non-goals (don't add)

- Web frontend / HTTP server. We deleted Express on purpose — the CLI is the
  product. Resurrecting `server/index.mjs` needs an explicit decision.
- Mouse support. Hotkeys are the contract.
- Multi-user, auth, network exposure. Localhost / single user only.


<!-- forge:claude-md:v2 -->
## Forge integration

This project uses **forge** (`~/.claude/forge/`) for goal decomposition,
task tracking, GitFlow discipline, security review, cost gates, and
self-improvement telemetry.

### Authority

While forge is installed, **forge is THE authoritative operating procedure for
this project** — not a default that can be worked around. All of the following
flow through forge and nowhere else:

- **Tasks** — created, tracked, and closed through the `tasks/` tree (never ad-hoc).
- **Issues** — filed via `forge-bug-logger`; kept in parity with tasks by `/forge:sync`.
- **Planning** — charters in `.claude/plans/`, decomposed via `/forge:goal`.
- **Objectives** — tracked in `docs/objectives.md` (the conformance contract).
- **Conformance** — `/forge:doctor` verifies this project obeys every directive.

When this section conflicts with another project convention, **forge wins for
this project.** Bypassing a forge gate requires `FORGE_SKIP=1` (logged), never a
silent workaround.

### Entry points

- `/forge:goal "<one-line goal>"` — start a new initiative
- `/forge:status` — see the dashboard
- `/forge:deploy <target>` — gated cloud deploy
- `/forge:improve` — run the telemetry → improvement-tasks loop
- `/forge:context-check` — should we /compact or /clear?

### Conventions

- **Tasks** live in `tasks/{open,in_progress,done,archive}/` as `<id>-<slug>.md`
  files with YAML frontmatter. The `tasks/_template.md` defines the schema.
- **Plans** live in `.claude/plans/` (project-scoped, per the user's
  ~/.claude/CLAUDE.md rule).
- **Hooks** are symlinked into `.githooks/` (set `git config core.hooksPath
  .githooks`). They enforce bite-sized commits, gate pushes on tests + HANDOFF,
  and audit task closure on merge.

### Agent roster

Forge ships 13 specialized subagents. Common ones to invoke directly:

- `forge-code-implementer` — implement ONE bite-sized task
- `forge-test-author` — write the paired test first
- `forge-test-runner` — execute tests, hand failures to bug-logger
- `forge-security-reviewer` — pre-push diff audit (code security)
- `forge-deploy-reviewer` — single pre-deploy gate: all 6 WAF pillars + cost estimate
- `forge-improve` — post-deploy observability + telemetry→improvement loop (cost variance, energy/perf, usage distill)

Full list: `ls ~/.claude/forge/agents/`.

### Hard rules

- Tasks > 3 files or > 100 LOC must be split.
- Code formatting is enforced at commit by the `pre-commit` format gate —
  staged files only, block on drift, detect (never install) the project's
  formatter. Override with `.forge-format`. See `docs/formatting.md`.
- Every cloud deploy goes through `/forge-deploy` (never raw `terraform apply`).
- Security review runs on every push to `main`.
- Improvement tasks from `forge-improve` are ALWAYS surfaced for
  human approval — the system never auto-acts on user telemetry.
<!-- /forge:claude-md:v2 -->
