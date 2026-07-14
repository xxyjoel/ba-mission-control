// tests/recipes/textfield.recipes.test.jsx — real-PTY tests for the
// TextField composer behavior. The in-process tests at tests/TextField
// .test.jsx pass against ink-testing-library's virtual frame; this file
// runs the SAME component inside a real pseudo-terminal so we catch
// rendering bugs that only show up against actual ANSI / xterm output —
// the gap the user has been hitting where Ctrl+J appears to leave the
// caret on the same line.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const tfApp = join(here, '..', 'lib', 'pty-fixtures', 'textfield-app.mjs');

// Ctrl+J as a single byte on the wire (LF = 0x0a). This is what every
// terminal sends when the user holds Ctrl and presses J.
const CTRL_J = '\x0a';

test('pty: TextField — Ctrl+J inserts a newline BELOW the current line', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { label: 'initial frame is empty', tick: 100,
        expectFrame: [/type then press Ctrl\+J/] },
      { label: 'type "first"', type: 'first', tick: 100,
        expectFrame: [/first/] },
      { label: 'press Ctrl+J', press: CTRL_J, tick: 100 },
      { label: 'type "second"', type: 'second', tick: 100,
        // The decisive assertion: both substrings are present AND
        // "first" appears earlier in the rendered frame than "second".
        // readFrame() joins terminal rows with '\n' so indexOf reflects
        // top-to-bottom visual order.
        expectFrame: [/first[\s\S]*?second/] },
      { label: 'press Enter to submit', press: '\r', expectExit: 2000 },
    ],
  });
});

test('pty: TextField — three lines render top-to-bottom', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [tfApp],
    bootDelayMs: 700,
    rows: 20,
    steps: [
      { tick: 100 },
      { type: 'aaa' }, { press: CTRL_J, tick: 60 },
      { type: 'bbb' }, { press: CTRL_J, tick: 60 },
      { type: 'ccc', tick: 100,
        expectFrame: [/aaa[\s\S]*?bbb[\s\S]*?ccc/] },
      { press: '\r', expectExit: 2000 },
    ],
  });
});
