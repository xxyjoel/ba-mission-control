// tests/zoom/ptyPane.scrollHold.test.jsx — a reader parked in history must
// STAY there while claude keeps printing.
//
// The window used to be measured from the live viewport, which advances one row
// per printed line, so output dragged the reader back to the bottom while the
// indicator still claimed they were twenty rows back. Measured before the fix:
// parked at rows L062-L080, twenty lines later the window showed L082-L100.
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';

const CTRL_Y = String.fromCharCode(25);   // enters scroll mode
const strip = (t) => String(t || '').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
const markers = (frame) => (strip(frame).match(/L\d{3}/g) || []);
// Scroll mode reserves a footer row, so the visible window is one row shorter
// while scrolling. Compare the BOTTOM row, which is the live edge either way.
const bottom = (frame) => { const m = markers(frame); return m[m.length - 1]; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};

// xterm's write() is asynchronous — the parser flushes on a macrotask — so each
// line is awaited. Without this the buffer is empty when the pane first reads it.
const writeLine = (term, text) => new Promise((r) => term.write(text + '\r\n', r));

async function paneWithHistory(lines = 200) {
  const stub = makeStubAgent({ cols: 80, rows: 20 });
  for (let i = 0; i < lines; i++) await writeLine(stub.term, 'L' + String(i).padStart(3, '0'));
  return stub;
}

test('a parked reader is not dragged forward by new output', async () => {
  const stub = await paneWithHistory();
  const { stdin, lastFrame, rerender } = render(
    <PtyPane agent={stub.agent} width={80} height={20} theme={THEME} />,
  );
  await wait(120);

  stdin.write(CTRL_Y);
  await wait(60);
  for (let i = 0; i < 20; i++) stdin.write('w');
  await wait(120);

  const parked = markers(lastFrame());
  assert.ok(parked.length > 0, 'the parked window shows numbered rows');
  const parkedTop = parked[0];
  const parkedBottom = bottom(lastFrame());

  // claude keeps printing while the reader sits in history.
  for (let i = 200; i < 240; i++) await writeLine(stub.term, 'L' + String(i).padStart(3, '0'));
  rerender(<PtyPane agent={stub.agent} width={80} height={20} theme={THEME} />);
  await wait(160);

  const after = markers(lastFrame());
  assert.ok(after.length > 0, 'the window still shows numbered rows');
  assert.equal(after[0], parkedTop,
    'top moved: was ' + parkedTop + ', now ' + after[0] + ' — output dragged the reader');
  assert.equal(bottom(lastFrame()), parkedBottom,
    'bottom moved: was ' + parkedBottom + ', now ' + bottom(lastFrame()));
});

test('G returns to the live output', async () => {
  const stub = await paneWithHistory();
  const { stdin, lastFrame } = render(
    <PtyPane agent={stub.agent} width={80} height={20} theme={THEME} />,
  );
  await wait(120);
  const live = bottom(lastFrame());

  stdin.write(CTRL_Y);
  await wait(60);
  for (let i = 0; i < 20; i++) stdin.write('w');
  await wait(100);
  assert.notEqual(bottom(lastFrame()), live, 'we actually scrolled away');

  stdin.write('G');
  await wait(100);
  assert.equal(bottom(lastFrame()), live, 'G puts us back on the live output');
});

// 0416: the same reader, thrown to the bottom by a RESIZE instead of by output.
// The pane's [cols, rows] effect called term.scrollToBottom() unconditionally,
// and `rows` moves in normal use — Zoom recomputes bodyRows whenever a toast
// lands or the stats/todos panel opens, so a panel appearing while you read was
// enough. xterm's own reflow holds the offset (measured: parked at viewportY
// 256 with baseY 278, a 30->29 height change left it at 257/279), so the
// explicit call was the only thing destroying the position.
test('a resize does not snap a parked reader to the bottom', async () => {
  const stub = await paneWithHistory();
  const { stdin, lastFrame, rerender, unmount } = render(
    <PtyPane agent={stub.agent} width={80} height={20} theme={THEME} />,
  );
  await wait(120);
  const live = bottom(lastFrame());

  stdin.write(CTRL_Y);
  await wait(60);
  for (let i = 0; i < 20; i++) stdin.write('w');
  await wait(120);

  const parked = markers(lastFrame());
  assert.ok(parked.length > 0, 'the parked window shows numbered rows');
  const parkedTop = parked[0];
  assert.notEqual(bottom(lastFrame()), live, 'we actually scrolled away');

  // A panel opens while they read: same width, two fewer body rows.
  rerender(<PtyPane agent={stub.agent} width={80} height={18} theme={THEME} />);
  await wait(160);

  const after = markers(lastFrame());
  assert.ok(after.length > 0, 'the shorter window still shows numbered rows');
  assert.equal(after[0], parkedTop,
    'top moved: was ' + parkedTop + ', now ' + after[0] + ' — the resize dragged the reader');
  assert.ok(!after.includes(live),
    'the resize snapped the view back to the live row ' + live);
  unmount();
});

// The other half: the unconditional call was also doing real work. Outside
// scroll mode the emulator's viewport can sit above the live cursor row — a
// mid-stream size change drifts it — and snapping back is what keeps claude's
// composer on screen. Deleting the call outright would lose that.
test('a resize still snaps a drifted viewport back to the live output', async () => {
  const stub = await paneWithHistory();
  const { lastFrame, rerender, unmount } = render(
    <PtyPane agent={stub.agent} width={80} height={20} theme={THEME} />,
  );
  await wait(120);
  const live = bottom(lastFrame());

  // No scroll mode — the emulator drifts on its own, the reader did not ask.
  stub.term.scrollLines(-5);
  await wait(120);
  assert.notEqual(bottom(lastFrame()), live, 'the viewport drifted off the live row');

  rerender(<PtyPane agent={stub.agent} width={80} height={18} theme={THEME} />);
  await wait(160);

  assert.equal(bottom(lastFrame()), live,
    'the resize must put a non-scrolling reader back on the live row ' + live);
  unmount();
});
