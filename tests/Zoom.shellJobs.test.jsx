// tests/Zoom.shellJobs.test.jsx — 0483: zoom counts running background shell
// jobs in its header and lists them in the Ctrl+U panel, without breaking
// the frame's row budget (0404/0408-R1).

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Zoom from '../tui/modals/Zoom.jsx';
import { makeStubAgent } from './lib/zoom-stub.js';
import { zoomBodyDims, zoomModalWidth } from '../tui/lib/zoomGeometry.js';
import { renderAt, tick, stripAnsi, frameLines, THEME } from './lib/render-size.js';

const CTRL_U = '\x15';

async function renderZoom({ termCols = 140, termRows = 40, jobs = 0, subagents = 0, stats = false }) {
  const dims = zoomBodyDims(termCols, termRows);
  const stub = makeStubAgent({ cols: dims.cols, rows: dims.rows });
  Object.assign(stub.agent, {
    name: 'stub', branch: 'main', model: 'sonnet-4.6', dirty: 0, ahead: 0, behind: 0,
    status: 'idle', context: 12000, tokensIn: 1000, tokensOut: 500, tokensCacheRead: 0,
    costSession: 0.12, todos: [], tail: [],
    activeSubagents: Array.from({ length: subagents }, (_, i) => ({ label: `sub ${i}`, elapsedMs: 1000 })),
    shellJobs: Array.from({ length: jobs }, (_, i) => ({ id: `bjob${i}`, label: `Sync batch ${i + 1}`, elapsedMs: (36 - i) * 60_000 })),
  });
  const ls = [];
  for (let i = 1; i <= dims.rows; i++) ls.push(`L${String(i).padStart(2, '0')}`);
  stub.term.write(ls.join('\r\n'));
  const height = Math.max(10, termRows - (3 + 1 + 1));
  const r = renderAt(
    <Zoom
      agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
      theme={THEME} width={zoomModalWidth(termCols)} height={height}
      usage={{ fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 30 } }}
      fmtReset={() => ''} weekCost={1}
    />,
    { cols: termCols + 20, rows: termRows },
  );
  await tick(60);
  if (stats) { r.stdin.write(CTRL_U); await tick(40); }
  const frame = r.lastFrame();
  r.unmount();
  return { height, frame: stripAnsi(frame), rendered: frameLines(frame).length };
}

test('the header counts running jobs', async () => {
  const { frame, rendered, height } = await renderZoom({ jobs: 2 });
  const header = frame.split('\n').find((l) => l.includes('[stub]') || l.includes('stub'));
  assert.match(header, /2 jobs running/);
  assert.equal(rendered, height);
});

test('no jobs: nothing extra in the header', async () => {
  const { frame } = await renderZoom({ jobs: 0 });
  assert.doesNotMatch(frame, /jobs? running/);
});

test('Ctrl+U lists each job with its age, and the frame keeps its height', async () => {
  for (const termRows of [40, 50]) {
    const { frame, rendered, height } = await renderZoom({ termRows, jobs: 2, subagents: 2, stats: true });
    assert.match(frame, /BACKGROUND JOBS \(2\)/, `termRows=${termRows}`);
    assert.match(frame, /Sync batch 1/);
    assert.match(frame, /ACTIVE AGENTS \(2\)/);
    assert.equal(rendered, height, `termRows=${termRows}: ${rendered} rows for a ${height}-row budget`);
  }
});

test('a short terminal sheds the panel rather than overflowing', async () => {
  const { rendered, height } = await renderZoom({ termRows: 24, jobs: 6, subagents: 2, stats: true });
  assert.equal(rendered, height);
});
