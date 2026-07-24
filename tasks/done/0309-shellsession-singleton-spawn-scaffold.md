---
id: 0309
title: Add server/shellSession.mjs singleton with argv-form $SHELL spawn
goal: overlay-terminal
size: S
testability: 4
deps: [0307]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - getShellSession() lazily spawns node-pty running $SHELL (fallback /bin/bash) via argv-form, in $HOME
  - Second call to getShellSession() returns the SAME pty (singleton, not a new spawn)
---

## Why
Keep-warm persistence means the PTY must outlive the modal — it cannot be owned
by the React component (which mounts/unmounts). A module-level singleton owns
spawn/kill, mirroring the PtyAgent-owns-term / PtyPane-attaches-view split.

## How (sketch)
- New `server/shellSession.mjs` exporting `getShellSession()` — lazy singleton.
- Resolve shell: `process.env.SHELL || '/bin/bash'`; spawn via node-pty argv-form (name xterm-256color, cwd $HOME, env passthrough).
- NEVER interpolate `$SHELL`/cwd into a shell string — pass the binary as argv[0], empty args.
- Return `{ pty }` for now; term buffer added in 0310. Keep this task ≤100 LOC.

## Out of scope
- xterm-headless term buffer wiring (0310), resize (0317), cd-on-focus (0311), kill (0312).

## Followups

## Paired test
tests/server/shellSession.spawn.test.mjs — asserts singleton identity + argv-form (stub node-pty), $HOME cwd. Written by 0325.

## Bugs filed

## Result

**Status:** done · 2026-07-23

**Files touched (2):**
- `server/shellSession.mjs` — NEW (58 LOC): module-level singleton, `getShellSession({ spawn? })` lazy spawn, argv-form `$SHELL` as argv[0] with empty args, cwd=`$HOME`, env passthrough + TERM override, `dlog` lifecycle event, `_resetForTest` seam.
- `tests/server/shellSession.spawn.test.mjs` — NEW (82 LOC): 4 tests covering argv-form, cwd=$HOME, singleton identity, /bin/bash fallback — all via stub spawn, no real PTY.

**LOC delta:** +140 added / 0 removed (2 new files)

**Test result:** 4/4 new tests pass · full suite 79/79 files pass

**Security (0307 scope):**
- Spawn is argv-form: `$SHELL` as argv[0], args=[], cwd and env as structured options — zero shell-string interpolation. Mirrors ptyAgent.mjs:320-326 exactly.
- `dlog` records lifecycle metadata only (pid, shell binary, cwd) — never PTY stdin bytes or buffer contents.
- `cd` injection surface (card.cwd) is out of scope here; flagged to 0311.

**Cost:** N/A — local process, no cloud resource.
