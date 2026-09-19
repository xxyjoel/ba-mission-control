// tests/shellOverlay.scroll.test.jsx — the `!` shell overlay captured
// thousands of rows of history and gave the user no way to reach any of it.
// The window was pinned to the live viewport and the file's own note said the
// history was "inaccessible to the user".
//
// These drive the real emulator, because the two earlier attempts at scrolling
// in this project were hand-rolled arithmetic that looked right and was not.
import test from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/headless';

const Terminal = xtermPkg.Terminal || xtermPkg.default?.Terminal || xtermPkg;
const write = (t, s) => new Promise((r) => t.write(s + '\r\n', r));
const topRow = (t) => t.buffer.active.getLine(t.buffer.active.viewportY)?.translateToString(true).trim();

async function filled(lines = 200) {
  const t = new Terminal({ cols: 80, rows: 20, allowProposedApi: true, scrollback: 200 });
  for (let i = 0; i < lines; i++) await write(t, 'L' + String(i).padStart(3, '0'));
  return t;
}

test('the overlay can reach history at all', async () => {
  const t = await filled();
  const live = topRow(t);
  t.scrollLines(-20);                       // what Ctrl+Y does, twenty times
  assert.notEqual(topRow(t), live, 'the view moved into history');
});

test('a scrolled position holds while the shell keeps printing', async () => {
  const t = await filled();
  t.scrollLines(-20);
  const parked = topRow(t);
  for (let i = 200; i < 240; i++) await write(t, 'L' + String(i).padStart(3, '0'));
  assert.equal(topRow(t), parked,
    'output dragged the reader: was ' + parked + ', now ' + topRow(t));
});

test('eviction never dumps the reader back at the live output', async () => {
  // The row you are looking at CAN be discarded — a 200-row scrollback with 300
  // more lines written guarantees it. Nothing can hold a row that no longer
  // exists. What must not happen is being silently returned to the bottom,
  // which is what the reader was complaining about.
  const t = await filled();
  t.scrollLines(-20);
  for (let i = 200; i < 500; i++) await write(t, 'L' + String(i).padStart(3, '0'));
  const b = t.buffer.active;
  const back = Math.max(0, b.baseY - b.viewportY);
  assert.ok(back > 0, 'still scrolled back after eviction, not snapped to live');
  assert.equal(b.viewportY, 0, 'clamped to the oldest row still held, which is the honest answer');
});

test('scrolling back to the bottom returns to the live output', async () => {
  const t = await filled();
  const live = topRow(t);
  t.scrollLines(-20);
  assert.notEqual(topRow(t), live);
  t.scrollToBottom();                        // what typing does
  assert.equal(topRow(t), live, 'back on the live output');
});

test('the indicator counts rows back, and is zero when live', async () => {
  const t = await filled();
  const back = () => Math.max(0, t.buffer.active.baseY - t.buffer.active.viewportY);
  assert.equal(back(), 0, 'live means zero');
  t.scrollLines(-20);
  assert.equal(back(), 20, 'twenty rows back reads as twenty');
  t.scrollToBottom();
  assert.equal(back(), 0);
});
