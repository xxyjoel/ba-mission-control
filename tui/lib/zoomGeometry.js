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

// Zoom modal width clamp. ZOOM_MODAL_MIN is a hard FLOOR for degenerate
// terminals only — NOT a preferred width. It used to be 104, which forced a
// 104-col modal onto an 80-col terminal: Ink shrank the border box to fit but
// the PTY body kept its 98 computed columns, so every claude line truncated
// twice (0408/R3). The modal now follows the terminal (termCols - 4 for
// App.jsx's paddingX) and the floor exists only so a tiny/unknown terminal
// still yields a usable box. max stops lines being too wide to scan.
export const ZOOM_MODAL_MIN = 40;
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

// The ONE minimum size for a session's claude PTY. Every layer that clamps a
// PTY dimension (Fleet.setViewport, PtyAgent's constructor and resize, the
// zoom pane, zoomBodyDims below) imports these, so the floor cannot drift
// between layers again — it was 6 in two places and 5 in three.
export const PTY_MIN_COLS = 20;
export const PTY_MIN_ROWS = 6;
export function clampPtyDims(cols, rows, fallbackCols = PTY_MIN_COLS, fallbackRows = PTY_MIN_ROWS) {
  return {
    cols: Math.max(PTY_MIN_COLS, (cols | 0) || fallbackCols),
    rows: Math.max(PTY_MIN_ROWS, (rows | 0) || fallbackRows),
  };
}

// The width the zoom modal renders at, for a given terminal width: the
// terminal minus App.jsx's own paddingX (4), clamped to [MIN, MAX]. Never
// wider than the terminal can actually show (0408/R3).
export function zoomModalWidth(termCols) {
  const usable = (termCols | 0) - 4;
  return Math.min(ZOOM_MODAL_MAX, Math.max(ZOOM_MODAL_MIN, usable));
}

// The inner content width for a modal of `modalWidth` columns: border +
// paddingX removed. Zoom.jsx's innerW and the PTY cols BOTH come from here so
// the modal chrome and the PTY can never disagree about the body width —
// that disagreement was the double-truncation on narrow terminals (0408/R3).
export function zoomInnerWidth(modalWidth) {
  return Math.max(PTY_MIN_COLS, (modalWidth || 0) - ZOOM_CHROME_COLS);
}

// The PTY geometry for every agent in the fleet: the largest zoom body this
// terminal can show. Both numbers are floors-clamped so a tiny or unknown
// terminal still yields a usable PTY instead of a 0-column one.
export function zoomBodyDims(termCols, termRows) {
  return {
    cols: zoomInnerWidth(zoomModalWidth(termCols)),
    rows: Math.max(PTY_MIN_ROWS, (termRows | 0) - ZOOM_CHROME_ROWS),
  };
}
