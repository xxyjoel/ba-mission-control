// tests/recipes/pty.recipes.test.jsx — proof recipes for the PTY backend.
//
// These exist to verify the runner end-to-end:
//   1. Spawning a non-Ink command (/bin/echo) and reading its output via
//      the xterm.js render path — the "happy path" for the rendering pipe.
//   2. Driving a real Ink TUI subprocess (the counter-app fixture) with
//      keystrokes and asserting on rendered state — the realistic case.
//
// Once you trust this, expand to mc itself with MC_MOCK fixtures.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const counterApp = join(here, '..', 'lib', 'pty-fixtures', 'counter-app.mjs');

test('pty recipe: /bin/echo output renders through xterm', async () => {
  await runRecipePty({
    command: '/bin/echo',
    args: ['hello from the pty backend'],
    bootDelayMs: 100,
    steps: [
      { tick: 100 }, // give echo time to print + exit
      { expectFrame: [/hello from the pty backend/] },
      { expectExit: 1000 },
    ],
  });
});

test('pty recipe: counter-app starts at 0, + increments, 0 resets, q quits', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [counterApp],
    bootDelayMs: 600,                  // tsx loader + Ink first render
    steps: [
      { label: 'initial frame shows counter: 0',
        expectFrame: [/counter:/, /\b0\b/, /inc · - dec/] },
      { label: '+ once → counter: 1',
        press: '+',
        tick: 60,
        expectFrame: [/counter:[^\n]*\b1\b/] },
      { label: '+ + + → counter: 4',
        type: '+++',
        tick: 80,
        expectFrame: [/counter:[^\n]*\b4\b/] },
      { label: '0 resets',
        press: '0',
        tick: 60,
        expectFrame: [/counter:[^\n]*\b0\b/] },
      { label: 'q exits the app',
        press: 'q',
        expectExit: 1500 },
    ],
  });
});

test('pty recipe: counter-app handles - going negative', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [counterApp],
    bootDelayMs: 600,
    steps: [
      { press: '-' },
      { press: '-' },
      { tick: 100 },
      { expectFrame: [/counter:[^\n]*-2/] },
      { press: 'q', expectExit: 1500 },
    ],
  });
});
