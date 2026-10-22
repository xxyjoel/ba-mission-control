// tests/zoom/ptyPane.realCursor.incremental.test.jsx — 0476.
//
// mc renders with Ink's incrementalRendering (0464): a row whose text did not
// change is never written again. The 0473 real-cursor tests used Ink's
// standard writer only. Here every frame drives the incremental writer with
// the real cursor shown, and the host screen must match a fresh render of the
// same state on every row — header and status bar included — with the cursor
// on claude's cell.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Box, Text, render } from 'ink';
import xtermPkg from '@xterm/headless';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';
import { tick, THEME } from '../lib/render-size.js';

const { Terminal } = xtermPkg.default || xtermPkg;
const COLS = 60;
const ROWS = 20;

function hostScreen() {
  // convertEol: a real tty turns Ink's "\n" into CR+LF (onlcr).
  const host = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, convertEol: true });
  const stdout = new EventEmitter();
  Object.assign(stdout, {
    isTTY: true, columns: COLS, rows: ROWS,
    write: (s) => { host.write(s); return true; },
  });
  const stdin = new EventEmitter();
  Object.assign(stdin, {
    isTTY: true, setEncoding() {}, setRawMode() {}, resume() {}, pause() {},
    ref() {}, unref() {}, read: () => null,
  });
  return { host, stdout, stdin };
}

const flush = (t) => new Promise((r) => t.write('', r));

function mount(stub, incremental) {
  const { host, stdout, stdin } = hostScreen();
  const inst = render(
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <Text>header</Text>
      <Text>stats</Text>
      <Box paddingLeft={2}>
        <PtyPane agent={stub.agent} width={50} height={8} focus={true}
          onClose={() => {}} onToggleTools={() => {}} onToggleStats={() => {}}
          onCyclePerm={() => {}} theme={THEME} />
      </Box>
      <Box flexGrow={1} />
      <Text>hints</Text>
      <Text>status bar</Text>
    </Box>,
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false,
      incrementalRendering: incremental },
  );
  return { host, stdout, inst };
}

function screen(host) {
  const b = host.buffer.active;
  const rows = [];
  for (let y = 0; y < ROWS; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return { rows, x: b.cursorX, y: b.cursorY };
}

async function reference(bytes) {
  const stub = makeStubAgent({ cols: 50, rows: 8 });
  stub.term.write(bytes);
  const m = mount(stub, false);
  await tick(120); await flush(m.host);
  const s = screen(m.host);
  m.inst.unmount();
  return s;
}

test('0476: incremental redraw keeps every row and the cursor right, frame after frame', async () => {
  const stub = makeStubAgent({ cols: 50, rows: 8 });
  const live = mount(stub, true);
  let bytes = '';
  const step = async (label, chunk, after) => {
    if (chunk) { bytes += chunk; stub.term.write(chunk); stub.fireData(chunk); }
    if (after) after();
    await tick(150); await flush(live.host);
    const got = screen(live.host);
    const want = await reference(bytes);
    assert.deepEqual(got.rows, want.rows, `${label}: rows`);
    assert.deepEqual({ x: got.x, y: got.y }, { x: want.x, y: want.y }, `${label}: cursor`);
  };
  await step('first frame', 'line one\r\nline two\r\n> hi');
  await step('dictated text wraps the composer', ' make sure the last question is not a yes or no one please');
  await step('cursor-only move', '\x1b[3D');
  // Before 0476 each cursor-only frame lifted the cursor one more row.
  await step('second cursor-only move', '\x1b[2D');
  await step('third cursor-only move', '\x1b[4C');
  await step('spinner tick above the composer', '\x1b7\x1b[1;1Hline ONE\x1b8');
  await step('resize event, same size', null, () => live.stdout.emit('resize'));
  await step('more text after resize', ' ok');
  live.inst.unmount();
});
