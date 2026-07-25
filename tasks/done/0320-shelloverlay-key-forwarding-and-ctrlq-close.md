---
id: 0320
title: Forward keystrokes to the shell PTY; Ctrl+Q closes the overlay
goal: overlay-terminal
size: S
testability: 4
deps: [0313, 0315]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - ShellOverlay's useInput routes every non-chrome key through keyToBytes to the pty
  - Ctrl+Q (classifyShellKey === 'EXIT') calls onClose and is NOT written to the pty
---

## Why
The interactive half. Everything the user types must reach the shell verbatim
(including Ctrl+K/U/J readline keys); only Ctrl+Q is intercepted to close the
overlay back to the grid.

## How (sketch)
- Add a `useInput` in ShellOverlay (isActive when overlay focused). First: `if (classifyShellKey(input,key) === 'EXIT') { onClose?.(); return; }`.
- Otherwise `const bytes = keyToBytes(input, key); if (bytes != null) pty.write(bytes);` — reuse ptyKeys.js as-is.
- Reuse PtyPane's bracketed-paste guard for multi-char input if term.modes.bracketedPasteMode is on.
- Do NOT import ZOOM_KEYS or classifyZoomKey anywhere in this file.

## Out of scope
- Scroll mode (not in scope for MVP overlay). Resize (0317).

## Followups
- TODO(shell-scroll): consider Ctrl+Y scrollback later; keep chrome minimal for now.

## Paired test
Covered by 0314 (classifier) + tests/shell/ShellOverlay.keys.test.jsx (forwarding + Ctrl+Q close). Written by 0324.

## Bugs filed

## Result

**Files touched:** 2
- `tui/modals/ShellOverlay.jsx` — added `keyToBytes` import + `ptyRef` ref; updated
  `useInput` to forward all non-EXIT keys via `keyToBytes → pty.write`; added
  bracketed-paste guard mirroring PtyPane; removed stale `TODO(shell-keys)` comments.
- `tests/shell/ShellOverlay.keys.test.jsx` — NEW: 4-case paired test covering
  plain-letter forward, Ctrl+K forward, Ctrl+U forward, and Ctrl+Q close (no pty write).

**LOC delta:** ShellOverlay.jsx +35/-4 = 39 net; test file +153 (new).

**Test result:** pass — 89/89 test files pass (`npm test`).

**Security review:** keystrokes are forwarded verbatim to the PTY via `keyToBytes`;
no stdin bytes are logged — `dlog` is lifecycle-only (attach/detach/resize).
Bracketed-paste guard mirrors PtyPane. §2 of overlay-terminal.md honored.

**Cost:** N/A — local process only; no cloud resource.
