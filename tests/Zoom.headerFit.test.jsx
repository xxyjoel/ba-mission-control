// tests/Zoom.headerFit.test.jsx — the zoom header on a narrow terminal.
//
// Screen recording 2026-11-04 (0479 followup): at 81 columns the header lost
// the permission mode and claude's status word off its right edge while the
// branch was already cut to "fe…". The right-hand chips were all treated as
// fixed, so the row overflowed and was clipped at the end, where the status
// word sits. The status word must always show; other chips drop whole.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Zoom from '../tui/modals/Zoom.jsx';
import { makeStubAgent } from './lib/zoom-stub.js';
import { keepWhole } from '../tui/lib/format.js';
import { zoomBodyDims, zoomModalWidth } from '../tui/lib/zoomGeometry.js';
import { renderAt, tick, stripAnsi, frameLines, THEME } from './lib/render-size.js';

async function headerLine(termCols, over = {}, extra = {}) {
  const termRows = 40;
  const dims = zoomBodyDims(termCols, termRows);
  const stub = makeStubAgent({ cols: dims.cols, rows: dims.rows });
  Object.assign(stub.agent, {
    slot: 3, name: 'labor-market-app', branch: 'feature/d3-followups', model: 'opus-5.5',
    dirty: 90, ahead: 0, behind: 87, status: 'idle', permissionMode: 'auto', ...over,
  });
  const r = renderAt(
    <Zoom
      agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
      theme={THEME} width={zoomModalWidth(termCols)} height={termRows - 5}
      usage={{}} fmtReset={() => ''} weekCost={0} {...extra}
    />,
    { cols: termCols, rows: termRows },
  );
  await tick(60);
  const line = frameLines(stripAnsi(r.lastFrame())).find((l) => l.includes('[3]'));
  r.unmount();
  return line || '';
}

test('the status word always shows, at every width', async () => {
  for (const cols of [60, 70, 81, 96, 119, 170, 215]) {
    const line = await headerLine(cols);
    assert.match(line, /○ IDLE/, `${cols} cols: status word missing: ${line}`);
  }
});

test('keepWhole: strict rank order, whole items only', () => {
  const items = [
    { key: 'perm', width: 14, rank: 2 }, { key: 'jobs', width: 17, rank: 1 },
    { key: 'dirty', width: 4, rank: 3 }, { key: 'update', width: 20, rank: 6 }, { key: 'none', width: 0, rank: 0 },
  ];
  assert.deepEqual([...keepWhole(items, 100)].sort(), ['dirty', 'jobs', 'perm', 'update']);
  assert.deepEqual([...keepWhole(items, 31)], ['jobs', 'perm'], 'jobs and perm fill the room exactly; dirty does not fit');
  assert.deepEqual([...keepWhole(items, 30)], ['jobs'], 'perm does not fit: perm and everything after it drop, even the 4-wide dirty');
  assert.deepEqual([...keepWhole(items, 0)], []);
});

test('chips drop whole; a wide terminal shows all of them', async () => {
  const wide = await headerLine(215, { shellJobs: [{ id: 'b1', label: 'x', elapsedMs: 1000 }] });
  for (const s of ['1 job running', 'perm: auto', '○ IDLE', '+90', '↓87']) {
    assert.ok(wide.includes(s), `215 cols: ${s} missing: ${wide}`);
  }
  for (const cols of [60, 70, 81, 96, 119]) {
    const line = await headerLine(cols, { shellJobs: [{ id: 'b1', label: 'x', elapsedMs: 1000 }] });
    assert.doesNotMatch(line, /perm: au(?!to)|1 job runn(?!ing)/, `${cols} cols: a chip was cut, not dropped: ${line}`);
    if (!line.includes('1 job running')) assert.doesNotMatch(line, /perm: auto/, `${cols} cols: perm drops before jobs: ${line}`);
    if (!line.includes('perm: auto')) assert.doesNotMatch(line, /\+90/, `${cols} cols: the git counts drop before perm: ${line}`);
  }
});

test('bypassPermissions stays on screen before the job count', async () => {
  const line = await headerLine(81, { permissionMode: 'bypassPermissions', shellJobs: [{ id: 'b1', label: 'x', elapsedMs: 1000 }] });
  assert.match(line, /perm: bypassPermissions/, `the safety warning was dropped: ${line}`);
  assert.match(line, /○ IDLE/);
});
