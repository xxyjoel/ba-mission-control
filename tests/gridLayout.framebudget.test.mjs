// tests/gridLayout.framebudget.test.mjs — the fleet view's rendered height must
// never exceed the terminal, for ANY combination of inputs.
//
// When it does, Ink cannot erase its previous frame and the terminal scrolls
// instead: the whole UI shifts down, card borders tear, and every repaint
// jumps. Reported as "the screen bops around all over the place, is pushed
// downward and breaks all formatting edges".
//
// Two defects made it possible, both measured over this same sweep:
//   1. FEEDBACK_H was 2 (the strip's IDLE height) while the strip renders up
//      to 1 + MAX_TOAST_ROWS = 5. Before the fix: 224/440 combinations
//      overflowed at 24 rows, 153/440 at 30, 67/440 at 40, 19/440 at 50 — and
//      every single overflowing case had a full strip, none had 0 or 1 toast.
//   2. dynamicFleetLogLines floored at 4, keeping four log rows even when the
//      terminal had room for none — 56/440 at 24 rows survived fix 1 on that
//      alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout, CARD_H, MAX_TOAST_ROWS } from '../tui/lib/gridLayout.js';

// Reconstructs the fleet view's height from App.jsx's JSX, top to bottom:
// Header, Aggregate, the card grid, the pager strip, the fleet-log header, the
// log rows, FeedbackStrip, StatusBar.
function renderedHeight({ termCols, termRows, gridCols, count, fleetLogLines, windowsPerPane, toasts }) {
  const L = computeGridLayout({
    termCols, termRows, gridCols, count, fleetLogLines, windowsPerPane, focusedIndex: 0,
  });
  const total = 1 + 1
    + (L.rowsInPage * CARD_H)
    + (L.pageCount > 1 ? 1 : 0)
    // App drops the log's header too when the budget reaches zero.
    + (L.dynamicFleetLogLines > 0 ? 1 + L.dynamicFleetLogLines : 0)
    + (1 + Math.max(1, toasts))
    + 1;
  return { total, L };
}

const ROWS = [20, 24, 30, 36, 40, 50, 60, 80, 120];
const COUNTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LOG_LINES = [0, 4, 6, 8, 12, 16, 20, 24, 30, 60];
const TOASTS = [0, 1, 2, 3, 4];
const PANES = [0, 4, 6, 10];

test('no combination of terminal size, cards, log setting and toasts overflows the frame', () => {
  const failures = [];
  let tested = 0;
  for (const termRows of ROWS) {
    for (const count of COUNTS) {
      for (const fleetLogLines of LOG_LINES) {
        for (const toasts of TOASTS) {
          for (const windowsPerPane of PANES) {
            tested++;
            const { total, L } = renderedHeight({
              termCols: 226, termRows, gridCols: 3, count, fleetLogLines, windowsPerPane, toasts,
            });
            if (total > termRows) {
              failures.push({ termRows, count, fleetLogLines, toasts, windowsPerPane, total, over: total - termRows, log: L.dynamicFleetLogLines, rowsInPage: L.rowsInPage });
            }
          }
        }
      }
    }
  }
  assert.equal(
    failures.length, 0,
    `${failures.length}/${tested} combinations render past the last screen row.\n`
    + failures.slice(0, 8).map((f) => '  ' + JSON.stringify(f)).join('\n'),
  );
});

test('the same holds on a narrow terminal and at one column', () => {
  const failures = [];
  for (const termCols of [60, 80, 100]) {
    for (const gridCols of [1, 2, 3]) {
      for (const termRows of [20, 24, 30, 50]) {
        for (const count of [0, 1, 5, 10]) {
          for (const toasts of [0, 4]) {
            const { total } = renderedHeight({
              termCols, termRows, gridCols, count, fleetLogLines: 30, windowsPerPane: 0, toasts,
            });
            if (total > termRows) failures.push({ termCols, gridCols, termRows, count, toasts, total });
          }
        }
      }
    }
  }
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 8), null, 1));
});

test('the strip budget is the toast cap — the two cannot drift', () => {
  // A regression here means App.pushToast could keep more toasts alive than
  // the layout reserves rows for, which is exactly defect 1.
  assert.equal(MAX_TOAST_ROWS, 4);
  const tall = computeGridLayout({
    termCols: 226, termRows: 60, gridCols: 3, count: 3, fleetLogLines: 60, focusedIndex: 0,
  });
  const short = computeGridLayout({
    termCols: 226, termRows: 60 - MAX_TOAST_ROWS, gridCols: 3, count: 3, fleetLogLines: 60, focusedIndex: 0,
  });
  assert.ok(
    tall.dynamicFleetLogLines > short.dynamicFleetLogLines,
    'the log must absorb the height difference, not overflow it',
  );
});

test('the fleet log yields to zero rather than pushing the frame', () => {
  // A 20-row terminal with two card rows has no room for a log at all.
  const L = computeGridLayout({
    termCols: 226, termRows: 20, gridCols: 1, count: 2, fleetLogLines: 30, focusedIndex: 0,
  });
  assert.ok(L.dynamicFleetLogLines >= 0);
  const { total } = renderedHeight({
    termCols: 226, termRows: 20, gridCols: 1, count: 2, fleetLogLines: 30, windowsPerPane: 0, toasts: 4,
  });
  assert.ok(total <= 20, `frame is ${total} rows on a 20-row terminal`);
});

test('the log honours its setting exactly when there is room', () => {
  const L = computeGridLayout({
    termCols: 226, termRows: 120, gridCols: 3, count: 3, fleetLogLines: 12, focusedIndex: 0,
  });
  assert.equal(L.dynamicFleetLogLines, 12, 'a roomy terminal gets the setting, not more or less');
});
