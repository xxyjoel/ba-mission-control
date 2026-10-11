// tests/Dashboard.sanitize.test.jsx — 0460: the Dashboard row is painted to the
// user's REAL terminal, same as a Card.
//
//   activity — `agent.activity` is raw session text (a Bash command line). It
//     was rendered verbatim, so an OSC 8 hyperlink, a BEL or an 8-bit C1 OSC
//     (U+009D, no ESC byte) reached the host terminal. Card routes its raw
//     session text (todo, subagent labels) through humanize(); so must this.
//   name — the NAME column padded with String#padEnd (code units). A wide
//     (CJK) name is 1 unit but 2 cells per glyph, so its row ran wider and
//     every column to its right was misaligned against an ASCII row.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import Dashboard from '../tui/modals/Dashboard.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const stripSgr = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

const agent = (over = {}) => ({
  id: `a${over.slot ?? 1}`, slot: 1, name: 'repo-1', model: 'sonnet-4.6',
  status: 'idle', context: 1000, tokensIn: 10, tokensOut: 5, costSession: 0.1,
  spark: [], tail: [], activity: '',
  ...over,
});

function frameFor(agents) {
  const { lastFrame, unmount } = render(
    <Dashboard agents={agents} threshold={100000} theme={theme}
      onClose={() => {}} onZoom={() => {}} onFocus={() => {}} width={160} />,
  );
  const f = lastFrame();
  unmount();
  return f;
}

test('0460: activity escapes (OSC 8, BEL, C1 OSC) never reach the terminal', () => {
  const activity =
    'run \x1b]8;;https://evil.example/\x07click\x1b]8;;\x07 ' + // OSC 8 hyperlink, BEL-terminated
    'ding\x07 ' +                                                  // bare BEL
    '\u009d52;c;cHduZWQ=\u009c tail';                              // C1 OSC-52 clipboard write
  const f = frameFor([agent({ activity })]);
  assert.ok(!f.includes('\x1b]'), 'OSC introducer leaked into the frame');
  assert.ok(!f.includes('\x07'), 'BEL leaked into the frame');
  assert.ok(!/[\u0080-\u009f]/.test(f), 'C1 control leaked into the frame');
  assert.ok(!f.includes('evil.example'), 'OSC 8 URI payload leaked as text');
  assert.ok(stripSgr(f).includes('tail'), 'printable activity text still shown');
});

test('0460: a wide-glyph name keeps the columns to its right aligned', () => {
  const f = stripSgr(frameFor([
    agent({ slot: 1, name: 'ascii-name' }),
    agent({ slot: 2, name: '日本語の名前' }), // 6 code units, 12 cells
  ]));
  const rows = f.split('\n').filter(l => /\[[12]\]/.test(l));
  assert.equal(rows.length, 2, `expected two agent rows:\n${f}`);
  const statusCol = (l) => stringWidth(l.slice(0, l.indexOf('IDLE')));
  assert.equal(statusCol(rows[1]), statusCol(rows[0]),
    `STATUS column misaligned:\n${rows.join('\n')}`);
});

test('0460: an escape-only name still shows the placeholder, not blanks', () => {
  const f = stripSgr(frameFor([agent({ slot: 1, name: '\x1b]0;x\x07' })]));
  const row = f.split('\n').find(l => /\[1\]/.test(l));
  assert.ok(row && row.includes('[1] —'), `expected '—' placeholder:\n${f}`);
});
