---
id: 0328
title: Document the shell overlay and `!` hotkey in README
goal: overlay-terminal
size: XS
testability: 4
deps: [0316, 0320]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - README describes the overlay feature, the `!` open / Ctrl+Q close hotkeys, and the keep-warm behavior
  - The hotkey table (if present) includes `!`
---

## Why
CLAUDE.md workflow rule: update README after every merge to main. The new
hotkey, modal, and keep-warm lifecycle must be reflected for users.

## How (sketch)
- Add a short "Shell overlay" subsection: what it's for (aws sso login, git, kubectl), `!` to open, Ctrl+Q to close, persistent across close/reopen, cd-into-focused-repo behavior.
- Update any hotkey table/list to include `!` and Ctrl+Q.

## Out of scope
- The Help modal (0327).

## Followups

## Paired test
Manual 30s: README renders, section present, hotkey table updated.

## Bugs filed

## Result

**Files touched:** `README.md` (1 file)
**LOC delta:** +12 lines added, 0 removed
**Test result:** pass — all 93 test files passed (npm test exit 0)

Changes made:
- Added `!` row to the main Hotkeys table: "Open shell overlay — a persistent `$SHELL` pane for `aws sso login`, `git`, `kubectl`, etc."
- Added "Shell overlay (`!`)" subsection after the Zoom/Slash commands section documenting: open (`!`), close (`Ctrl+Q`), key-forwarding behavior, keep-warm lifecycle, and focused-card `cd` behavior.

**Security:** documentation only — no code touched; N/A.
**Cost:** N/A — local process, no cloud resource.
