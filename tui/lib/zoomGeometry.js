// tui/lib/zoomGeometry.js — the ONE place that decides how big a session's
// claude PTY is.
//
// Why this exists: every time MC resizes a claude PTY, claude reprints its
// whole frame at the new width and the pre-resize copy stays in the
// xterm-headless scrollback. Measured against claude 2.1.220 (repro:
// spawn at 80x24, send /help, resize):
//
//     boot at 80 cols ............ 1 copy of the frame in the buffer
//     resize to 214 cols ......... 2 copies  (one 80-wide, one 214-wide)
//     resize back to 80 .......... 2 copies
//     resize to 214 again ........ 3 copies
//
// That is the "text double prints, one narrow one full width" bug. Rows-only
// growth duplicates too; only a resize to the SAME dimensions is free.
//
// So the geometry is fixed for an agent's whole life: computed once from the
// real terminal, applied at spawn, and changed ONLY when the user resizes
// their terminal (where a repaint is expected). Zoom enter/exit, toasts, and
// the optional stats/todos panels no longer touch the PTY — PtyPane renders
// whatever slice of the emulator fits instead.
//
// Consumed by tui/main.jsx (boot: Fleet viewport) and tui/App.jsx (live
// terminal resize + the zoom modal's own width). The server layer only ever
// receives the resulting numbers.

// Zoom modal width clamp — mirrors App.jsx's modalWidth(min, max) contract.
// min keeps a narrow terminal readable; max stops lines being too wide to scan.
export const ZOOM_MODAL_MIN = 104;
export const ZOOM_MODAL_MAX = 220;

// Chrome the Zoom modal spends horizontally around the PTY body:
// border (2) + paddingX=2 on both sides (4). Mirrors Zoom.jsx's innerW.
export const ZOOM_CHROME_COLS = 6;

// Worst-case chrome the Zoom modal spends VERTICALLY, so the PTY is sized to
// the largest body it can ever be given and the optional panels only ever
// make the rendered slice smaller (never the PTY):
//   3  App wrapper paddingY=2 + StatusBar 1
//   2  FeedbackStrip at its minimum (1 header + 1 content row)
//   9  Zoom's own always-on rows (2 border + 2 padY + header + marginTop +
//      compact stats + PTY marginTop + footer)
// = 14. Keep in step with Zoom.jsx's fixedRows and App.jsx's zoomHeight.
export const ZOOM_CHROME_ROWS = 14;

// The width the zoom modal renders at, for a given terminal width.
// App.jsx subtracts 4 for its own paddingX before clamping.
export function zoomModalWidth(termCols) {
  const usable = Math.max(20, (termCols | 0) - 4);
  return Math.min(ZOOM_MODAL_MAX, Math.max(ZOOM_MODAL_MIN, usable));
}

// The PTY geometry for every agent in the fleet: the largest zoom body this
// terminal can show. Both numbers are floors-clamped so a tiny or unknown
// terminal still yields a usable PTY instead of a 0-column one.
export function zoomBodyDims(termCols, termRows) {
  return {
    cols: Math.max(20, zoomModalWidth(termCols) - ZOOM_CHROME_COLS),
    rows: Math.max(6, (termRows | 0) - ZOOM_CHROME_ROWS),
  };
}
