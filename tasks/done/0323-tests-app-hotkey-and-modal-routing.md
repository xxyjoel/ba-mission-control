---
id: 0323
title: Author tests for the `!` hotkey and shell modal routing
goal: overlay-terminal
size: S
testability: 5
deps: [0316, 0319]
agent: forge-test-author
human_checkpoint: false
acceptance:
  - Test asserts `!` in normal mode sets modal to 'shell' (from FleetView and with a focused card)
  - Test asserts modal 'shell' renders ShellOverlay and cd-on-focus branches correctly (card cwd vs FleetView no-cd)
---

## Why
Paired tests for the App-side entry point (0316) and routing (0319).

## How (sketch)
- forge-test-author writes tests/app/shellHotkey.test.jsx + tests/app/shellRouting.test.jsx.
- Use ink-testing-library with a stubbed getShellSession / cdToCwd (no real pty).
- CLAUDE.md caveat: useInput needs a TTY — drive via the test lib's stdin.

## Out of scope
- Component render/resize tests (0335). Precedence test (0330). Key forwarding (0324).

## Followups

## Paired test
`tests/app/shellHotkey.test.jsx` and `tests/app/shellRouting.test.jsx`

Run: `npm test -- tests/app/shellHotkey.test.jsx tests/app/shellRouting.test.jsx`

Or directly: `node --import tsx --test --test-timeout=30000 --test-force-exit tests/app/shellHotkey.test.jsx tests/app/shellRouting.test.jsx`

## Bugs filed

## Result
DONE — 2026-07-23

Paired tests exist at:
- `tests/app/shellHotkey.test.jsx` (6 tests) — pins AC1: `!` sets modal='shell' from both FleetView and focused card; verified via behavioral proxy (post-`!`, `?` no longer opens Help); regression guards for `1` slot-jump and `b` broadcast.
- `tests/app/shellRouting.test.jsx` (3 tests) — pins AC2: modal='shell' renders ShellOverlay chrome (shell header + ⌃Q footer); cd issued when opened from focused live card; no cd from FleetView.

All 9 tests pass (verified: `node --import tsx --test ...` → 9 pass, 0 fail, ~1.6s).

Note: tests were committed under 0316/0319 (impl deps) rather than a separate 0323 commit — the impl and test tasks ran in overlapping order, inverting the normal fail-first sequence. Both ACs are pinned; the tests are functionally correct.
