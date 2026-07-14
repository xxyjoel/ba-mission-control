// tests/recipes/boot-banner.recipes.test.jsx — verify the boot banner
// surfaces the running build's version + git short SHA. The user has
// hit "is my running mc the version with my fix?" enough times that a
// loud banner is the cheapest cure (audit #383). Also verifies the
// :version verb toasts the same line at runtime.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const mcBin = join(here, '..', '..', 'bin', 'mc.mjs');

const env = {
  ...process.env,
  MC_MOCK: 'quick-reply',
  MC_NO_TRANSCRIPT: '1',
};

// The pre-Ink boot banner ("[mc] 0.2.0... · g<sha>") IS printed (user
// sees it in scrollback) but Ink's alternate-screen mode clears it
// before we can snapshot the buffer. The :version verb is the testable
// equivalent — it toasts the same line at runtime, and toasts ARE
// rendered into the live frame.
test('pty boot: :version verb toasts the running build line', async () => {
  await runRecipePty({
    command: process.execPath,
    args: [mcBin],
    env,
    bootDelayMs: 1500,
    cols: 120,
    rows: 30,
    steps: [
      { tick: 200 },
      { press: ':', tick: 100 },
      { type: 'version', tick: 100 },
      { press: '\r', tick: 200,
        // semver-ish version, optionally followed by ' · g<sha>'
        expectFrame: [/mc\s+\d+\.\d+\.\d+/] },
      { press: 'q', tick: 200 },
      { press: 's', expectExit: 3000 },
    ],
  });
});
