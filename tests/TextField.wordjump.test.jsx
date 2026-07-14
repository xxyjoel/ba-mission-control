// tests/TextField.wordjump.test.jsx — Option+Left / Option+Right
// (macOS) and Ctrl+Left / Ctrl+Right (Linux/Windows) word jumps.
// User-reported gap: "should be able to use option and arrow keys to
// navigate the user's text box."
//
// The boundary helpers are pure functions, so we test the BEHAVIOR
// (cursor lands on expected position) via the user-visible side
// effects: typing after the jump inserts at the expected column.

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

function Wrap({ initial = '', onSubmit }) {
  const [v, setV] = useState(initial);
  return <TextField value={v} onChange={setV} onSubmit={onSubmit} focus color="white" />;
}

// Ink-testing-library decodes `\x1bb` (ESC b) as `{key.meta: true, input: 'b'}`
// which is what Terminal.app sends for Option+B (Emacs convention). Same
// for `\x1bf` → Option+F. We test these flows because they exercise the
// `meta+letter` branch of the handler — the most common macOS terminal
// behavior in practice.
test('TextField: Option+B jumps cursor to previous word boundary', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap initial="hello world" onSubmit={(v) => submits.push(v)} />);
  // Cursor is at end after mount (cursorPos initialized to value.length).
  await press(stdin, '\x1bb'); // ESC b → meta+b → jump back one word
  // Now cursor should be at the start of "world" (index 6).
  // Type X — gets inserted at cursor; new value: "hello Xworld".
  await press(stdin, 'X');
  await press(stdin, '\r'); // submit
  assert.equal(submits.length, 1);
  assert.equal(submits[0], 'hello Xworld');
  unmount();
});

test('TextField: Option+F jumps cursor to next word boundary', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap initial="alpha beta gamma" onSubmit={(v) => submits.push(v)} />);
  // Cursor at end. Walk back to start with home, then forward by word.
  await press(stdin, '\x01'); // Ctrl+A → home
  await press(stdin, '\x1bf'); // Option+F → forward one word
  // Cursor at end of "alpha" (index 5).
  await press(stdin, 'X');
  await press(stdin, '\r');
  assert.equal(submits[0], 'alphaX beta gamma');
  unmount();
});

test('TextField: word jump skips punctuation', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap initial="foo, bar" onSubmit={(v) => submits.push(v)} />);
  await press(stdin, '\x1bb'); // jump back from end → start of "bar" (index 5)
  await press(stdin, 'X');
  await press(stdin, '\r');
  assert.equal(submits[0], 'foo, Xbar');
  unmount();
});

test('TextField: Option+B from middle of word jumps to that word\'s start', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap initial="hello world" onSubmit={(v) => submits.push(v)} />);
  await press(stdin, '\x01'); // home
  // Move 8 cursor positions right (we don't have a forward-by-N helper;
  // just press right arrow 8 times)
  for (let i = 0; i < 8; i++) await press(stdin, '\x1b[C');
  // Cursor at index 8 — inside "world" between 'or' and 'ld'
  await press(stdin, '\x1bb'); // jump back to "world" start (index 6)
  await press(stdin, 'X');
  await press(stdin, '\r');
  assert.equal(submits[0], 'hello Xworld');
  unmount();
});

test('TextField: word jump at start of buffer is no-op', async () => {
  const submits = [];
  const { stdin, unmount } = render(<Wrap initial="abc" onSubmit={(v) => submits.push(v)} />);
  await press(stdin, '\x01'); // home
  await press(stdin, '\x1bb'); // already at start — no movement
  await press(stdin, 'X');
  await press(stdin, '\r');
  assert.equal(submits[0], 'Xabc');
  unmount();
});
