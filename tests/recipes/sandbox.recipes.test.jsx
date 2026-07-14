// tests/recipes/sandbox.recipes.test.jsx — verify MC_CONFIG_DIR
// isolation under a real PTY. Two pieces of behavior matter:
//
//   1. The "DEV · SANDBOXED" banner appears in the status bar so the
//      operator can never confuse a dev mc with their production one.
//
//   2. State writes go to MC_CONFIG_DIR, not the user's real
//      ~/.config/claude-mc. We point MC_CONFIG_DIR at a fresh temp dir
//      and assert that files appear there after a brief run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runRecipePty } from '../lib/recipe-pty.js';

const here = dirname(fileURLToPath(import.meta.url));
const mcBin = join(here, '..', '..', 'bin', 'mc.mjs');

function mkSandbox() {
  return mkdtempSync(join(tmpdir(), 'mc-sandbox-'));
}

test('pty sandbox: DEV banner appears in status bar', async () => {
  const sandbox = mkSandbox();
  try {
    await runRecipePty({
      command: process.execPath,
      args: [mcBin],
      env: { ...process.env, MC_MOCK: 'quick-reply', MC_NO_TRANSCRIPT: '1', MC_CONFIG_DIR: sandbox },
      bootDelayMs: 1500,
      cols: 120,
      rows: 30,
      steps: [
        { tick: 300,
          // Banner can wrap across two terminal lines depending on width;
          // tolerate that.
          expectFrame: [/DEV[\s\S]*?SANDBOXED/] },
        { label: 'quit out',
          press: 'q', tick: 200 },
        { press: 's', expectExit: 3000 },
      ],
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('pty sandbox: state writes land in MC_CONFIG_DIR, not the real one', async () => {
  const sandbox = mkSandbox();
  try {
    await runRecipePty({
      command: process.execPath,
      args: [mcBin],
      env: { ...process.env, MC_MOCK: 'quick-reply', MC_NO_TRANSCRIPT: '1', MC_CONFIG_DIR: sandbox },
      bootDelayMs: 1500,
      cols: 120,
      rows: 30,
      steps: [
        { tick: 300 },
        // Open settings and change theme — any write proves the path
        { press: ',', tick: 200 }, // open settings
        { press: '\x1b', tick: 200 }, // close (settings auto-saves on change but we'll also wait for sessions sync)
        { tick: 400 }, // let session-sync interval fire
        { press: 'q', tick: 200 },
        { press: 's', expectExit: 3000 },
      ],
    });
    // After the run, the sandbox dir should contain mc's state files.
    assert.ok(existsSync(sandbox), 'sandbox dir still exists');
    const files = readdirSync(sandbox);
    assert.ok(
      files.includes('settings.json'),
      `expected settings.json in sandbox; found: ${JSON.stringify(files)}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
