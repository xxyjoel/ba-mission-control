// tui/lib/gridLayout.js — pure card-grid geometry + pagination.
//
// Extracted from App.jsx so the row math is testable: ink-testing-library
// can't set terminal ROWS, so the old inline math (and its overflow-clip bug)
// couldn't be pinned by a test. Everything here is a pure function of its
// inputs — no React, no I/O.
//
// Pagination model (replaces the old scroll viewport): cards are split into
// "panes" of at most `windowsPerPane`, and never more than physically fit the
// terminal height (so a pane can't be clipped). Overflow spills to the next
// pane. The active pane follows the focused card. This fixes the "10th
// session collapses the grid / can only see six cards" report (2026-07-01):
// instead of clipping the rows that don't fit, we page them.

export const CARD_H = 11;         // must match Card.jsx height={11}
export const MIN_CARD_W = 20;
const HEADER_H = 1;
const AGG_H = 1;
const FEEDBACK_H = 2;
const STATUS_H = 1;
const FLEETLOG_HEAD_H = 1;        // " ▸ FLEET LOG · N events" row
const PAGER_H = 1;                // "pane 2/3 · [ ] to switch" strip

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// computeGridLayout — given terminal size, column preference, live-card count,
// the fleet-log line budget, the per-pane cap, and the focused card's index,
// return the geometry needed to render one pane of the grid.
//
// Returns:
//   effectiveCols  — columns actually used (auto-reduced on narrow terminals)
//   cardW          — per-card width in columns
//   perPage        — cards shown per pane (min of windowsPerPane and what fits)
//   pageCount      — number of panes
//   pageIndex      — active pane (0-based), derived from focusedIndex
//   pageStart/pageEnd — slice bounds into the visible-agent list for this pane
//   rowsInPage     — grid rows rendered in the active pane
//   dynamicFleetLogLines — fleet-log height that fills the leftover space
export function computeGridLayout({
  termCols,
  termRows,
  gridCols,
  count,
  fleetLogLines,
  windowsPerPane = 0,
  focusedIndex = 0,
}) {
  const n = Math.max(0, count | 0);
  // Guard non-finite terminal dims (a non-TTY stdout reports undefined rows/
  // columns → NaN would poison every downstream number and render zero cards).
  // Fall back to a sane roomy terminal so the grid degrades to "show all".
  const cols = Number.isFinite(termCols) ? termCols : 180;
  const trows = Number.isFinite(termRows) ? termRows : 50;

  // Column sizing — cap at gridCols, auto-reduce so cards never spill past the
  // right edge at the 20-col minimum.
  const desiredCols = Math.max(1, Math.min(gridCols, n || 1));
  const colsThatFit = Math.max(1, Math.floor((cols - 2) / MIN_CARD_W));
  const effectiveCols = Math.min(desiredCols, colsThatFit);
  const cardW = Math.max(MIN_CARD_W, Math.floor((cols - 2) / effectiveCols));

  // Vertical budget — reserve the pager strip unconditionally so single-page
  // vs. multi-page don't reflow the fleet log when a pane boundary is crossed.
  const chromeH = HEADER_H + AGG_H + FEEDBACK_H + STATUS_H + FLEETLOG_HEAD_H + fleetLogLines + PAGER_H;
  const gridBudgetH = Math.max(CARD_H, trows - chromeH);
  const rowsThatFit = Math.max(1, Math.floor(gridBudgetH / CARD_H));

  // Per-pane cap: the user's windowsPerPane, but never more than physically
  // fit (else we'd clip). 0/unset → fit as many as the terminal allows.
  const capByFit = effectiveCols * rowsThatFit;
  const perPage = windowsPerPane > 0 ? Math.min(windowsPerPane, capByFit) : capByFit;

  const pageCount = n === 0 ? 1 : Math.ceil(n / perPage);
  const fIdx = focusedIndex >= 0 ? focusedIndex : 0;
  const pageIndex = clamp(Math.floor(fIdx / perPage), 0, pageCount - 1);
  const pageStart = pageIndex * perPage;
  const pageEnd = Math.min(n, pageStart + perPage);
  const rowsInPage = Math.max(0, Math.ceil((pageEnd - pageStart) / effectiveCols));

  // Fleet log fills whatever's left after the actually-rendered grid + chrome.
  const pagerActual = pageCount > 1 ? PAGER_H : 0;
  const fixedH = HEADER_H + AGG_H + (rowsInPage * CARD_H) + pagerActual
    + FEEDBACK_H + STATUS_H + FLEETLOG_HEAD_H;
  const remainingH = Math.max(0, trows - fixedH);
  const dynamicFleetLogLines = Math.max(fleetLogLines, remainingH);

  return {
    effectiveCols,
    cardW,
    perPage,
    pageCount,
    pageIndex,
    pageStart,
    pageEnd,
    rowsInPage,
    dynamicFleetLogLines,
  };
}

// Chunk a flat list into rows of `cols` — the per-pane card layout.
export function chunkRows(items, cols) {
  const rows = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}
