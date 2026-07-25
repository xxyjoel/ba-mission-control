---
id: 0330
title: Ensure command-bar/filter mode does not swallow `!` unexpectedly
goal: overlay-terminal
size: XS
testability: 5
deps: [0316]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - While cmdMode !== 'normal', `!` types into the buffer (does NOT open the overlay)
  - In normal mode with no modal, `!` opens the overlay
---

## Why
App's useInput gives command-bar/filter input priority over hotkeys (the
`if (cmdMode !== 'normal')` early return). A user typing `!` into a `:` command
or `/` filter must get a literal `!`, not the overlay — verify the ordering is
correct and doesn't regress.

## How (sketch)
- Confirm the `!` binding sits AFTER the `if (cmdMode !== 'normal') { ... return; }` block and after `if (modal) return;`.
- Add an assertion test: enter filter mode, press `!`, assert buffer contains `!` and modal is still null.

## Out of scope
- Changing command-bar behavior. This only verifies precedence.

## Followups

## Paired test
tests/app/shellHotkeyPrecedence.test.jsx — `!` in filter mode types literally; `!` in normal mode opens overlay. Written alongside 0323.

## Bugs filed

## Result

**Files touched:** 1 (tests/app/shellHotkeyPrecedence.test.jsx, NEW)
**LOC delta:** +130 added, 0 removed

**Findings:** No source change was required. App.jsx already satisfies both
acceptance criteria:
- The `if (cmdMode !== 'normal') { … return; }` block at line 1215 handles all
  single non-ctrl/meta characters (including `!`) and returns before the overlay
  handler is reached — criterion #1 confirmed ✓
- The `!` binding (line 1257) sits after both the cmdMode guard (line 1215) and
  the `if (modal) return` guard (line 1241) — criterion #2 confirmed ✓

**Tests written:** 5 tests in shellHotkeyPrecedence.test.jsx:
1. filter mode: `!` types literally into buffer (asserts `/!` visible in frame)
2. command mode: `!` types literally into buffer (asserts `:/!` visible in frame)
3. normal mode: `!` opens shell overlay (subsequent `?` blocked → Help absent)
4. normal mode with live sessions: `!` opens shell overlay
5. guard: entering `/` filter mode then pressing `!` + Esc returns to normal (no overlay set)

**Test result:** 5/5 pass. Full suite: 85 test files, all pass.

**Security (this task):** No shell spawn, no untrusted input, no cloud resource.
cd-injection surface is owned by 0311 (out of scope here).
**Cost:** N/A — local test-only change, no cloud resource.
