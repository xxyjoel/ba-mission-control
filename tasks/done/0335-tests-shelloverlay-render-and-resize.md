---
id: 0335
title: Author tests for ShellOverlay render and keep-warm on unmount + resize
goal: overlay-terminal
size: S
testability: 5
deps: [0315, 0317]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts ShellOverlay renders the term buffer and unmount does NOT kill the pty (keep-warm)
  - Test asserts changing cols/rows props calls resizeShellSession with the new dims
---

## Why
Paired tests for the component render/attach (0315) and resize forwarding (0317)
— including the keep-warm assertion that unmount preserves the singleton pty.

## How (sketch)
- forge-test-author writes tests/shell/ShellOverlay.render.test.jsx + ShellOverlay.resize.test.jsx.
- Stub getShellSession with a persistent term; assert text renders and pty stays alive after unmount.
- Assert resizeShellSession called on size-prop change.

## Out of scope
- Hotkey/routing (0323). Key forwarding (0324). Persistence smoke (0331).

## Followups

## Paired test
This IS the test task. Run: `npm test -- tests/shell/ShellOverlay.render.test.jsx tests/shell/ShellOverlay.resize.test.jsx`.

## Bugs filed

## Result

Verified duplicate: both acceptance criteria were already pinned by tests authored under their respective dependency tasks.

- **Criterion 1** (renders term buffer + unmount does NOT kill pty) → `tests/shell/ShellOverlay.render.test.jsx` (committed under 0315, header: "paired test for task 0315"). Two tests: mount asserts "hello shell" in frame and chrome footer "⌃Q"; unmount asserts `pty._killed === false`.
- **Criterion 2** (cols/rows prop change calls `resizeShellSession` with new dims) → `tests/shell/ShellOverlay.resize.test.jsx` (committed under 0317, header: "paired test for task 0317"). Two tests: resize-forwarding and no-respawn-on-resize.

All 4 target tests pass. Full suite: **91 test files, all pass** (run 2026-07-23). No new test authored — doing so would duplicate existing, correctly-covering tests in violation of the test-author charter ("Add new ones … do not refactor existing tests"). No source changes made. Security: spawn reviewed PASS (task 0322, see plan §4). Cost: N/A (local process).
