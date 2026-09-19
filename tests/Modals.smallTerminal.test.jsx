// tests/Modals.smallTerminal.test.jsx — 0408/I6 (+ I8, I9, and the overlay
// height clamp). At 80×24 (macOS Terminal.app default) Settings and
// RepoPicker outgrew the screen — Ink shrank the column so rows overlapped
// ("Session history limiton startup") or vanished — and a 25-line Broadcast
// paste rendered every other line. Bodies are now windowed (fixed height +
// overflow hidden + a scroll window) and the frame must never exceed the
// terminal's rows.
//
// Harness: Ink's own render() with a fake stdout that HAS rows, so App's
// `stdout.rows || 50` fallback is not taken (ink-testing-library reports no
// rows). Pattern from scratchpad probeD.layout.jsx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0408-layout');
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink');
const { default: App, overlayHeight } = await import('../tui/App.jsx');
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

async function scenario({ cols = 80, rows = 24, live = [1], keys = [] }) {
  const stdout = new Stdout(cols, rows), stdin = new Stdin(), stderr = new Stderr();
  const fleet = new FakeFleet(live);
  const inst = render(React.createElement(App, { fleet, auth: AUTH }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  await tick(); await tick();
  for (const k of keys) { stdin.write(k); await tick(); }
  await tick(80);
  const frame = strip(stdout.last).replace(/\n$/, '');
  inst.unmount();
  await tick(10);
  return { frame, lines: frame.split('\n') };
}

const statusRow = (lines) => lines.findIndex(l => /─ (NORMAL|COMMAND|FILTER|FOCUSED|BROADCAST) ─/.test(l));

test('I6: Settings GENERAL at 80×24 fits the screen and keeps the status bar visible', async () => {
  const { lines, frame } = await scenario({ keys: [','] });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows on a 24-row terminal:\n${frame}`);
  assert.notEqual(statusRow(lines), -1, `status bar missing:\n${frame}`);
  assert.match(frame, /SETTINGS/);
  assert.match(frame, /Update rate/, 'first GENERAL row renders');
  assert.match(frame, /GENERAL/, 'tab label intact (was "GENER" when squeezed)');
});

test('I6: Settings selection scroll — the last GENERAL row becomes visible when selected', async () => {
  const downs = Array(12).fill('j');
  const { lines, frame } = await scenario({ keys: [',', ...downs] });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows:\n${frame}`);
  assert.match(frame, /Default permission mode/, 'the window followed the selection to the last row');
});

test('I6: RepoPicker at 80×24 fits the screen and keeps the status bar visible', async () => {
  const { lines, frame } = await scenario({ keys: [':', 'repos', '\r'] });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows:\n${frame}`);
  assert.notEqual(statusRow(lines), -1, `status bar missing:\n${frame}`);
  assert.match(frame, /PICK REPO LOCATION/);
});

test('I6: a 25-line Broadcast paste shows consecutive tail lines, inside 24 rows', async () => {
  const paste = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
  const { lines, frame } = await scenario({ live: [1, 2], keys: ['b', paste] });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows:\n${frame}`);
  assert.match(frame, /line 25/, 'the caret (end of paste) is visible');
  assert.match(frame, /line 24/, 'and its NEIGHBOR too — the old defect dropped every other line');
  assert.notEqual(statusRow(lines), -1, `status bar missing:\n${frame}`);
});

test('I6: Help at 80×24 stays windowed and no longer lists the retired zoom slash catalog (I9)', async () => {
  const { lines, frame } = await scenario({ keys: ['?'] });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows:\n${frame}`);
  assert.doesNotMatch(frame, /\/kill · \/quit/, 'stale zoom-composer slash rows are gone');
});

test('I8: the header shows the real package version, not the hard-coded v0.2.0', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { frame } = await scenario({ cols: 120, rows: 40, keys: [] });
  assert.ok(frame.includes(pkg.version), `header should carry ${pkg.version}:\n${frame.split('\n')[0]}`);
  assert.ok(!frame.includes('v0.2.0'), 'the stale default must be gone');
});

test('R2 sliver: overlayHeight never lets the overlay frame exceed the terminal', () => {
  // Frame = wrapper padding (2) + body + feedback (1 + max(1, toasts)) + status (1).
  for (const termRows of [12, 16, 20, 24, 30, 50]) {
    for (const toastCount of [0, 1, 2, 4]) {
      const h = overlayHeight(termRows, toastCount);
      const frame = 2 + h + (1 + Math.max(1, toastCount)) + 1;
      assert.ok(h >= 1, 'body keeps at least one row');
      assert.ok(frame <= termRows, `termRows=${termRows} toasts=${toastCount}: frame ${frame} > ${termRows}`);
    }
  }
  // The old floor of 10 is gone: a 12-row terminal with 4 toasts gets a small
  // body, not a 10-row one that would tear the screen.
  assert.ok(overlayHeight(12, 4) < 10);
});
