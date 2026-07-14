// tests/debugKeys.test.mjs — runtime toggle for the key-event recorder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-dbg-'));
process.env.MC_CONFIG_DIR = sandbox;
process.env.MC_DEBUG_KEYS = ''; // ensure initial state is off

const dk = await import('../tui/lib/debugKeys.js');

test('debugKeys: initial state honors env (off when unset)', () => {
  assert.equal(dk.isDebugKeysActive(), false);
});

test('debugKeys: setDebugKeysActive(true) enables; logKey writes', () => {
  dk.setDebugKeysActive(true);
  assert.equal(dk.isDebugKeysActive(), true);
  dk.logKey('a', { return: false }, 'test');
  const raw = readFileSync(dk.DEBUG_KEYS_PATH, 'utf8');
  assert.match(raw, /debug-keys: ENABLED/);
  assert.match(raw, /"input":"a"/);
});

test('debugKeys: setDebugKeysActive(false) disables; subsequent logKey is a no-op', () => {
  const beforeBytes = readFileSync(dk.DEBUG_KEYS_PATH, 'utf8').length;
  dk.setDebugKeysActive(false);
  dk.logKey('b', { return: false }, 'test-after-disable');
  const afterBytes = readFileSync(dk.DEBUG_KEYS_PATH, 'utf8').length;
  // The disable marker is written (small bytes) but no new key event entry.
  const raw = readFileSync(dk.DEBUG_KEYS_PATH, 'utf8');
  assert.match(raw, /debug-keys: DISABLED/);
  assert.doesNotMatch(raw, /"input":"b"/);
});

test('debugKeys: subscribe fires on flip', () => {
  const calls = [];
  const unsub = dk.subscribeDebugKeys((on) => calls.push(on));
  dk.setDebugKeysActive(true);
  dk.setDebugKeysActive(false);
  unsub();
  dk.setDebugKeysActive(true); // should not fire after unsubscribe
  assert.deepEqual(calls, [true, false]);
});

test('debugKeys: clearDebugKeysLog truncates the file', () => {
  // file has stuff from prior tests
  assert.ok(readFileSync(dk.DEBUG_KEYS_PATH, 'utf8').length > 0);
  const ok = dk.clearDebugKeysLog();
  assert.equal(ok, true);
  assert.equal(readFileSync(dk.DEBUG_KEYS_PATH, 'utf8').length, 0);
});

test('cleanup', () => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  assert.ok(true);
});
