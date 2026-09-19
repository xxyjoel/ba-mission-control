// tests/zoomGeometry.test.mjs — 0404/0408. The fleet's PTY geometry rule.
//
// Three invariants matter:
//
//   1. The PTY width must equal the zoom body width EXACTLY — if the modal and
//      the viewport compute it differently, the pane truncates claude's frame
//      or the PTY gets resized to "fix" the mismatch. Both now come from
//      zoomInnerWidth() so they cannot disagree.
//   2. The PTY height must be the LARGEST body the zoom modal can ever hand
//      out, so toasts and the optional panels only ever shrink the rendered
//      window, never the PTY.
//   3. (0408/R3) The modal is NEVER wider than the terminal can show. The old
//      ZOOM_MODAL_MIN=104 forced a 104-col modal onto an 80-col terminal: Ink
//      shrank the border box to 76 but the PTY body kept its 98 computed
//      columns, so every claude line truncated twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoomModalWidth, zoomInnerWidth, zoomBodyDims,
  ZOOM_MODAL_MIN, ZOOM_MODAL_MAX, ZOOM_CHROME_COLS, ZOOM_CHROME_ROWS,
} from '../tui/lib/zoomGeometry.js';

// Mirrors Zoom.jsx: the body rows left after the always-on chrome with NO
// optional panels and the smallest FeedbackStrip (App.jsx, no toasts).
function zoomBodyRowsFromApp(termRows) {
  const feedbackRows = 1 + Math.max(1, 0);
  const availableRows = Math.max(10, termRows - (3 + feedbackRows));
  const fixedRows = 9; // Zoom.jsx CHROME_ROWS, no panels
  return Math.max(6, availableRows - fixedRows);
}

test('zoomModalWidth never exceeds what the terminal can show (0408/R3)', () => {
  for (const termCols of [60, 80, 100, 108, 120, 180]) {
    assert.ok(
      zoomModalWidth(termCols) <= termCols - 4,
      `termCols=${termCols}: modal ${zoomModalWidth(termCols)} is wider than the usable ${termCols - 4}`,
    );
  }
});

test('zoomModalWidth follows the terminal between the floor and the cap', () => {
  assert.equal(zoomModalWidth(80), 76, 'an 80-col terminal gets a 76-col modal, not 104');
  assert.equal(zoomModalWidth(108), 104);
  assert.equal(zoomModalWidth(120), 116);
  assert.equal(zoomModalWidth(224), 220, 'cap at ZOOM_MODAL_MAX');
  assert.equal(zoomModalWidth(500), ZOOM_MODAL_MAX);
  // The floor exists only for degenerate terminals — it is NOT a preferred
  // width the way the old 104 was.
  assert.equal(zoomModalWidth(20), ZOOM_MODAL_MIN);
  assert.equal(zoomModalWidth(0), ZOOM_MODAL_MIN);
  assert.ok(ZOOM_MODAL_MIN < 104, 'the 104 floor was the R3 defect');
});

test('zoomBodyDims.cols === zoomInnerWidth(zoomModalWidth) — one helper, no drift', () => {
  for (const termCols of [60, 80, 120, 180, 300]) {
    assert.equal(zoomBodyDims(termCols, 50).cols, zoomInnerWidth(zoomModalWidth(termCols)));
    assert.equal(zoomBodyDims(termCols, 50).cols, zoomModalWidth(termCols) - ZOOM_CHROME_COLS);
  }
  assert.equal(ZOOM_CHROME_COLS, 6, 'border 2 + paddingX 2*2');
});

test('zoomBodyDims.rows is never smaller than a body Zoom can hand out', () => {
  for (const termRows of [20, 30, 40, 50, 60, 100]) {
    const pinned = zoomBodyDims(200, termRows).rows;
    const largestBody = zoomBodyRowsFromApp(termRows);
    assert.ok(
      pinned >= largestBody,
      `termRows=${termRows}: PTY ${pinned} rows < largest rendered body ${largestBody} — `
      + 'the pane would have to grow the PTY, which duplicates claude\'s frame',
    );
  }
  assert.equal(ZOOM_CHROME_ROWS, 14);
});

test('zoomBodyDims clamps a tiny or unknown terminal instead of returning 0', () => {
  assert.deepEqual(zoomBodyDims(0, 0), { cols: ZOOM_MODAL_MIN - ZOOM_CHROME_COLS, rows: 6 });
  assert.deepEqual(zoomBodyDims(undefined, undefined), { cols: ZOOM_MODAL_MIN - ZOOM_CHROME_COLS, rows: 6 });
  const tiny = zoomBodyDims(10, 8);
  assert.ok(tiny.cols >= 20 && tiny.rows >= 6);
});

test('zoomBodyDims is stable — the same terminal always yields the same geometry', () => {
  assert.deepEqual(zoomBodyDims(224, 54), zoomBodyDims(224, 54));
  assert.notDeepEqual(zoomBodyDims(224, 54), zoomBodyDims(224, 40));
});
