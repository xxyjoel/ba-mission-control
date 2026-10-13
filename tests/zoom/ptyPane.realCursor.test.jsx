// tests/zoom/ptyPane.realCursor.test.jsx — 0473.
//
// The bug: macOS dictation (and any IME) draws its live preview at the
// terminal's REAL cursor. Zoom only painted a picture of a cursor in claude's
// composer and left the real one hidden where Ink parks it, at the bottom of
// the screen — so dictated words appeared over mc's status bar, not in the
// composer (screen recording 2026-10-13).
//
// The fix: PtyPane hands claude's cursor cell to Ink's useCursor, offset by
// the pane's position on screen. These tests feed mc's real output into a
// headless terminal and read where the host's cursor actually ends up.

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

// A TTY stdout whose bytes land in a real emulator: the "host terminal".
function hostScreen(cols, rows) {
  const host = new Terminal({ cols, rows, allowProposedApi: true });
  const stdout = new EventEmitter();
  Object.assign(stdout, {
    isTTY: true, columns: cols, rows,
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

const HIDDEN = '\x1b[?25l';
const SHOWN = '\x1b[?25h';

async function placeCursor({ screenRows, headerRows, paneRows, claudeBytes, extra = {}, appRows = screenRows }) {
  const cols = 60;
  const stub = makeStubAgent({ cols: 50, rows: paneRows });
  stub.term.write(claudeBytes);
  Object.assign(stub.agent, extra);
  const { host, stdout, stdin } = hostScreen(cols, screenRows);
  let raw = '';
  const origWrite = stdout.write;
  stdout.write = (s) => { raw += s; return origWrite(s); };
  const inst = render(
    <Box flexDirection="column" width={cols} height={appRows}>
      {Array.from({ length: headerRows }, (_, i) => <Text key={i}>header {i}</Text>)}
      <Box paddingLeft={2}>
        <PtyPane
          agent={stub.agent}
          width={50}
          height={paneRows}
          focus={true}
          onClose={() => {}}
          onToggleTools={() => {}}
          onToggleStats={() => {}}
          onCyclePerm={() => {}}
          theme={THEME}
        />
      </Box>
      <Box flexGrow={1} />
      <Text>status bar</Text>
    </Box>,
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  );
  await tick(120);
  await flush(host);
  const buf = host.buffer.active;
  const out = {
    x: buf.cursorX, y: buf.cursorY,
    shown: raw.lastIndexOf(SHOWN) > raw.lastIndexOf(HIDDEN),
  };
  inst.unmount();
  return out;
}

// claude: two transcript rows, then its composer prompt with the cursor after
// "> hi" on row 2, column 4.
const CLAUDE = 'line one\r\nline two\r\n> hi';

test('0473: the real cursor sits on claude\'s cursor cell, not the bottom row', async () => {
  // Full-height app, as mc runs (output fills every terminal row).
  const c = await placeCursor({ screenRows: 20, headerRows: 3, paneRows: 8, claudeBytes: CLAUDE });
  assert.equal(c.shown, true, 'Ink shows the real cursor');
  assert.deepEqual({ x: c.x, y: c.y }, { x: 2 + 4, y: 3 + 2 },
    'header rows + claude row; padding + claude column');
});

test('0473: the cursor row is right when the app is one row short of the screen', async () => {
  // Ink positions the cursor differently when its output does not fill the
  // screen; the fullscreen correction must not apply here.
  const c = await placeCursor({ screenRows: 20, headerRows: 3, paneRows: 8, claudeBytes: CLAUDE, appRows: 19 });
  assert.equal(c.shown, true);
  assert.deepEqual({ x: c.x, y: c.y }, { x: 6, y: 5 });
});

test('0473: no real cursor when zoom paints none (Cursor slots)', async () => {
  // Cursor CLI draws its own caret; zoom opts out of painting one, and the
  // real cursor must stay hidden too or the slot shows two.
  const c = await placeCursor({
    screenRows: 20, headerRows: 3, paneRows: 8, claudeBytes: CLAUDE,
    extra: { paintHardCursor: false },
  });
  assert.equal(c.shown, false);
});
