// tests/FleetLog.width.test.jsx — 0408 R4/R5/S3: the fleet log's row budget
// must hold at NARROW widths and against hostile row content.
//
//   R4: under 90 cols in narrative mode with the clamp note, the header row
//       wrapped to two rows — one unbudgeted frame row, enough to push the
//       whole fleet view past the terminal's last line.
//   R5: a Bash tool row whose command spans 3 lines rendered 3 rows in a
//       one-row slot (humanize kept \n and \t).
//   S3: the tool NAME comes off the untrusted stream — an escape or newline
//       in it must not reach the terminal or grow the row.
//
// ink-testing-library pins columns=100, so these use the width-controlled
// harness in tests/lib/render-size.js.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import FleetLog from '../tui/FleetLog.jsx';
import { renderAt, tick, stripAnsi, frameLines, THEME } from './lib/render-size.js';

const entry = (over = {}) => ({
  ts: 1, kind: 'asst', preview: 'msg', agentId: 'a1', slot: 1, name: 'ba-mission-control', ...over,
});

async function frameFor(props, cols) {
  const r = renderAt(<FleetLog focusedId="a1" theme={THEME} {...props} />, { cols, rows: 40 });
  await tick(40);
  const f = r.lastFrame();
  r.unmount();
  return f;
}

test('R4: header stays ONE row at 80 cols with clamp note + narrative tag', async () => {
  const log = Array.from({ length: 12 }, (_, i) => entry({ preview: `msg ${i}` }));
  for (const [label, props] of [
    ['narrative + clamped', { log, width: 80, maxLines: 8, requestedLines: 12, mode: 'narrative' }],
    ['all + clamped', { log, width: 80, maxLines: 8, requestedLines: 12, mode: 'all' }],
    ['very narrow', { log, width: 60, maxLines: 4, requestedLines: 30, mode: 'narrative' }],
  ]) {
    const f = await frameFor(props, props.width);
    const lines = frameLines(f);
    assert.equal(lines.length, 1 + props.maxLines,
      `${label}: ${lines.length} lines for a ${1 + props.maxLines}-row budget`);
    assert.match(stripAnsi(lines[0]), /FLEET LOG/, `${label}: label survives the squeeze`);
  }
});

test('R5: a 3-line Bash command renders in ONE log row', async () => {
  const log = [
    entry({ kind: 'tool', tool: 'Bash', text: 'cd /tmp && \\\n  npm test && \\\n  echo done', preview: null }),
    entry({ ts: 2, preview: 'ok' }),
  ];
  const f = await frameFor({ log, width: 120, maxLines: 4, requestedLines: 4, mode: 'all' }, 120);
  // Only entries exist for 2 rows; budget renders those 2 + header = 3 lines.
  assert.equal(frameLines(f).length, 3, 'the multi-line command took extra frame rows');
  assert.match(stripAnsi(f), /cd \/tmp && \\ {3}npm test/, 'newlines collapsed, content preserved');
});

test('S3: a hostile tool NAME is sanitized and cannot grow the row', async () => {
  const log = [
    entry({ kind: 'tool', tool: 'Evil\x1b]52;c;aGVsbG8=\x07\nTool', text: 'payload', preview: null }),
  ];
  const f = await frameFor({ log, width: 120, maxLines: 2, requestedLines: 2, mode: 'all' }, 120);
  assert.ok(!f.includes('\x1b]52'), 'OSC-52 must not reach the frame');
  assert.equal(frameLines(f).length, 2, 'header + 1 row (the newline in the name must not add one)');
  assert.match(stripAnsi(f), /Evil Tool/, 'name survives, newline collapsed');
});

test('R7: a wide-glyph (CJK) name keeps the log columns aligned', async () => {
  const log = [
    entry({ name: 'ascii-name', preview: 'from ascii' }),
    entry({ ts: 2, agentId: 'a2', slot: 2, name: '日本語日本語', preview: 'from cjk' }),
  ];
  const f = await frameFor({ log, width: 120, maxLines: 4, requestedLines: 4, mode: 'all' }, 120);
  const rows = frameLines(f).map(stripAnsi).filter((l) => /from (ascii|cjk)/.test(l));
  assert.equal(rows.length, 2);
  // padCol pads both names to the same DISPLAY width, so the glyph column
  // starts at the same terminal cell on both rows. (Measure in cells — a
  // string index would count the CJK name's fewer code units, not where the
  // terminal actually paints.)
  const cellPos = (row, marker) => stringWidth(row.slice(0, row.indexOf(marker)));
  assert.equal(cellPos(rows[0], '● from ascii'), cellPos(rows[1], '● from cjk'),
    'wide-glyph name shifted the columns to its right');
});
