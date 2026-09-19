// tests/Zoom.frame.test.jsx — 0408 R1/R2/R3/R6/M4/R5: the Zoom modal NEVER
// renders more rows than the height it is given, at any terminal size, with
// EVERY optional panel on. Ink cannot erase a frame taller than the terminal,
// so a single extra row tears the whole UI.
//
// Before the fix (scratchpad/agent-render/zoom-height.jsx): Ctrl+U overflowed
// by 3-13 rows (stats budgeted 7, rendered 10 + an unbudgeted ACTIVE AGENTS
// block), 12 todos on 24 rows by 7-10, all panels together by up to 26; a
// 67-char branch and 8 MCP-length tool names each wrapped extra rows; on an
// 80-col terminal the modal was forced to 104 cols and every PTY line
// truncated twice.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box, Text } from 'ink';
import Zoom from '../tui/modals/Zoom.jsx';
import { makeStubAgent } from './lib/zoom-stub.js';
import { zoomBodyDims, zoomModalWidth } from '../tui/lib/zoomGeometry.js';
import { renderAt, tick, stripAnsi, frameLines, THEME } from './lib/render-size.js';

const CTRL_K = '\x0b'; // tools strip toggle
const CTRL_U = '\x15'; // stats panel toggle

function agentFor({ todos = 0, tools = 0, subagents = 0, branch = 'main', name = 'stub', model = 'sonnet-4.6', cols, rows, longTools = false, todoText = null }) {
  const stub = makeStubAgent({ cols, rows });
  const a = stub.agent;
  Object.assign(a, {
    name, branch, model, dirty: 0, ahead: 0, behind: 0, status: 'idle',
    context: 12000, tokensIn: 1000, tokensOut: 500, tokensCacheRead: 0, costSession: 0.12,
    todos: Array.from({ length: todos }, (_, i) => ({
      content: todoText || `task ${i + 1}`,
      status: i === 0 ? 'in_progress' : 'pending',
      activeForm: todoText || `doing ${i + 1}`,
    })),
    tail: Array.from({ length: tools }, (_, i) => ({
      kind: 'tool',
      tool: longTools ? `mcp__bluearch-aws-steward__bluearch_get_resource_details_${i}` : `Tool${i}`,
      text: '',
    })),
    activeSubagents: Array.from({ length: subagents }, (_, i) => ({ label: `sub ${i}`, elapsedMs: 1000 })),
  });
  const ls = [];
  for (let i = 1; i <= rows; i++) ls.push(`L${String(i).padStart(2, '0')}`);
  stub.term.write(ls.join('\r\n'));
  return stub;
}

// Mirrors App.jsx: zoomHeight = termRows - (3 + feedbackRows),
// feedbackRows = 1 + max(1, toasts).
const zoomHeightFor = (termRows, toasts) => Math.max(10, termRows - (3 + 1 + Math.max(1, toasts)));

async function renderZoom({ termCols, termRows, toasts = 0, stats = false, toolsOn = false, ...agentOpts }) {
  const dims = zoomBodyDims(termCols, termRows);
  const stub = agentFor({ ...agentOpts, cols: dims.cols, rows: dims.rows });
  const height = zoomHeightFor(termRows, toasts);
  const r = renderAt(
    <Zoom
      agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
      theme={THEME} width={zoomModalWidth(termCols)} height={height}
      usage={{ fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 30 } }}
      fmtReset={() => ''} weekCost={1}
    />,
    // stdout wider than the modal so row counting is not polluted by
    // horizontal clipping; height tests only count rows.
    { cols: termCols + 20, rows: termRows },
  );
  await tick(60);
  if (toolsOn) { r.stdin.write(CTRL_K); await tick(40); }
  if (stats) { r.stdin.write(CTRL_U); await tick(40); }
  const frame = r.lastFrame();
  r.unmount();
  return { height, frame, rendered: frameLines(frame).length };
}

// ── R1 + R2: rendered rows === given height with EVERY panel on ──
test('Zoom with every panel on renders exactly the height it is given (24/30/40/50 rows)', async () => {
  for (const termRows of [24, 30, 40, 50]) {
    for (const toasts of [0, 4]) {
      const { height, rendered } = await renderZoom({
        termCols: 140, termRows, toasts,
        todos: 12, tools: 8, subagents: 2, stats: true, toolsOn: true,
      });
      assert.equal(rendered, height,
        `termRows=${termRows} toasts=${toasts}: rendered ${rendered} rows for a ${height}-row budget`);
    }
  }
});

test('each panel alone also holds the budget (stats, tools, todos)', async () => {
  for (const c of [
    { stats: true },
    { stats: true, subagents: 2 },
    { tools: 8, toolsOn: true },
    { todos: 3 },
    { todos: 12 },
  ]) {
    const { height, rendered } = await renderZoom({ termCols: 140, termRows: 24, toasts: 4, ...c });
    assert.equal(rendered, height, `${JSON.stringify(c)} overflowed at 24 rows / 4 toasts`);
  }
});

// ── R2: panels shed rather than overflow; roomy terminals still show them ──
test('a short terminal sheds panels; a tall one shows the todo list', async () => {
  // 24 rows + 4 toasts leaves no room for 12 todos — the panel is shed, not
  // painted over the PTY body.
  const short = await renderZoom({ termCols: 140, termRows: 24, toasts: 4, todos: 12 });
  assert.doesNotMatch(stripAnsi(short.frame), /OPEN TASKS/);
  assert.equal(short.rendered, short.height);
  // 50 rows has room: the panel is present, capped at 8 + "+N more".
  const tall = await renderZoom({ termCols: 140, termRows: 50, toasts: 0, todos: 12 });
  assert.match(stripAnsi(tall.frame), /OPEN TASKS/);
  assert.match(stripAnsi(tall.frame), /\+4 more/);
  assert.equal(tall.rendered, tall.height);
});

// ── R6: long branch / name / MCP tool names never wrap an extra row ──
test('a 67-char branch is truncated into the single header row', async () => {
  const branch = 'feature/0404-settle-terminal-resize-drag-before-moving-pty-geometry';
  const { height, rendered, frame } = await renderZoom({
    termCols: 100, termRows: 40, name: 'ba-mission-control', branch,
  });
  assert.equal(rendered, height, 'long branch grew the header to two rows');
  assert.match(stripAnsi(frame), /⎇ feature\/0404/, 'branch prefix still visible');
  assert.match(stripAnsi(frame), /…/, 'branch visibly truncated');
});

test('8 MCP-length tool names stay on the one-row strip, prefix dropped', async () => {
  const { height, rendered, frame } = await renderZoom({
    termCols: 100, termRows: 40, tools: 8, toolsOn: true, longTools: true,
  });
  assert.equal(rendered, height, 'MCP tool names wrapped the strip');
  const f = stripAnsi(frame);
  assert.doesNotMatch(f, /mcp__/, 'mcp__server__ prefix must be dropped from the strip');
  assert.match(f, /tools · /, 'strip still renders');
});

// ── R5: a todo with embedded newlines renders as ONE row ──
test('todo text with newlines is collapsed into its one-row slot', async () => {
  const { height, rendered, frame } = await renderZoom({
    termCols: 140, termRows: 40, todos: 1,
    todoText: 'line one\nline two\nline three',
  });
  assert.equal(rendered, height, 'a multi-line todo grew the frame');
  assert.match(stripAnsi(frame), /line one line two line three/);
});

// ── R3: an 80-col terminal gets an 76-col modal and a matching PTY ──
test('80-col terminal: modal fits the screen and the PTY body is not double-truncated', async () => {
  const termCols = 80, termRows = 24;
  assert.equal(zoomModalWidth(termCols), 76, 'modal must follow the terminal, not the old 104 floor');
  const dims = zoomBodyDims(termCols, termRows);
  const stub = makeStubAgent({ cols: dims.cols, rows: dims.rows });
  Object.assign(stub.agent, { branch: 'main', status: 'waiting', context: 1000, todos: [] });
  // A line that uses the full PTY width — with the old mismatch (modal shrunk
  // to 76, PTY body still 98) this marker was cut off with an ellipsis.
  const wide = 'claude> ' + 'x'.repeat(dims.cols - 8 - 14) + ' [END-OF-LINE]';
  stub.term.write(['first line', wide, '', '> composer'].join('\r\n'));
  const r = renderAt(
    <Box flexDirection="column" width={termCols} height={termRows} overflow="hidden">
      <Box paddingX={2} paddingY={1}>
        <Zoom agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
          theme={THEME} width={zoomModalWidth(termCols)} height={zoomHeightFor(termRows, 0)}
          usage={null} fmtReset={() => ''} weekCost={1} />
      </Box>
      <Box flexGrow={1} />
      <Box paddingX={1} height={1} overflow="hidden"><Text>─ FOCUSED ─</Text></Box>
    </Box>,
    { cols: termCols, rows: termRows },
  );
  await tick(80);
  const frame = r.lastFrame();
  r.unmount();
  const ls = frameLines(frame).map(stripAnsi);
  const widest = Math.max(...ls.map((l) => [...l].length));
  assert.ok(widest <= termCols, `widest rendered line is ${widest} cells on an ${termCols}-col terminal`);
  assert.ok(frame.includes('[END-OF-LINE]'), 'full-width PTY content must survive to the frame');
  assert.match(stripAnsi(frame), /NEEDS INPUT/, 'header status must stay visible');
});

// ── M4: estimated pricing is visibly marked ──
test('a model with estimatedPricing renders the session cost as ~$', async () => {
  const est = await renderZoom({ termCols: 140, termRows: 40, model: 'fable-5.1' });
  assert.match(stripAnsi(est.frame), /~\$0\.12/, 'estimated cost must carry the ~ prefix');
  const verified = await renderZoom({ termCols: 140, termRows: 40, model: 'sonnet-4.6' });
  assert.doesNotMatch(stripAnsi(verified.frame), /~\$/, 'verified pricing must NOT carry ~');
});
