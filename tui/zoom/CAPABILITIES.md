# Zoom PTY capability audit

What we forward, what xterm-headless absorbs transparently, what we
silently drop. Reference for understanding why a given claude feature
behaves correctly (or doesn't) inside Mission Control's Zoom modal.

> Generated alongside Task E of `.claude/plans/zoom-followups.md`.
> If you change behavior in `tui/zoom/PtyPane.jsx`, update the matching
> row below.

## Summary table

| Sequence / feature | Status | Notes |
|---|---|---|
| Bracketed paste (`CSI ?2004h`) | ✓ Handled | Task A: we wrap multi-char Ink input in `CSI 200~ … 201~` when `term.modes.bracketedPasteMode === true`. |
| Alt-screen (`CSI ?1049h`) | ✓ Transparent | xterm-headless swaps `buffer.active` automatically. Our renderer always reads from `buffer.active`, so any full-screen claude UI Just Works. |
| SGR colors (16 / 256 / RGB) | ✓ Translated | `ptyCells.js` maps `cellRef.getFgColorMode()` / `getBgColorMode()` to Ink `<Text color/backgroundColor>`. Bold / italic / underline / dim / inverse / strikethrough preserved. |
| Cursor positioning + visibility | ✓ Painted | `PtyPane.jsx` reads `buf.cursorY` / `cursorX` and forces a hard-painted accent block at that cell — does not rely on Ink's flaky `inverse` for whitespace cells. |
| Resize (SIGWINCH) | ✓ Forwarded | `tui/App.jsx:165-173` subscribes to `stdout 'resize'`; new dims propagate via props to PtyPane's `useEffect([cols,rows])` which calls `pty.resize` + `term.resize` + `term.scrollToBottom`. |
| Synchronized output (`CSI ?2026h`) | ✓ Internal | xterm-headless buffers writes between BSU / ESU markers. |
| Bell (`\x07`) | ✗ Dropped | `term.onBell` fires but we don't forward. Easy fix: subscribe and write `\x07` to `process.stdout`. |
| Title set (`OSC 0/1/2`) | ✗ Dropped | `term.onTitleChange` fires but we don't surface. Could overlay in the Zoom header (e.g. claude's current working topic). |
| Hyperlinks (`OSC 8`) | ⚠ Partial | xterm-headless stores the URL as cell metadata, but Ink's `<Text>` doesn't re-emit `OSC 8` to the host terminal, so clickable links won't reach iTerm / Terminal.app. Workaround: print the URL inline (claude usually does). |
| Clipboard (`OSC 52`) | ✗ Dropped | If claude writes to the clipboard, the sequence dies in xterm-headless. Fix: register an OSC 52 handler that pipes raw payload through `process.stdout.write` so the host terminal honors it. |
| `cwd` reporting (`OSC 7`) | ✗ Dropped | claude rarely uses this; ignore unless a real bug surfaces. |
| Application cursor keys (`DECCKM`) | ⚠ Partial | `term.modes.applicationCursorKeysMode` tracked; our `ptyKeys.js` always emits the cursor-keys variant (`CSI` form). Claude doesn't appear to depend on the application-mode variant (`ESC O X`) but if a future version does, arrows in claude's prompt editor could feel off. |
| Application keypad (`DECNKM`) | ✗ Not differentiated | We emit normal-mode bytes regardless. Numeric keypad input via SSH-only edge cases. Defer unless reported. |
| Mouse tracking (`DECSET 1000-1003`) | ✗ Dropped | `term.modes.mouseTrackingMode` tracked but Ink's `useInput` doesn't surface mouse events on macOS terminals and we don't forward them. claude doesn't currently use mouse; revisit if it adds support. |
| Focus events (`DECSET 1004`) | ✗ Dropped | We don't forward focus in/out. claude doesn't appear to act on these. |
| Cursor shape (`CSI Sp q`) | ⚠ Cosmetic | xterm-headless parses but we render a fixed-style block cursor regardless. Acceptable — cursor shape is theming, not functionality. |

## Architectural limitations

Some gaps are not bugs but consequences of rendering claude's terminal
output through Ink rather than connecting the PTY directly to the host
terminal:

- **No clickable links.** OSC 8 hyperlink markers are stored by
  xterm-headless on the affected cells, but Ink renders `<Text>`
  nodes without re-emitting OSC 8 to the host terminal. Even if we
  forwarded the sequence, the link's position in our rendered output
  wouldn't match where it landed in the host terminal's row/col grid
  (Ink reflows our Box layout independently). Fix would require
  bypassing Ink for the cell range covered by the link — not
  feasible.
- **No image protocols.** Kitty graphics, iTerm2 inline images, and
  Sixel are not supported by xterm-headless and would not survive
  Ink's re-rendering pipeline. claude doesn't use these today.
- **Mouse will never feel native.** Even if we forward mouse events
  to the PTY, Ink's coordinate system is Ink-relative, not host-
  terminal-relative — clicks would need translation.

## Concrete follow-ups (filed as separate tasks)

- **F1 — Forward OSC 52 (clipboard).** ~10 LOC: subscribe to the OSC
  52 parser handler, re-emit to `process.stdout.write` so the host
  terminal can copy to the system clipboard. Real user-visible win
  when claude offers "copy this snippet."
- **F2 — Forward Bell.** ~3 LOC: `term.onBell(() => process.stdout.write('\x07'))`. Low effort, makes claude's notifications audible.
- **F3 — Reflect title in Zoom header.** ~10 LOC: subscribe to
  `term.onTitleChange`, surface the most recent title in the modal
  header's right edge. claude sets the title to the conversation
  topic — useful for fleet-level identification.

The first two are tiny and worth doing now; F3 is a UX add and can
land later.
