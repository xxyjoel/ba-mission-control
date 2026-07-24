---
id: 0333
title: Author tests for shellSession kill-clears-singleton and resize
goal: overlay-terminal
size: S
testability: 5
deps: [0312]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts killShellSession() kills the pty and a later getShellSession() spawns fresh
  - Test asserts resizeShellSession() forwards to both pty.resize and term.resize
---

## Why
Paired tests for the singleton lifecycle API (0312) — teardown and resize.

## How (sketch)
- forge-test-author writes tests/server/shellSession.lifecycle.test.mjs.
- Reuse the node-pty stub from 0325. Spy on pty.kill / pty.resize / term.resize.
- Assert singleton is nulled after kill (identity differs on next getShellSession()).

## Out of scope
- cd/injection (0326), shutdown/logging (0334), spawn/term (0325).

## Followups

## Paired test
This IS the test task. Run: `npm test -- tests/server/shellSession.lifecycle.test.mjs`.

## Bugs filed

## Result

Acceptance satisfied by the 0312 paired-test commit `4819290`
(`0312: paired test for kill/resize lifecycle`), which created
`tests/server/shellSession.lifecycle.test.mjs` covering both criteria:

- **Criterion 1 — kill clears singleton:**
  - `killShellSession() no-ops safely when no session exists`
  - `killShellSession() clears the singleton: next call spawns a second PTY`
  - `killShellSession() calls pty.kill("SIGTERM")`
  - `killShellSession() disposes the xterm Terminal when available`
- **Criterion 2 — resize forwarded to both pty and term:**
  - `resizeShellSession() no-ops safely when no session exists`
  - `resizeShellSession(cols, rows) calls pty.resize with the given dims`
  - `resizeShellSession(cols, rows) calls term.resize with the given dims when term is available`

Test file run: 7/7 pass (114ms). Full suite: 91/91 files pass.
No new test code was needed — task 0333 is a re-statement of 0312's test deliverable.
Cost: N/A (local process only, no cloud resource).
