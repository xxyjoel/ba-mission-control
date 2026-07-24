---
id: 0321
title: Add structured dlog telemetry to the shell overlay code paths
goal: overlay-terminal
size: XS
testability: 4
deps: [0309, 0312, 0319]
agent: forge-logging-architect
human_checkpoint: false
acceptance:
  - dlog('shell', ...) fires on spawn, open, cd-issued, close, and kill with pid/cwd context
  - No secrets or full env are logged (only shell path, pid, cwd)
---

## Why
Every new code path needs structured logs so forge-logging-architect has hooks
and users can debug (mc already uses dlog extensively, e.g. `dlog('pty', ...)`).

## How (sketch)
- Use the existing `dlog` (tui/lib/debugLog.js) — same channel style as ptyAgent's `dlog('pty', kind, {...})`.
- Log points: shellSession spawn `{ pid, shell, cwd }`; overlay open/close; cdToCwd `{ cwd, issued }`; kill.
- Redact: never log env or keystroke bytes — only the shell binary path, pid, cwd.

## Out of scope
- A new log sink. Reuse dlog.

## Followups

## Paired test
tests/shell/shellLogging.test.mjs — stub dlog, assert spawn/cd/kill emit with expected fields, no env leak. Written by 0326.

## Bugs filed

## Result

**Status: done (2026-07-23).**

**Instrumentation — already present from deps (0309/0312/0319), verified complete
against acceptance:**
- `server/shellSession.mjs`: `dlog('shell','spawn',{pid,shell,cwd,cols,rows,scrollback})`
  (line 100), `dlog('shell','cd',{pid,dir,emitted})` (line 134),
  `dlog('shell','kill',{pid})` (line 165).
- `tui/modals/ShellOverlay.jsx`: `dlog('shell','overlay-attach',{pid})` (open, line 55),
  `dlog('shell','overlay-detach',{pid})` (close, line 83), plus `overlay-resize`.

All five acceptance code paths (spawn / open / cd-issued / close / kill) emit a
`shell`-scoped record; `pid` is the correlation key on every record, `cwd` rides
on spawn and `dir` on cd (idiomatic structured logging — matches the task's own
paired-test sketch). No new dlog calls were added: the acceptance was satisfied by
the dependency tasks, so this task's deliverable is the pinning test + review.
Adding redundant dlog calls would have been scope creep against a green target.

**Paired test (this task): `tests/shell/shellLogging.test.mjs`** — 6 cases, all pass.
Exercises the REAL dlog end-to-end (MC_DEBUG=1 + throwaway XDG_STATE_HOME, then
reads debug.log) rather than stubbing the named ESM import, so it pins the actual
redaction. Asserts: spawn/cd/kill each emit with expected fields; full lifecycle
fires all three; **redaction** — a sentinel secret planted in `process.env`
(`FAKE_SECRET`) appears NOWHERE in the log, and the spawn record has no `env` key
(field whitelist enforced). Overlay open/close (attach/detach) logging is owned by
0334 (needs Ink render) — not duplicated here.

**Security review (logging-architect + reviewer role):** PASS, no findings.
dlog records carry lifecycle metadata only (pid / shell path / cwd / dir / dims) —
never PTY stdin bytes, buffer contents, or the inherited `process.env`. The
redaction test proves the env-leak class is closed. Consistent with
overlay-terminal.md §2 (secrets in scope) and the §"Security review 0322" spawn/cd
audit already recorded in the plan (referenced, not re-run).

**Cost:** N/A — local `$SHELL` process only; no cloud resource; dlog is a gated
local file append (zero I/O when MC_DEBUG unset).

**Tests:** `npm test` → all 90 test files pass (0 fail). Pre-push gate clear.
