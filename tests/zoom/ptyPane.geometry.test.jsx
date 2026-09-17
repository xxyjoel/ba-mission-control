// tests/zoom/ptyPane.geometry.test.jsx — 0404.
//
// The bug: text in a zoom session printed twice, once wrapped narrow and once
// at the full terminal width. Measured cause (claude 2.1.220, real PTY): claude
// reprints its entire frame on SIGWINCH and the pre-resize copy stays in the
// xterm-headless scrollback. One extra copy per widening resize:
//
//     spawn 80 cols, /help ....... 1 welcome frame in the buffer
//     resize to 214 .............. 2   (one 80-wide, one 214-wide)
//     resize back to 80 .......... 2
//     resize to 214 again ........ 3
//
// MC resized on every zoom enter (80 → body width), every zoom exit (back to
// 80), and every time its Ink box changed height — a toast landing, or the
// stats/todos panel opening.
//
// The fix: the emulator's geometry belongs to the fleet viewport for the
// agent's whole life, and PtyPane renders whatever slice of it fits. These
// tests pin the render side: a pane SHORTER than the emulator shows the
// emulator's BOTTOM rows (where claude's composer and status line live), not
// its top.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// Fill the emulator's viewport with 20 labelled rows: L01..L20, cursor left on
// the last one (no trailing newline, so nothing scrolls into scrollback).
function fillRows(term, n = 20) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`L${String(i).padStart(2, '0')}`);
  term.write(lines.join('\r\n'));
}

function renderPane(stub, { width, height }) {
  return render(
    <PtyPane
      agent={stub.agent}
      width={width}
      height={height}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
  );
}

test('0404: a pane shorter than the emulator renders the emulator BOTTOM rows', async () => {
  const stub = makeStubAgent({ cols: 40, rows: 20 });
  fillRows(stub.term, 20);
  // 12-row box against a 20-row emulator — what MC looks like once a couple of
  // toasts and the stats panel have eaten rows. skip = 8.
  const { lastFrame, unmount } = renderPane(stub, { width: 40, height: 12 });
  await tick();
  const frame = lastFrame();
  assert.ok(frame.includes('L20'), 'claude\'s last row (its composer) must be visible');
  assert.ok(frame.includes('L09'), 'the 12-row window starts at L09');
  for (const gone of ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08']) {
    assert.ok(!frame.includes(gone), `${gone} is above the window and must not render`);
  }
  // And the pane must still render exactly its allocated row count.
  assert.equal(frame.split('\n').length, 12);
  unmount();
});

test('0404: a pane the same height as the emulator renders every row', async () => {
  const stub = makeStubAgent({ cols: 40, rows: 20 });
  fillRows(stub.term, 20);
  const { lastFrame, unmount } = renderPane(stub, { width: 40, height: 20 });
  await tick();
  const frame = lastFrame();
  assert.ok(frame.includes('L01'), 'skip is 0 — the top row renders');
  assert.ok(frame.includes('L20'));
  assert.equal(frame.split('\n').length, 20);
  unmount();
});

test('0404: shrinking the pane does not resize the agent-owned PTY or emulator', async () => {
  const stub = makeStubAgent({ cols: 40, rows: 20 });
  fillRows(stub.term, 20);
  const { rerender, lastFrame, unmount } = renderPane(stub, { width: 40, height: 20 });
  await tick();
  rerender(
    <PtyPane
      agent={stub.agent}
      width={40}
      height={12}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
  );
  await tick();
  assert.deepEqual(stub.getResizes(), [], 'pty.resize would make claude reprint its frame');
  assert.deepEqual(stub.getTermResizes(), [], 'term.resize would reflow the copy we already have');
  assert.equal(stub.term.rows, 20, 'emulator keeps the fleet viewport geometry');
  // The window followed the box even though nothing was resized.
  assert.ok(lastFrame().includes('L20'));
  assert.ok(!lastFrame().includes('L01'));
  unmount();
});

test('0404: Ctrl+Y scroll can still reach the rows the window skipped', async () => {
  const stub = makeStubAgent({ cols: 40, rows: 20 });
  fillRows(stub.term, 20);
  const { stdin, lastFrame, unmount } = renderPane(stub, { width: 40, height: 12 });
  await tick();
  assert.ok(!lastFrame().includes('L01'));
  stdin.write('\x19');      // Ctrl+Y → scroll mode
  await tick();
  // Scroll mode reserves one row for its hint, so the window is 11 rows and
  // its maximum offset is 9 (buffer 20 − 11).
  for (let i = 0; i < 9; i++) { stdin.write('w'); await tick(20); }
  const frame = lastFrame();
  assert.ok(frame.includes('L01'), `scrolling to the top must reveal L01 — got:\n${frame}`);
  assert.ok(frame.includes('▲ SCROLL'), 'the scroll hint stays visible');
  unmount();
});

// Found while testing 0404, same user report ("misshapen" rows): the
// scroll-mode hint is a child of the same fixed-height box as the terminal
// rows. Rendering `rows` rows PLUS the hint gave Ink rows+1 children for a
// height=rows box, and Ink dropped lines from the MIDDLE of the view — at
// 40 cols the hint wrapped to 3 lines and 3 terminal rows vanished mid-screen.
test('0404: entering scroll mode must not drop rows from the middle of the view', async () => {
  const stub = makeStubAgent({ cols: 40, rows: 20 });
  fillRows(stub.term, 20);
  const { stdin, lastFrame, unmount } = renderPane(stub, { width: 40, height: 12 });
  await tick();
  const before = lastFrame().split('\n');
  assert.equal(before.length, 12);
  stdin.write('\x19');      // Ctrl+Y → scroll mode, offset still 0
  await tick();
  const after = lastFrame().split('\n');
  assert.equal(after.length, 12, 'the pane must stay inside its allocated rows');
  // 11 contiguous terminal rows (L10..L20) + 1 hint row. No gaps.
  const shown = after.filter((l) => /^L\d\d/.test(l.trim())).map((l) => l.trim().slice(0, 3));
  assert.deepEqual(
    shown,
    ['L10', 'L11', 'L12', 'L13', 'L14', 'L15', 'L16', 'L17', 'L18', 'L19', 'L20'],
    `rows went missing mid-view — got:\n${lastFrame()}`,
  );
  unmount();
});
