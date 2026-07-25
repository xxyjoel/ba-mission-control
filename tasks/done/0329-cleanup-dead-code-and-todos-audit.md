---
id: 0329
title: Cleanup pass — remove dead scaffolding and harvest overlay TODOs
goal: overlay-terminal
size: XS
testability: 4
deps: [0320, 0324, 0326, 0333, 0334, 0335]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - No unused imports or dead scaffolding remain in shellSession.mjs / ShellOverlay.jsx / shellKeys.js
  - Any deferred work is captured as a specific TODO(<tag>) comment, not left implicit
---

## Why
Required cleanup category. During implementation, temporary scaffolding (e.g. a
placeholder return from 0309 before the term wiring landed) and deferred ideas
(scrollback, prompt-detection heuristic) should be either removed or pinned as
specific TODOs.

## How (sketch)
- Grep the new files for unused imports / dead branches introduced by the incremental split.
- Confirm TODO(fresh-prompt), TODO(shell-scroll), TODO(shell-render) exist and are specific.
- Remove any commented-out zoom-chrome copy that was pasted then rejected.

## Out of scope
- New features. This is hygiene only.

## Followups

## Paired test
30s: `npm run lint` (or eslint) reports no unused vars in the new files; grep confirms TODOs.

## Bugs filed

## Result

**Files touched:** 1 (tui/modals/ShellOverlay.jsx)
**LOC delta:** +8 added, 1 replaced (net +7)
**Test result:** npm test — all 93 test file(s) passed, 0 fail

### Acceptance #1 — No unused imports or dead scaffolding
PASSED. Manual review confirmed:
- `server/shellSession.mjs`: all 4 imports used; no commented-out blocks; no dead branches.
- `tui/modals/ShellOverlay.jsx`: all 9 imports used; no commented-out zoom-chrome blocks.
- `tui/shell/shellKeys.js`: clean — exports `SHELL_KEYS` and `classifyShellKey`, both consumed by ShellOverlay.
No removals were needed; eslint was not available but import-by-import manual audit confirmed all imports have usage sites.

### Acceptance #2 — Deferred work captured as specific TODOs
Three specific TODOs now exist in the three files:

- `TODO(fresh-prompt)` — **already present** in `server/shellSession.mjs:23`. Specific: names the PROMPT_RE heuristic gap, names OSC 7 as the real fix, notes false-negative risk. Retained as-is.
- `TODO(shell-scroll)` — **added** to `tui/modals/ShellOverlay.jsx` at the `buf.viewportY` line. Specific: names that TERM_SCROLLBACK rows are inaccessible, proposes Ctrl+Y/Ctrl+E bindings, references overlay-terminal.md §key-risk.
- `TODO(shell-osc7)` — **added** to `tui/modals/ShellOverlay.jsx` at the `spawnCwd = homedir()` line. Converts a plain "is a followup" comment into a proper tagged TODO. Specific: names ESC]7 parsing as the required mechanism.

`TODO(shell-render)` was NOT added — the render path (rowToRuns + 60fps coalescing) is fully implemented, no implicit deferred render work was found.
