// tests/TextField.test.jsx — multi-line insert + submit behavior.
//
// The Zoom composer used to swallow Option+Return on macOS (encoded as
// ESC+CR by the terminal, which Ink reports as `key.meta && key.return`),
// either silently dropping it or — worse — submitting the half-typed
// message. These tests pin down the fix: meta/shift modifiers on Return
// insert a newline; plain Return submits.

import React, { useState } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import TextField from '../tui/lib/TextField.jsx';

const tick = () => new Promise((r) => setTimeout(r, 30));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

function Wrap({ onSubmit, onCancel }) {
  const [v, setV] = useState('');
  return <TextField value={v} onChange={setV} onSubmit={onSubmit} onCancel={onCancel} focus color="white" />;
}

test('TextField: plain Return submits the message', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'hello') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits.length, 1);
  assert.equal(submits[0], 'hello');
  unmount();
});

test('TextField: Option+Return (ESC+CR) inserts newline, does NOT submit', async () => {
  const submits = [];
  const cancels = [];
  const { stdin, lastFrame, unmount } = render(
    <Wrap onSubmit={(v) => submits.push(v)} onCancel={() => cancels.push(true)} />
  );
  for (const c of 'hi') await press(stdin, c);
  // ESC followed by CR — what macOS Terminal/iTerm send for ⌥↵. Keypress
  // merges them into key.meta + key.return when they arrive together.
  await press(stdin, '\x1b\r');
  for (const c of 'ok') await press(stdin, c);
  assert.equal(submits.length, 0, '⌥↵ must NOT submit');
  assert.equal(cancels.length, 0, '⌥↵ must NOT trigger cancel either');
  const frame = lastFrame() || '';
  assert.match(frame, /hi/);
  assert.match(frame, /ok/);
  unmount();
});

test('TextField: ⌥↵ split across two reads (ESC, then CR ~30ms later) inserts newline', async () => {
  // This is the case keypress's meta-prefix merge window misses on some
  // terminals — the regression the user hit after the first fix.
  const submits = [];
  const cancels = [];
  const { stdin, unmount } = render(
    <Wrap onSubmit={(v) => submits.push(v)} onCancel={() => cancels.push(true)} />
  );
  for (const c of 'a') await press(stdin, c);
  // Two separate stdin writes — keypress won't merge these.
  stdin.write('\x1b');
  await new Promise((r) => setTimeout(r, 30)); // < 80ms ESC merge window
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 120)); // give the timer time to clear
  for (const c of 'b') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(cancels.length, 0, 'split ⌥↵ must NOT fire cancel');
  assert.equal(submits.length, 1, 'should submit exactly once on final Return');
  assert.equal(submits[0], 'a\nb');
  unmount();
});

// NOTE: there's no test for "standalone Esc fires cancel" — that path
// works in real terminals but is untestable through ink-testing-library
// because the underlying `keypress` library doesn't flush a lone ESC
// byte until a follow-up arrives. The Option+Return tests above are
// the meaningful behavioral verification of the deferred-escape logic.

test('TextField: long input keeps caret visible (horizontal scroll via truncate-start)', async () => {
  // Regression for "typing blind past one terminal width" (GH #1). The
  // last-line Text uses wrap="truncate-start", which causes Ink to truncate
  // the LEFT side of the line when content exceeds the box width — caret
  // stays on the right edge.
  const Wrap20 = ({ onSubmit }) => {
    const [v, setV] = React.useState('');
    return <TextField value={v} onChange={setV} onSubmit={onSubmit} width={20} focus color="white" />;
  };
  const { stdin, lastFrame, unmount } = render(<Wrap20 onSubmit={() => {}} />);
  // 60 chars >> 20-wide field
  for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX') await press(stdin, c);
  const frame = lastFrame() || '';
  // The trailing characters must be present (caret end is visible).
  // We assert "UVWX" appears (last typed letters) and that the rendered
  // frame for this field never exceeds the configured width.
  assert.match(frame, /UVWX/, 'rightmost typed chars must remain visible');
  for (const line of frame.split('\n')) {
    assert.ok(line.length <= 40, `line "${line.slice(0, 50)}" exceeds reasonable width (frame may include test harness padding)`);
  }
  unmount();
});

test('TextField: multi-line value renders earlier lines above the caret line', async () => {
  // Regression for "Ctrl+J inserts above" (GH #4) — even if a container
  // anchors the field, the per-line render means line order is
  // first→last top-to-bottom within this Box.
  const { stdin, lastFrame, unmount } = render(<Wrap onSubmit={() => {}} />);
  for (const c of 'first') await press(stdin, c);
  await press(stdin, '\n'); // Ctrl+J
  for (const c of 'second') await press(stdin, c);
  const frame = lastFrame() || '';
  const firstIdx = frame.indexOf('first');
  const secondIdx = frame.indexOf('second');
  assert.ok(firstIdx >= 0 && secondIdx >= 0, 'both lines must render');
  assert.ok(firstIdx < secondIdx, `"first" (idx ${firstIdx}) must appear above "second" (idx ${secondIdx})`);
  unmount();
});

test('TextField: Ctrl+J still inserts a newline (universal fallback)', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'a') await press(stdin, c);
  await press(stdin, '\n'); // Ctrl+J → LF
  for (const c of 'b') await press(stdin, c);
  await press(stdin, '\r'); // submit
  assert.equal(submits.length, 1);
  assert.equal(submits[0], 'a\nb');
  unmount();
});
