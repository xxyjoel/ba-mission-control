---
id: 0326
title: Author tests for cd-at-fresh-prompt and cd path injection safety
goal: overlay-terminal
size: S
testability: 5
deps: [0311, 0322]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts cdToCwd emits `cd` at a fresh prompt and is a no-op mid-command
  - Test asserts a malicious cwd cannot inject a second command via the cd quoting
---

## Why
Paired tests for the cd-on-focus logic (0311) and its security review (0322).
Grouped because both exercise cdToCwd through the same shellSession stub.

## How (sketch)
- forge-test-author writes tests/server/shellSession.cd.test.mjs + shellSession.injection.test.mjs.
- Reuse the node-pty stub from 0325.
- Injection case: cwd `/tmp/a'; touch PWNED` proves the POSIX quoting prevents the second command.

## Out of scope
- Kill/resize (0333), shutdown/logging (0334), spawn/term (0325).

## Followups

## Paired test
This IS the test task. Run: `npm test -- tests/server/shellSession.cd.test.mjs tests/server/shellSession.injection.test.mjs`.

Test files:
- `tests/server/shellSession.cd.test.mjs` (pre-existing, 8 tests — AC#1: fresh-prompt emit, no-op mid-command, quoting)
- `tests/server/shellSession.injection.test.mjs` (new, 8 tests — AC#2: injection safety)

Run command: `node --import tsx --test --test-timeout=30000 --test-force-exit tests/server/shellSession.cd.test.mjs tests/server/shellSession.injection.test.mjs`

## Bugs filed

## Result

Tests written and passing (2026-07-23). This is retroactive paired testing —
`server/shellSession.mjs` was implemented in 0311 and security-reviewed in 0322
before this task ran. Both acceptance criteria are pinned:

**AC#1** (emit at fresh prompt / no-op mid-command): already covered by the
pre-existing `shellSession.cd.test.mjs` (8 tests, all green).

**AC#2** (malicious cwd injection safety): `shellSession.injection.test.mjs`
(8 new tests, all green) verifies that POSIX single-quote escaping neutralises
`;`, `$()`, backtick, `|`, `\n`, `&&`, embedded `'`, and combined metacharacters
— specifically the How-sketch case `/tmp/a'; touch PWNED` produces a single
`pty.write()` with the entire path as a literal argument, no command breakout.

Outcome: 16/16 shellSession tests pass (plus 4 spawn tests = 20/20 combined).
No impl changes; tests only.
