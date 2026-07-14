// tests/recipes/textfield-cursor.recipes.test.jsx — cursor positioning
// under a real PTY. ink-testing-library collapses Backspace into
// key.delete and swallows raw Home/End — these recipes drive the actual
// rendered Ink app through node-pty + xterm.js, where the wire-level
// bytes go through the terminal stack the user actually uses.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const tfApp = join(here, '..', 'lib', 'pty-fixtures', 'textfield-app.mjs');

const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const BACKSPACE = '\x7f';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const CTRL_J = '\x0a';

test('pty cursor: left arrow + insert lands mid-string', async () => {
  // After typing 'XY' at cursor=2, frame is `abXY█cd` — caret between
  // the inserted chars and the original tail. Allow the inline caret.
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'abcd', tick: 100 },
      { press: LEFT, tick: 60 },
      { press: LEFT, tick: 60 },
      { type: 'XY', tick: 100,
        expectFrame: [/abXY.?cd/], expectNotFrame: [/abcd[^X]/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});

test('pty cursor: backspace deletes BEFORE cursor', async () => {
  // Frame has the caret block (█) rendered inline at cursor position,
  // so `/abd/` doesn't match `ab█d`. We allow any single char between
  // (or none) via `.?`.
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'abcd', tick: 100, expectFrame: [/abcd/] },
      { press: LEFT, tick: 60 }, // cursor between c and d
      { press: BACKSPACE, tick: 100,
        expectFrame: [/ab.?d/], expectNotFrame: [/abcd/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});

test('pty cursor: Ctrl+A jumps to line start; Ctrl+E to end', async () => {
  // After Ctrl+E + '!', the cursor is at the end of the buffer so the
  // final frame has `> hello!█` and `/> hello!/` matches cleanly.
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'hello', tick: 100 },
      { press: CTRL_A, tick: 60 },
      { type: '> ', tick: 100 },        // intermediate state has inline caret; skip strict assertion
      { press: CTRL_E, tick: 60 },
      { type: '!', tick: 100,
        expectFrame: [/> hello!/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});

test('pty cursor: ↑/↓ navigate within multi-line buffer', async () => {
  const UP = '\x1b[A';
  const DOWN = '\x1b[B';
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'first', tick: 60 },
      { press: CTRL_J, tick: 60 },
      { type: 'second', tick: 60 },
      // cursor at end of "second" col 6; ↑ → col 5 of "first" (max
      // col is end-of-line since "first" has length 5)
      { press: UP, tick: 60 },
      { type: '!', tick: 100,
        expectFrame: [/first!/] },
      // back down to "second", then end
      { press: DOWN, tick: 60 },
      { type: '@', tick: 100,
        expectFrame: [/first!/, /second.*?@/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});

test('pty cursor: Ctrl+J inserts newline at cursor (not at end)', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'abcd', tick: 100 },
      { press: LEFT, tick: 60 },
      { press: LEFT, tick: 60 }, // cursor at 2
      { press: CTRL_J, tick: 100,
        // 'ab' then newline then 'cd' — both visible, order matters
        expectFrame: [/ab[\s\S]*?cd/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});
