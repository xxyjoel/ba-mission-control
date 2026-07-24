---
id: 0334
title: Author tests for shell-killed-on-shutdown and dlog telemetry
goal: overlay-terminal
size: S
testability: 5
deps: [0318, 0321]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts main.jsx shutdown path calls killShellSession()
  - Test asserts dlog fires on spawn/cd/kill with expected fields and never logs env or keystroke bytes
---

## Why
Paired tests for shutdown wiring (0318) and structured logging (0321) — the two
cross-cutting concerns that keep the shell from orphaning and give operators
debug hooks.

## How (sketch)
- forge-test-author writes tests/app/shellShutdown.test.mjs + tests/shell/shellLogging.test.mjs.
- Stub killShellSession and dlog; assert invocation on the shutdown path and correct log fields.
- Assert no env object or raw bytes appear in any dlog payload.

## Out of scope
- cd/injection (0326), lifecycle/resize (0333), spawn/term (0325).

## Followups

## Paired test
This IS the test task. Run: `npm test -- tests/app/shellShutdown.test.mjs tests/shell/shellLogging.test.mjs`.

## Bugs filed

## Result

Verified duplicate close — both acceptance criteria already satisfied by tests
committed under dependency tasks 0318 and 0321.

**Criterion 1** ("shutdown path calls killShellSession()"):
→ `tests/app/shellShutdown.test.mjs` (committed under 0318). 5 source-level
  structural tests: import assertion, shutdown() body, process.on('exit') body,
  clean-quit tail after waitUntilExit(), and exact-count (3 call sites). All
  5 pass.

**Criterion 2** ("dlog fires on spawn/cd/kill with expected fields and never
logs env or keystroke bytes"):
→ `tests/shell/shellLogging.test.mjs` (committed under 0321). 6 tests:
  - spawn emits shell/spawn with pid, shell, cwd
  - cd emits shell/cd with pid and dir when at fresh prompt
  - kill emits shell/kill with pid
  - full lifecycle fires spawn+cd+kill in sequence
  - redaction: env sentinel secret never reaches the log (acceptance #2)
  - redaction: spawn record carries no full-env blob (field whitelist enforced)

**Keystroke bytes coverage (honest accounting):** The "never logs keystroke
bytes" sub-clause is covered by field-whitelist + absence of any dlog call on
the keystroke path. All dlog() calls in shellSession.mjs are spawn/cd/kill with
fixed lifecycle fields (grep confirms 3 call sites, none on the onData/ptyKeys
path). The field-whitelist test (allowed Set: t, scope, msg, pid, shell, cwd,
cols, rows, scrollback) would fail if any keystroke data leaked into the spawn
record. No dedicated keystroke-log test authored — would be over-authoring for a
clean-absence assertion.

Security: PASS — lifecycle metadata only, no PTY bytes / buffer / env (per
overlay-terminal.md §0322 review, line 177–195).

Cost: N/A (local process only; no cloud resource provisioned).

Target tests: 11/11 pass. Full suite: 91/91 files pass.
