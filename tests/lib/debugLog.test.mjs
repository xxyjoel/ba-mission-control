// tests/lib/debugLog.test.mjs — 0108: dlog() must be a zero-I/O no-op unless
// MC_DEBUG is set, so daily-driver users who aren't debugging pay nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dlog, debugLogPath } from '../../tui/lib/debugLog.js';

// Point the log at a throwaway state dir so we never touch the real one.
const STATE = mkdtempSync(join(tmpdir(), 'mc-dbg-'));
process.env.XDG_STATE_HOME = STATE;
const LOG = debugLogPath();

test('dlog is a no-op (no file) when MC_DEBUG is unset', () => {
  delete process.env.MC_DEBUG;
  for (let i = 0; i < 100; i++) dlog('test', 'should-not-write', { i });
  assert.equal(existsSync(LOG), false, 'no debug.log created when disabled');
});

test('dlog is a no-op for MC_DEBUG values other than 1/true', () => {
  process.env.MC_DEBUG = '0';
  dlog('test', 'still-off');
  assert.equal(existsSync(LOG), false);
  process.env.MC_DEBUG = 'yes'; // not an accepted truthy value
  dlog('test', 'still-off');
  assert.equal(existsSync(LOG), false);
  delete process.env.MC_DEBUG;
});

test('dlog appends one JSON line per call when MC_DEBUG=1', () => {
  process.env.MC_DEBUG = '1';
  dlog('pty', 'spawn', { slot: 3, pid: 1234 });
  dlog('app', 'boot');
  assert.equal(existsSync(LOG), true, 'log created when enabled');
  const lines = readFileSync(LOG, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.scope, 'pty');
  assert.equal(first.msg, 'spawn');
  assert.equal(first.slot, 3);
  assert.ok(typeof first.t === 'string' && first.t.length > 0, 'has a timestamp');
  delete process.env.MC_DEBUG;
  rmSync(STATE, { recursive: true, force: true });
});
