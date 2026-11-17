// tests/Zoom.statsRow.test.jsx — 0479. On a narrow terminal the zoom stats
// line cut figures short: "$428 (w$506)" for $4281.56 (wk $5068.99), "7d3"
// for 7d 35%, "ct0/1.00%" for ctx 0/1.0M 0% (screen recording 2026-11-04,
// 81×39 and narrower). Ink shrank every piece of the row a little instead of
// dropping the ones that did not fit. A figure must now be shown whole or not
// at all.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Zoom from '../tui/modals/Zoom.jsx';
import { fitChips } from '../tui/lib/format.js';
import { makeStubAgent } from './lib/zoom-stub.js';
import { zoomBodyDims, zoomModalWidth } from '../tui/lib/zoomGeometry.js';
import { renderAt, tick, stripAnsi, frameLines, THEME } from './lib/render-size.js';

// The figures from the recording.
const FULL = ['0/1.0M', '0%', '239.1M↓', '55.7M↑', '5708.5M', '$4281.56', '$5068.99', '35%'];

async function statsLine(termCols, termRows = 40) {
  const dims = zoomBodyDims(termCols, termRows);
  const stub = makeStubAgent({ cols: dims.cols, rows: dims.rows });
  Object.assign(stub.agent, {
    name: 'outbound-orchestrator', branch: 'feature/d3-followups', model: 'sonnet-4.6',
    dirty: 5, ahead: 0, behind: 0, status: 'working',
    context: 0, tokensIn: 239_100_000, tokensOut: 55_700_000, tokensCacheRead: 5_708_500_000,
    costSession: 4281.56,
  });
  const r = renderAt(
    <Zoom
      agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
      theme={THEME} width={zoomModalWidth(termCols)} height={termRows - 5}
      usage={{ sevenDay: { usedPct: 35 } }} fmtReset={() => ''} weekCost={5068.99}
    />,
    { cols: termCols, rows: termRows },
  );
  await tick(60);
  const line = frameLines(stripAnsi(r.lastFrame())).find((l) => l.includes('ctx'));
  r.unmount();
  return line || '';
}

// Every number-like token on the line must be one of the full figures.
function cutFigures(line) {
  const tokens = line.match(/\$[\d.]+|[\d.]+[kKMG]?\/[\d.]+[kKMG]?|[\d.]+[kKMG][↓↑]?|\d+%/g) || [];
  return tokens.filter((t) => !FULL.includes(t));
}

test('0479: the zoom stats line never shows a figure cut short', async () => {
  for (const cols of [60, 65, 70, 81, 96, 119, 140, 170, 215]) {
    const line = await statsLine(cols);
    assert.match(line, /ctx 0\/1\.0M {2}0%/, `${cols} cols: the ctx chip is missing or cut: ${line}`);
    assert.deepEqual(cutFigures(line), [], `${cols} cols: a figure was cut short: ${line}`);
  }
});

test('0479: a terminal wide enough shows every chip', async () => {
  const line = await statsLine(215);
  for (const f of FULL) assert.ok(line.includes(f), `${f} missing at 215 cols: ${line}`);
  assert.match(line, /\(wk \$5068\.99\)/);
  assert.match(line, /7d 35%/);
});

test('0479: when room is short, cost outlives the token counts', async () => {
  const line = await statsLine(81);
  assert.match(line, /\$4281\.56 \(wk \$5068\.99\)/, `cost dropped at 81 cols: ${line}`);
  assert.match(line, /7d 35%/, `usage dropped at 81 cols: ${line}`);
});

test('0479: fitChips drops the highest rank first, keeps order, and re-derives separators', () => {
  const chip = (group, drop, text) => ({ group, drop, parts: [[text, 'c']] });
  const chips = [chip('ctx', 0, 'ctx 10k'), chip('tok', 3, 'in 5'), chip('tok', 4, 'out 6'), chip('cost', 1, '$4281.56')];
  const text = (list) => list.map((c) => c.sep + c.parts[0][0]).join('');
  assert.equal(text(fitChips(chips, 100)), 'ctx 10k  ·  in 5  out 6  ·  $4281.56');
  // 36 cells in all; at 30 'out 6' (rank 4) goes first, then 'in 5' (rank 3).
  assert.equal(text(fitChips(chips, 30)), 'ctx 10k  ·  in 5  ·  $4281.56');
  assert.equal(text(fitChips(chips, 25)), 'ctx 10k  ·  $4281.56');
  // Nothing fits: an empty line rather than a cut chip.
  assert.deepEqual(fitChips(chips, 6), []);
});
