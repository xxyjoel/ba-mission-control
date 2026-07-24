---
id: 0324
title: Author tests for ShellOverlay key forwarding and Ctrl+Q close
goal: overlay-terminal
size: S
testability: 5
deps: [0320]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Typing a printable key writes the corresponding bytes to the stub pty
  - Ctrl+Q calls onClose and writes NOTHING to the pty
---

## Why
Paired test for 0320. Verifies the forwarding half end-to-end at the component
level (0314 covers the pure classifier; this covers the wired component).

## How (sketch)
- forge-test-author writes tests/shell/ShellOverlay.keys.test.jsx.
- Mount ShellOverlay with a stub session exposing a spy `pty.write`.
- Assert printable + Ctrl+K/U/J reach pty.write; assert Ctrl+Q triggers onClose and no write.

## Out of scope
- The classifier unit test (0314).

## Followups

## Paired test
File: `tests/shell/ShellOverlay.keys.test.jsx`
Run: `node --import tsx --test --test-timeout=30000 --test-force-exit tests/shell/ShellOverlay.keys.test.jsx`

## Bugs filed

## Result

Test file `tests/shell/ShellOverlay.keys.test.jsx` (153 LOC, 4 tests) was authored
and bundled under task 0320 (commit 247675f) per the combined-role prompt that
assigned test-author alongside code-implementer for that task.

Both acceptance criteria are pinned:
- AC1 (printable key → pty.write): covered by test 1 ("forwards a plain letter keystroke to the pty via keyToBytes") — writes 'a' via stdin.write, asserts pty.writeCalls contains 'a'.
- AC2 (Ctrl+Q → onClose, no pty.write): covered by test 4 ("closes the overlay on Ctrl+Q and does NOT write to the pty") — writes 0x11 via stdin.write, asserts closed===true and writeCalls empty.

Bonus: tests 2 and 3 cover Ctrl+K (0x0b) and Ctrl+U (0x15) — readline keys that must NOT be swallowed (per overlay-terminal.md key-risk section).

Mutation check (forge-test-author gate): temporarily removed `onClose?.()` and early return from the EXIT branch — test 4 went red ("onClose() must be called on Ctrl+Q / false !== true"). Reverted; all 4 pass.

Run results: pass 4/4, fail 0, ~700ms wall time.

Security: no stdin bytes logged; dlog logs lifecycle metadata only (pid) — reviewed in plan §0322 (commit per 0320 diff). Cost: N/A (local process). dlog telemetry landed under 0321.
