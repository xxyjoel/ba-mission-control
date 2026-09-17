// tests/zoomGeometry.test.mjs — 0404. The fleet's PTY geometry rule.
//
// Two invariants matter, because breaking either brings back the double-print
// (claude reprints its whole frame on every resize and the old copy stays in
// the emulator's scrollback):
//
//   1. The PTY width must equal the zoom body width EXACTLY — if the modal and
//      the viewport compute it differently, the pane truncates claude's frame
//      or the PTY gets resized to "fix" the mismatch.
//   2. The PTY height must be the LARGEST body the zoom modal can ever hand
//      out, so toasts and the optional panels only ever shrink the rendered
//      window, never the PTY.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoomModalWidth, zoomBodyDims,
  ZOOM_MODAL_MIN, ZOOM_MODAL_MAX, ZOOM_CHROME_COLS, ZOOM_CHROME_ROWS,
} from '../tui/lib/zoomGeometry.js';

// Mirrors App.jsx's modalWidth(min, max) over `usable = termCols - 4`.
function appModalWidth(termCols, min, max) {
  const usable = Math.max(20, termCols - 4);
  return Math.min(max, Math.max(min, usable));
}

// Mirrors Zoom.jsx: innerW = width - 6, and the body rows left after the
// always-on chrome with NO optional panels and the smallest FeedbackStrip.
function zoomBodyRowsFromApp(termRows) {
  const feedbackRows = 1 + Math.max(1, 0);          // App.jsx, no toasts
  const availableRows = Math.max(10, termRows - (3 + feedbackRows));
  const fixedRows = 9;                               // Zoom.jsx, no panels
  return Math.max(6, availableRows - fixedRows);
}

test('zoomModalWidth matches App.jsx modalWidth(104, 220) across terminal sizes', () => {
  for (const termCols of [40, 80, 100, 108, 120, 180, 224, 226, 300, 500]) {
    assert.equal(
      zoomModalWidth(termCols),
      appModalWidth(termCols, ZOOM_MODAL_MIN, ZOOM_MODAL_MAX),
      `drifted at termCols=${termCols}`,
    );
  }
});

test('zoomBodyDims.cols is the zoom modal inner width (border + paddingX)', () => {
  for (const termCols of [80, 120, 180, 300]) {
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
