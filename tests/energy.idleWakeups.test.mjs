// tests/energy.idleWakeups.test.mjs — pure seams of the 2026-08 idle-energy
// batch (0377–0381): rotation-hunt dir-mtime gate, creation-poll backoff, and
// the external-drive tick() seams the Fleet tailer driver depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  shouldHuntDirMtime,
  creationPollDelay,
  startSessionTailer,
} from '../server/sessionFileTailer.mjs';
import { startStatusHookTailer } from '../server/statusHookTailer.mjs';

test('shouldHuntDirMtime: failed dir stat (0) disables the gate — always hunt', () => {
  assert.equal(shouldHuntDirMtime(0, 12345, 7), true);
});

test('shouldHuntDirMtime: changed dir mtime always hunts', () => {
  assert.equal(shouldHuntDirMtime(200, 100, 3), true);
});

test('shouldHuntDirMtime: unchanged mtime skips except on the unconditional backstop tick', () => {
  assert.equal(shouldHuntDirMtime(100, 100, 8, 40), false);   // ordinary skip
  assert.equal(shouldHuntDirMtime(100, 100, 40, 40), true);   // backstop fires
  assert.equal(shouldHuntDirMtime(100, 100, 80, 40), true);   // and again
  assert.equal(shouldHuntDirMtime(100, 100, 41, 40), false);
});

test('shouldHuntDirMtime: unconditionalEvery <= 1 disables the gate entirely', () => {
  assert.equal(shouldHuntDirMtime(100, 100, 7, 1), true);
  assert.equal(shouldHuntDirMtime(100, 100, 7, 0), true);
});

test('creationPollDelay: fast for the first 20 attempts, slow after', () => {
  assert.equal(creationPollDelay(0), 500);
  assert.equal(creationPollDelay(19), 500);
  assert.equal(creationPollDelay(20), 2000);
  assert.equal(creationPollDelay(500), 2000);
  // ~10s of fast coverage at the defaults
  let coverage = 0;
  for (let a = 0; a < 20; a++) coverage += creationPollDelay(a);
  assert.equal(coverage, 10_000);
});

function fakeAgent(cwd, sessionId) {
  const a = new EventEmitter();
  a.cwd = cwd;
  a.sessionId = sessionId;
  a.appendTail = () => {};
  return a;
}

test('sessionTailer drive:external exposes tick() and self-drive stays default', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-energy-test-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    const ext = startSessionTailer({ agent: fakeAgent(cwd, sid), drive: 'external' });
    assert.equal(typeof ext.tick, 'function');
    ext.tick();   // must be safe with no file present
    ext.stop();
    ext.tick();   // and a no-op after stop

    const self = startSessionTailer({ agent: fakeAgent(cwd, sid) });
    assert.equal(typeof self.tick, 'function'); // seam exists on self-driven too
    self.stop();
  } finally {
    process.env.HOME = prevHome;
  }
});

test('statusHookTailer drive:external exposes tick() and is stop-safe', () => {
  const a = fakeAgent(tmpdir(), '99999999-8888-7777-6666-555555555555');
  const t = startStatusHookTailer({ agent: a, drive: 'external' });
  assert.equal(typeof t.tick, 'function');
  t.tick();
  t.stop();
  t.tick();
});
