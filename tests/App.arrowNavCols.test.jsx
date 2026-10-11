// tests/App.arrowNavCols.test.jsx — task 0457. Up/Down must step by the
// columns the grid actually draws (computeGridLayout(...).effectiveCols), not
// settings.gridCols. On a narrow terminal the grid draws fewer columns than
// the setting asks for, so stepping by gridCols skipped cards: at 50 columns
// Down went from card 1 to card 4 (review 2026-10-08, finding 26).
//
// Expected targets are computed from computeGridLayout itself, so the test
// holds whatever MIN_CARD_W the layout uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = mkdtempSync(join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0457-app-'));
process.env.MC_CONFIG_DIR = CFG;
process.env.REPO_PARENTS = mkdtempSync(join(tmpdir(), 'mc-0457-repos-'));

const React = await import('react');
const { render } = await import('ink');
const { default: App } = await import('../tui/App.jsx');
const { computeGridLayout } = await import('../tui/lib/gridLayout.js');
const { loadSettings } = await import('../tui/lib/settings.js');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

class Stdout extends EventEmitter {
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows; this.last = ''; }
  write = (f) => { this.last = f; };
}
class Stderr extends EventEmitter { write = () => {}; }
class Stdin extends EventEmitter {
  isTTY = true; data = null;
  write = (d) => { this.data = d; this.emit('readable'); this.emit('data', d); };
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read = () => { const d = this.data; this.data = null; return d; };
}

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const DOWN = '\u001B[B';
const UP = '\u001B[A';

async function boot({ cols, rows, live, settings = {} }) {
  writeFileSync(join(CFG, 'settings.json'), JSON.stringify(settings));
  const stdout = new Stdout(cols, rows), stdin = new Stdin(), stderr = new Stderr();
  const inst = render(React.createElement(App, { fleet: new FakeFleet(live), auth: AUTH }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  await tick(); await tick();
  return {
    frame: () => strip(stdout.last),
    // Status bar shows the focused card as "[<slot>] <name>".
    focused: () => {
      const m = strip(stdout.last).match(/\[(\d+)\] repo-\d+/g);
      const last = m ? m[m.length - 1] : '';
      const n = last.match(/\[(\d+)\]/);
      return n ? Number(n[1]) : null;
    },
    press: async (...ks) => { for (const k of ks) { stdin.write(k); await tick(); } await tick(60); },
    unmount: async () => { inst.unmount(); await tick(10); },
  };
}

// The layout App computes for this terminal, focused at `idx`.
function layoutFor({ cols, rows, count, idx, settings = {} }) {
  const s = { ...loadSettings(), ...settings };
  return computeGridLayout({
    termCols: cols, termRows: rows, gridCols: s.gridCols, count,
    fleetLogLines: s.fleetLogLines, showFleetLog: s.showFleetLog,
    windowsPerPane: s.windowsPerPane, focusedIndex: idx,
  });
}

test('0457: Down at 50 columns moves to the card directly below, not gridCols ahead', async () => {
  const live = [1, 2, 3, 4, 5, 6];
  const geo = { cols: 50, rows: 60 };
  const settings = { gridCols: 5, showFleetLog: false, windowsPerPane: 0 };
  const L = layoutFor({ ...geo, count: live.length, idx: 0, settings });
  // Preconditions: the grid draws fewer columns than gridCols, and the card
  // below card 1 is on the same pane.
  assert.ok(L.effectiveCols < 5, `expected a narrow grid, got ${L.effectiveCols} cols`);
  assert.ok(L.perPage > L.effectiveCols, `expected 2+ rows per pane, perPage ${L.perPage}`);
  const below = live[L.effectiveCols];

  const app = await boot({ ...geo, live, settings });
  try {
    assert.equal(app.focused(), 1, `starts on card 1\n${app.frame()}`);
    await app.press(DOWN);
    assert.equal(app.focused(), below,
      `Down from card 1 should land on card ${below} (${L.effectiveCols} cols drawn)\n${app.frame()}`);
    await app.press(UP);
    assert.equal(app.focused(), 1, `Up returns to card 1\n${app.frame()}`);
  } finally { await app.unmount(); }
});

test('0457: Down from the last row of a pane goes to the next pane, same column', async () => {
  const live = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // 120 cols draws 2+ columns; windowsPerPane forces a pane boundary that is
  // not a multiple of gridCols, so a gridCols stride would skip past it.
  const geo = { cols: 120, rows: 60 };
  const settings = { gridCols: 5, showFleetLog: false, windowsPerPane: 4 };
  const L = layoutFor({ ...geo, count: live.length, idx: 0, settings });
  const c = L.effectiveCols;
  assert.ok(c >= 2, `expected 2+ cols at 120, got ${c}`);
  assert.ok(L.pageCount > 1, 'expected more than one pane');
  // Bottom row of pane 0: column 1 when that row has 2+ cards, else column 0.
  const bottomRowStart = Math.floor((L.perPage - 1) / c) * c;
  const fromIdx = Math.min(bottomRowStart + 1, L.perPage - 1);
  const col = fromIdx - bottomRowStart;
  const toIdx = Math.min(live.length - 1, L.perPage + col);

  const app = await boot({ ...geo, live, settings });
  try {
    await app.press(String(live[fromIdx]));
    assert.equal(app.focused(), live[fromIdx], `focus on card ${live[fromIdx]}\n${app.frame()}`);
    await app.press(DOWN);
    assert.equal(app.focused(), live[toIdx],
      `Down from the bottom row of pane 1 should land on card ${live[toIdx]}\n${app.frame()}`);
    await app.press(UP);
    assert.equal(app.focused(), live[fromIdx],
      `Up from the top row of pane 2 returns to card ${live[fromIdx]}\n${app.frame()}`);
  } finally { await app.unmount(); }
});

test('0457: Down above a short last row stays in the pane', async () => {
  const live = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // gridCols 3 at 120 columns draws 3 columns; 4 per pane makes pane 1
  // [1,2,3],[4]. Down from card 2 must land on card 4 (the row below in the
  // same pane), not jump to pane 2.
  const geo = { cols: 120, rows: 60 };
  const settings = { gridCols: 3, showFleetLog: false, windowsPerPane: 4 };
  const L = layoutFor({ ...geo, count: live.length, idx: 1, settings });
  const c = L.effectiveCols;
  assert.ok(c >= 2 && L.perPage % c !== 0 && L.perPage > c,
    `expected a short last row in pane 1 (cols ${c}, perPage ${L.perPage})`);
  const lastRowStart = Math.floor((L.perPage - 1) / c) * c;
  const fromIdx = lastRowStart - c + (L.perPage - lastRowStart);  // column the short row lacks
  const toIdx = L.perPage - 1;

  const app = await boot({ ...geo, live, settings });
  try {
    await app.press(String(live[fromIdx]));
    assert.equal(app.focused(), live[fromIdx], `focus on card ${live[fromIdx]}\n${app.frame()}`);
    await app.press(DOWN);
    assert.equal(app.focused(), live[toIdx],
      `Down from card ${live[fromIdx]} should land on card ${live[toIdx]} in the same pane\n${app.frame()}`);
  } finally { await app.unmount(); }
});
