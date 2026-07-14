// tests/TextField.cursor.test.jsx — cursor positioning behavior added
// in the "real text box" pass. These pin down the editing operations a
// user expects from any text input: insert/delete at cursor, ←/→ move,
// Home/End jump line bounds, external value replacement parks cursor at
// end.

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

function Wrap({ onSubmit, onCancel, initial = '' }) {
  const [v, setV] = useState(initial);
  return (
    <TextField
      value={v}
      onChange={setV}
      onSubmit={(x) => { onSubmit && onSubmit(x); }}
      onCancel={onCancel}
      focus
      color="white"
    />
  );
}

// Ink-testing-library exposes the rendered frame; the value lives inside
// the parent. We assert behavior via onSubmit (full value on Enter) so we
// see the canonical string after a sequence of edits.

test('cursor: left arrow moves cursor; subsequent insert lands at cursor', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'abcd') await press(stdin, c);
  // cursor now at end (4); left twice → cursor at 2 (between b and c)
  await press(stdin, '\x1b[D'); // ←
  await press(stdin, '\x1b[D'); // ←
  for (const c of 'XY') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits[0], 'abXYcd');
  unmount();
});

test('cursor: right arrow moves cursor; insert at end is unchanged', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'abc') await press(stdin, c);
  await press(stdin, '\x1b[D'); // ←
  await press(stdin, '\x1b[D'); // ←
  await press(stdin, '\x1b[C'); // → back to between b and c
  for (const c of 'Z') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits[0], 'abZc');
  unmount();
});

test('cursor: backspace deletes char BEFORE cursor (not always the tail)', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'abcd') await press(stdin, c);
  await press(stdin, '\x1b[D'); // cursor at 3 (between c and d)
  await press(stdin, '\x7f'); // backspace
  await press(stdin, '\r');
  assert.equal(submits[0], 'abd'); // c removed, d preserved
  unmount();
});

// NOTE: forward-delete via \x1b[3~ collapses into key.delete=true with
// empty input under ink-testing-library (same flag as macOS Backspace).
// We treat both as backspace; a real-PTY follow-up test will exercise
// terminal-specific forward-delete when we can wire it. See
// audit/IMPROVEMENTS.md.

test('cursor: backspace at start of buffer is a no-op', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'ab') await press(stdin, c);
  await press(stdin, '\x1b[D');
  await press(stdin, '\x1b[D'); // cursor at 0
  await press(stdin, '\x7f'); // backspace — no-op
  await press(stdin, '\r');
  assert.equal(submits[0], 'ab');
  unmount();
});

test('cursor: Ctrl+A jumps to start of current line; Ctrl+E to end', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'hello') await press(stdin, c);
  await press(stdin, '\x01'); // Ctrl+A
  for (const c of '> ') await press(stdin, c);
  await press(stdin, '\x05'); // Ctrl+E
  for (const c of '!') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits[0], '> hello!');
  unmount();
});

// NOTE: \x1b[H and \x1b[F (raw Home/End escape sequences) are not
// delivered to useInput by Ink 5 — they're filtered upstream. Users
// must rely on Ctrl+A / Ctrl+E (covered above). Real-terminal Home/End
// support is a follow-up tracked in audit/IMPROVEMENTS.md.

test('cursor: Ctrl+A on multi-line moves to start of CURRENT line only', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'first') await press(stdin, c);
  await press(stdin, '\n'); // Ctrl+J newline
  for (const c of 'second') await press(stdin, c);
  await press(stdin, '\x01'); // Ctrl+A → start of "second" line
  for (const c of '!') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits[0], 'first\n!second');
  unmount();
});

test('cursor: Ctrl+J inserts newline at cursor (not always at end)', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'abcd') await press(stdin, c);
  await press(stdin, '\x1b[D');
  await press(stdin, '\x1b[D'); // cursor at 2
  await press(stdin, '\n'); // Ctrl+J
  await press(stdin, '\r');
  assert.equal(submits[0], 'ab\ncd');
  unmount();
});

test('cursor: external value replacement parks cursor at end of new value', async () => {
  // Simulate history-recall: parent replaces value.
  const submits = [];
  function Outer() {
    const [v, setV] = React.useState('typed');
    React.useEffect(() => {
      // After mount, parent replaces value with a longer string.
      const t = setTimeout(() => setV('history recall'), 60);
      return () => clearTimeout(t);
    }, []);
    return (
      <TextField
        value={v}
        onChange={setV}
        onSubmit={(x) => submits.push(x)}
        focus
        color="white"
      />
    );
  }
  const { stdin, unmount } = render(<Outer />);
  await new Promise((r) => setTimeout(r, 120));
  for (const c of '!') await press(stdin, c);
  await press(stdin, '\r');
  // If cursor was parked at end (14) after external replace, '!' lands at 14.
  assert.equal(submits[0], 'history recall!');
  unmount();
});

test('cursor: ↑ on multi-line moves cursor up one line preserving column', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'hello') await press(stdin, c);
  await press(stdin, '\n'); // Ctrl+J → cursor at start of line 2
  for (const c of 'world') await press(stdin, c); // cursor at end of "world" col 5
  await press(stdin, '\x1b[A'); // ↑ → col 5 of line 1 ("hello") = end
  await press(stdin, '!'); // insert at end of "hello"
  await press(stdin, '\r');
  assert.equal(submits[0], 'hello!\nworld');
  unmount();
});

test('cursor: ↑ at top of buffer is no-op (parent owns the key)', async () => {
  // Single-line buffer: TextField's moveUp returns null, so it doesn't
  // touch cursor. (Parent fallthrough — Zoom would use this for history
  // recall, but here there's no parent listener.)
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'abc') await press(stdin, c);
  await press(stdin, '\x1b[A'); // ↑ — no-op
  await press(stdin, '!');
  await press(stdin, '\r');
  assert.equal(submits[0], 'abc!');
  unmount();
});

test('cursor: ↓ on multi-line moves cursor down preserving column', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'hello') await press(stdin, c);
  await press(stdin, '\n');
  for (const c of 'world') await press(stdin, c);
  // cursor at end of "world" → ↑ → end of "hello" → ↓ → end of "world"
  await press(stdin, '\x1b[A');
  await press(stdin, '\x1b[B');
  await press(stdin, '!');
  await press(stdin, '\r');
  assert.equal(submits[0], 'hello\nworld!');
  unmount();
});

test('cursor: right arrow past end is clamped (no overflow)', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap onSubmit={(v) => submits.push(v)} />);
  for (const c of 'ab') await press(stdin, c);
  for (let i = 0; i < 10; i++) await press(stdin, '\x1b[C'); // → way past end
  for (const c of 'c') await press(stdin, c);
  await press(stdin, '\r');
  assert.equal(submits[0], 'abc');
  unmount();
});
