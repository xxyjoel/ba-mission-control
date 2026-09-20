// tests/gridLayout.showFleetLog.test.mjs — hiding the fleet log must give its
// rows back to the grid.
//
// Defect: showFleetLog reached the render guard (App.jsx) and nothing else.
// computeGridLayout took no such parameter, so chromeH always charged
// FLEETLOG_HEAD_H + fleetLogLines, and the settings-page minimum of 4 kept the
// bill at 5 rows even with the pane switched off. App's flex spacer absorbed
// the rows as blank screen. Both call sites omitted it, so the [ / ] pane
// switch stepped by the wrong perPage as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout, CARD_H } from '../tui/lib/gridLayout.js';

// 42 rows with a 10-line log: the chrome delta between shown and hidden is
// exactly FLEETLOG_HEAD_H + 10 = 11 = CARD_H, so the freed rows cross a card
// boundary and the extra grid row is visible. Most other sizes do not
// discriminate — the delta gets lost inside the floor division.
// windowsPerPane 0 and count 9 keep `fit` the binding constraint; a nonzero
// per-pane cap would clamp both cases to the same rowsInPage.
const VEC = {
  termCols: 180,
  termRows: 42,
  gridCols: 3,
  count: 9,
  fleetLogLines: 10,
  windowsPerPane: 0,
  focusedIndex: 0,
};

test('hiding the fleet log gives its rows to the grid', () => {
  const shown = computeGridLayout({ ...VEC, showFleetLog: true });
  const hidden = computeGridLayout({ ...VEC, showFleetLog: false });

  assert.equal(shown.rowsInPage, 2, 'log shown: 42 rows − 20 chrome = 2 card rows');
  assert.equal(hidden.rowsInPage, 3, 'log hidden: 42 rows − 9 chrome = 3 card rows');
  assert.ok(
    hidden.rowsInPage > shown.rowsInPage,
    `hidden ${hidden.rowsInPage} rows must exceed shown ${shown.rowsInPage}`,
  );
});

test('the pane cap follows the same budget — [ / ] steps by the right perPage', () => {
  // App.jsx:1566 builds a layout of its own for the pane-switch handler. Before
  // the fix it omitted showFleetLog, so with the log off the key stepped six
  // cards at a time across a pane that holds nine.
  const shown = computeGridLayout({ ...VEC, showFleetLog: true });
  const hidden = computeGridLayout({ ...VEC, showFleetLog: false });

  assert.equal(shown.perPage, 6);
  assert.equal(hidden.perPage, 9);
  assert.equal(shown.pageCount, 2, 'nine cards need two panes when the log is shown');
  assert.equal(hidden.pageCount, 1, 'they all fit one pane once the log is off');
});

test('dynamicFleetLogLines is 0 when the log is hidden, at any height', () => {
  // A roomy terminal has room for all 10 lines — the clamp alone would hand
  // back 10. The reservation has to be switched off, not clamped off.
  for (const termRows of [24, 42, 80, 200]) {
    const hidden = computeGridLayout({ ...VEC, termRows, showFleetLog: false });
    assert.equal(hidden.dynamicFleetLogLines, 0, `hidden at ${termRows} rows`);
  }
});

test('showFleetLog defaults to shown — callers that omit it are unchanged', () => {
  const omitted = computeGridLayout({ ...VEC });
  const shown = computeGridLayout({ ...VEC, showFleetLog: true });
  assert.deepEqual(omitted, shown);
});

// The fix raises rowsInPage, which is the direction that risks pushing the
// frame past the last screen row (see gridLayout.framebudget.test.mjs for why
// that tears the terminal). Same height reconstruction, hidden-log branch.
test('the taller grid still fits the frame when the log is hidden', () => {
  const failures = [];
  for (const termRows of [20, 24, 30, 36, 40, 42, 50, 60, 80]) {
    for (const count of [0, 1, 3, 5, 9, 10]) {
      for (const windowsPerPane of [0, 6, 10]) {
        for (const toasts of [0, 4]) {
          const L = computeGridLayout({
            termCols: 226, termRows, gridCols: 3, count, fleetLogLines: 10,
            windowsPerPane, focusedIndex: 0, showFleetLog: false,
          });
          const total = 1 + 1
            + (L.rowsInPage * CARD_H)
            + (L.pageCount > 1 ? 1 : 0)
            + (L.dynamicFleetLogLines > 0 ? 1 + L.dynamicFleetLogLines : 0)
            + (1 + Math.max(1, toasts))
            + 1;
          if (total > termRows) failures.push({ termRows, count, windowsPerPane, toasts, total });
        }
      }
    }
  }
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 8)));
});
