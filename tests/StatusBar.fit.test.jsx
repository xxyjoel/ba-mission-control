// tests/StatusBar.fit.test.jsx — 0479. On a narrow terminal the status bar's
// two hint strings ran together: "? keym← ↑ ↓ → move  ↵ o" at 81 columns
// (screen recording 2026-11-04). Ink shrank both a little at once. Now the
// nav hints show only when both fit with a gap, and the key hints are cut
// with an ellipsis, never mid-word into the nav hints.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import StatusBar, { fitHints } from '../tui/StatusBar.jsx';
import { cellWidth } from '../tui/lib/format.js';
import { renderAt, tick, stripAnsi, THEME } from './lib/render-size.js';

const KEYS = 'esc settings · ? keymap · n new · b bcast · / filter · : cmd';
const NAV = '← ↑ ↓ → move  ↵ open  n new  b bcast  esc settings';

async function bar(cols, focused = { slot: 2, name: 'outbound-orchestrator' }) {
  const r = renderAt(<StatusBar mode="focused" focused={focused} theme={THEME} cols={cols} />, { cols, rows: 10 });
  await tick(40);
  const line = stripAnsi(r.lastFrame()).split('\n')[0];
  r.unmount();
  return line;
}

test('0479: the key hints and nav hints never run together', async () => {
  for (const cols of [60, 81, 96, 119, 140, 170, 215, 254]) {
    const line = await bar(cols);
    assert.ok(cellWidth(line) <= cols, `${cols} cols: the bar is wider than the terminal: ${line}`);
    if (line.includes('←')) {
      assert.ok(line.includes(NAV), `${cols} cols: nav hints cut: ${line}`);
      assert.ok(line.includes(`${KEYS}  `), `${cols} cols: nav hints touch the key hints: ${line}`);
    }
    const at = line.indexOf('esc settings · ');
    if (at >= 0) {
      const keys = line.slice(at).split(/ {2,}/)[0];
      assert.ok(keys === KEYS || keys.endsWith('…'), `${cols} cols: key hints cut without an ellipsis: ${line}`);
    }
  }
});

test('0479: a roomy terminal shows both hint strings', async () => {
  const line = await bar(254);
  assert.ok(line.includes(KEYS) && line.includes(NAV), line);
});

test('0389/0479: on a wide terminal the nav hints still step aside while typing a command', async () => {
  const r = renderAt(
    <StatusBar mode="focused" focused={{ slot: 2, name: 'repo' }} cmdMode="command" cmdBuffer="resume all" theme={THEME} cols={254} />,
    { cols: 254, rows: 10 },
  );
  await tick(40);
  const line = stripAnsi(r.lastFrame()).split('\n')[0];
  r.unmount();
  assert.match(line, /resume all/);
  assert.doesNotMatch(line, /↵ open/, line);
});

test('0479: fitHints drops the nav hints before cutting the key hints', () => {
  const keysW = 4 + cellWidth(KEYS);
  const both = keysW + 2 + cellWidth(NAV);
  assert.deepEqual(fitHints(both), { keys: KEYS, nav: true });
  assert.deepEqual(fitHints(both - 1), { keys: KEYS, nav: false });
  assert.deepEqual(fitHints(keysW), { keys: KEYS, nav: false });
  const cut = fitHints(keysW - 10);
  assert.equal(cut.nav, false);
  assert.ok(cut.keys.endsWith('…') && cellWidth(cut.keys) === keysW - 14, cut.keys);
  assert.deepEqual(fitHints(5), { keys: '', nav: false });
});
