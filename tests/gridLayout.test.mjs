// tests/gridLayout.test.mjs — pure pane geometry (the reason the math was
// extracted from App.jsx: terminal ROWS can be injected here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout, chunkRows, MIN_CARD_W } from '../tui/lib/gridLayout.js';

// A roomy terminal that fits many rows: 200 rows ≈ 17 card rows of budget.
const TALL = { termCols: 180, termRows: 200, gridCols: 5, fleetLogLines: 10 };

test('grid: 9 cards, windowsPerPane 9 → single pane, no paging', () => {
  const l = computeGridLayout({ ...TALL, count: 9, windowsPerPane: 9, focusedIndex: 0 });
  assert.equal(l.pageCount, 1);
  assert.equal(l.perPage, 9);
  assert.equal(l.pageStart, 0);
  assert.equal(l.pageEnd, 9);
});

test('grid: 10th card with windowsPerPane 9 → second pane (the bug fix)', () => {
  // Focus on the 10th card (index 9) → we should be on pane 2/2, not clipped.
  const l = computeGridLayout({ ...TALL, count: 10, windowsPerPane: 9, focusedIndex: 9 });
  assert.equal(l.pageCount, 2);
  assert.equal(l.pageIndex, 1);
  assert.equal(l.pageStart, 9);
  assert.equal(l.pageEnd, 10);
});

test('grid: pane follows the focused card', () => {
  const base = { ...TALL, count: 20, windowsPerPane: 9 };
  assert.equal(computeGridLayout({ ...base, focusedIndex: 0 }).pageIndex, 0);
  assert.equal(computeGridLayout({ ...base, focusedIndex: 8 }).pageIndex, 0);
  assert.equal(computeGridLayout({ ...base, focusedIndex: 9 }).pageIndex, 1);
  assert.equal(computeGridLayout({ ...base, focusedIndex: 18 }).pageIndex, 2);
});

test('grid: short terminal caps perPage below windowsPerPane (never clips)', () => {
  // Only ~2 card rows fit. At 5 cols that's ≤10 cards, but the tight budget
  // must shrink perPage so a pane never overflows the terminal.
  const short = { termCols: 180, termRows: 40, gridCols: 5, fleetLogLines: 6 };
  const l = computeGridLayout({ ...short, count: 30, windowsPerPane: 25, focusedIndex: 0 });
  assert.ok(l.perPage < 25, `perPage ${l.perPage} should be capped by fit`);
  assert.ok(l.rowsInPage * 11 <= short.termRows, 'rendered grid never exceeds terminal height');
  assert.ok(l.pageCount > 1, 'overflow spills to more panes instead of clipping');
});

test('grid: narrow terminal auto-reduces columns', () => {
  // 0459: MIN_CARD_W went 20 → 34, so the old 50-col case (2 × 24) is now a
  // single column. 80 cols is the narrow case that still splits: (80-2)/34 = 2.
  const narrow = { termCols: 80, termRows: 200, gridCols: 5, fleetLogLines: 10 };
  const l = computeGridLayout({ ...narrow, count: 10, windowsPerPane: 9, focusedIndex: 0 });
  assert.equal(l.effectiveCols, 2);
  assert.ok(l.cardW >= MIN_CARD_W);
  const tiny = computeGridLayout({ ...narrow, termCols: 50, count: 10, windowsPerPane: 9, focusedIndex: 0 });
  assert.equal(tiny.effectiveCols, 1);
  assert.ok(tiny.cardW >= MIN_CARD_W);
});

// 0459: at the default 5 columns no common terminal width may produce a card
// narrower than MIN_CARD_W — that is where card rows used to wrap (120 cols
// gave cardW 23). The grid drops a column instead.
test('0459 grid: default 5-col grid never yields a card under MIN_CARD_W', () => {
  assert.equal(MIN_CARD_W, 34);
  for (let termCols = 36; termCols <= 260; termCols++) {
    const l = computeGridLayout({ termCols, termRows: 200, gridCols: 5, count: 10, fleetLogLines: 10 });
    assert.ok(l.cardW >= MIN_CARD_W, `termCols ${termCols}: cardW ${l.cardW} < ${MIN_CARD_W}`);
    assert.ok(l.effectiveCols * l.cardW <= termCols - 2, `termCols ${termCols}: grid spills`);
  }
  const at = (termCols) => computeGridLayout({ termCols, termRows: 200, gridCols: 5, count: 10, fleetLogLines: 10 });
  assert.deepEqual([at(120).effectiveCols, at(120).cardW], [3, 39]);
  assert.deepEqual([at(80).effectiveCols, at(80).cardW], [2, 39]);
  assert.deepEqual([at(180).effectiveCols, at(180).cardW], [5, 35]);
});

test('grid: zero cards → one empty pane, no divide-by-zero', () => {
  const l = computeGridLayout({ ...TALL, count: 0, windowsPerPane: 9, focusedIndex: 0 });
  assert.equal(l.pageCount, 1);
  assert.equal(l.rowsInPage, 0);
  assert.equal(l.pageEnd, 0);
});

test('grid: windowsPerPane 0 → fill as many as fit (legacy behavior)', () => {
  const l = computeGridLayout({ ...TALL, count: 8, windowsPerPane: 0, focusedIndex: 0 });
  assert.equal(l.pageCount, 1);
  assert.equal(l.pageEnd, 8);
});

test('grid: focusedIndex clamps to last pane when out of range', () => {
  const l = computeGridLayout({ ...TALL, count: 10, windowsPerPane: 9, focusedIndex: 99 });
  assert.equal(l.pageIndex, l.pageCount - 1);
});

test('grid: non-finite terminal dims degrade to a sane layout (no NaN/null)', () => {
  // A non-TTY stdout reports undefined rows/columns — must not poison the
  // math into nulls (which would slice zero cards and render an empty grid).
  const l = computeGridLayout({ termCols: undefined, termRows: undefined, gridCols: 5, count: 5, fleetLogLines: 10, windowsPerPane: 9, focusedIndex: 0 });
  assert.ok(Number.isFinite(l.perPage) && l.perPage > 0, 'perPage is a positive number');
  assert.equal(l.pageEnd, 5, 'all 5 cards fall on one page');
  assert.equal(l.pageCount, 1);
});

test('chunkRows: splits a flat list into rows of N', () => {
  assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkRows([], 3), []);
});

// ── 0388: fleetLogLines is EXACT, not a floor ────────────────────────────────
// User report 2026-08-28: "fleet log is not outputting the correct number of
// lines as per the settings page." The old Math.max(setting, remainingH) grew
// the log to fill leftover terminal space; the setting must be authoritative.

test('0388: tall terminal — fleet log renders exactly the settings value', () => {
  // 200 rows, 1 card row (5 cards / 5 cols → 11 rows) → plenty of slack.
  const l = computeGridLayout({ termCols: 180, termRows: 200, gridCols: 5, count: 5, fleetLogLines: 8, windowsPerPane: 10, focusedIndex: 0 });
  assert.equal(l.dynamicFleetLogLines, 8, 'setting honored exactly — no fill-to-remaining');
});

test('0388: short terminal — fleet log clamps below the setting instead of overflowing', () => {
  // 30 rows: chrome (7) + one card row (11) leaves ~12; a 40-line setting
  // must clamp to what fits, never push the layout past the last row.
  const l = computeGridLayout({ termCols: 180, termRows: 30, gridCols: 5, count: 5, fleetLogLines: 40, windowsPerPane: 10, focusedIndex: 0 });
  assert.ok(l.dynamicFleetLogLines < 40, `clamped (got ${l.dynamicFleetLogLines})`);
  assert.ok(l.dynamicFleetLogLines >= 4, 'never below the settings-page minimum of 4');
});

// 0459 review: below MIN_CARD_W + 2 columns the single card used to keep the
// 34-col floor and spill past the right edge. It now takes the terminal
// width, down to the 20-col absolute floor (Card.jsx fits every row there).
test('0459 grid: a terminal narrower than MIN_CARD_W never gets a wider card', () => {
  for (let termCols = 22; termCols <= MIN_CARD_W + 2; termCols++) {
    const l = computeGridLayout({ termCols, termRows: 200, gridCols: 5, count: 10, fleetLogLines: 10 });
    assert.equal(l.effectiveCols, 1);
    assert.equal(l.cardW, termCols - 2, `termCols ${termCols}: cardW ${l.cardW}`);
  }
  assert.equal(computeGridLayout({ termCols: 15, termRows: 200, gridCols: 5, count: 3, fleetLogLines: 10 }).cardW, 20);
});
