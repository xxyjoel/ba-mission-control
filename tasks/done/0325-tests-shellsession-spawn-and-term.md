---
id: 0325
title: Author tests for shellSession spawn singleton and term buffer
goal: overlay-terminal
size: S
testability: 5
deps: [0309, 0310]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts getShellSession() is a singleton and spawns argv-form in $HOME
  - Test asserts the persistent term captures pty output while the overlay is detached
---

## Why
Paired tests for the singleton spawn (0309) and term wiring (0310) — the
keep-warm foundation. Written before/with impl per forge test-first discipline.

## How (sketch)
- forge-test-author writes tests/server/shellSession.spawn.test.mjs + shellSession.term.test.mjs.
- Stub node-pty (mirror the ptyAgent spawn-stub pattern used in existing server tests).
- Assert: two getShellSession() calls === same pty; spawn args are argv-form; cwd is $HOME; term.write fed by pty.onData.

## Out of scope
- cd (0326), kill/resize (0326), injection (0326).

## Followups

## Paired test
This IS the test task. Run: `npm test -- tests/server/shellSession.spawn.test.mjs tests/server/shellSession.term.test.mjs`.

## Bugs filed

## Result

Paired tests exist and pass 8/8 (wall-time ~122 ms).

- `tests/server/shellSession.spawn.test.mjs` — 4 tests covering AC1: singleton
  (one spawn across two calls), argv-form (`_bin === $SHELL`, `_args === []`),
  `cwd === $HOME`, and `/bin/bash` fallback when `$SHELL` unset.
- `tests/server/shellSession.term.test.mjs` — 4 tests covering AC2: `{ pty, term,
  cell }` shape, buffer accumulation while overlay detached (fireData → read back
  from `term.buffer`), multi-chunk survival, and same-term singleton.

**Note — ordering anomaly:** these test files were committed inside the 0309
(`fb79b20`) and 0310 (`f810dc5`) implementation commits rather than in a prior
test-first commit. That violates forge's test-first discipline for this goal slice.
Both acceptance criteria are genuinely pinned and tests pass; the anomaly is
recorded here for retrospective awareness.
