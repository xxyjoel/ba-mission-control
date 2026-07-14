// tests/recipes/quit-confirm.recipes.test.jsx — real-PTY test for the
// quit confirm flow. Spawns the actual `mc` binary (via bin/mc.mjs) in a
// pseudo-terminal with MC_MOCK set so no claude subprocess is spawned,
// presses `q`, asserts the confirm modal appears, then verifies y/n.
//
// Why a PTY test for this: the prior `q-then-y` design was overruled by
// the user — they pointed out the self-conflicting logic (q is both the
// trigger and one of the keys the armed state must disambiguate). The
// new design opens an explicit modal whose y/n live in modal scope, so
// the parent layer's `q` handler only routes to setModal('quit').
// Verifying this end-to-end means actually booting mc — a unit test on
// the modal alone wouldn't catch the routing bug if I had wired it
// wrong.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const mcBin = join(here, '..', '..', 'bin', 'mc.mjs');

// Disable transcript writes so the killAll path doesn't keep streams open.
// MC_MOCK=quick-reply boots mc with a fixture so no real claude subprocess
// is needed. No sessions are auto-launched, so we land on the empty grid.
const env = {
  ...process.env,
  MC_MOCK: 'quick-reply',
  MC_NO_TRANSCRIPT: '1',
};

test('pty: pressing q opens the QuitConfirm modal (does NOT exit immediately)', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [mcBin],
    env,
    bootDelayMs: 1500, // tsx + Ink first frame + fleet boot
    cols: 100,
    rows: 30,
    steps: [
      { label: 'initial frame shows the empty-grid hint',
        tick: 200,
        expectFrame: [/no sessions running|press n|to launch/i] },
      { label: 'press q → confirm modal appears, mc still alive',
        press: 'q',
        tick: 200,
        expectFrame: [/Quit mc\?/, /\[s\] save & quit/, /\[n\] cancel/] },
      { label: 'press n → modal closes, mc stays running',
        press: 'n',
        tick: 200,
        expectFrame: [/no sessions running|press n/i],
        expectNotFrame: [/Quit mc\?/] },
      { label: 'press q again → modal reopens',
        press: 'q',
        tick: 200,
        expectFrame: [/Quit mc\?/] },
      { label: 'press y → mc exits cleanly',
        press: 's',
        expectExit: 3000 },
    ],
  });
});

test('pty: Esc inside QuitConfirm cancels (same as n)', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [mcBin],
    env,
    bootDelayMs: 1500,
    cols: 100,
    rows: 30,
    steps: [
      { tick: 200 },
      { press: 'q', tick: 200, expectFrame: [/Quit mc\?/] },
      { press: '\x1b', tick: 200, expectNotFrame: [/Quit mc\?/] },
      { label: 'mc still alive — verify by opening Help (?)',
        press: '?', tick: 200,
        expectFrame: [/SETTINGS|NAVIGATE|Quit/] },
      { label: 'close Help and quit via q→y',
        press: '\x1b', tick: 200 },
      { press: 'q', tick: 200 },
      { press: 's', expectExit: 3000 },
    ],
  });
});

test('pty: arbitrary keys inside QuitConfirm are ignored (no timer, no auto-exit)', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [mcBin],
    env,
    bootDelayMs: 1500,
    cols: 100,
    rows: 30,
    steps: [
      { tick: 200 },
      { press: 'q', tick: 200, expectFrame: [/Quit mc\?/] },
      // bombard with non-y/n/esc keys; modal should remain
      { type: 'abc123', tick: 200, expectFrame: [/Quit mc\?/] },
      { press: 's', expectExit: 3000 },
    ],
  });
});
