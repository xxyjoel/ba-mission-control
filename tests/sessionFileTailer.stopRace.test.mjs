// tests/sessionFileTailer.stopRace.test.mjs — 0408-F7: stop() during init()'s
// prime read must not leak the 1.5s backstop interval, the creation poll, or
// the fs.watch watcher for the life of the process. init() runs async: before
// the fix its continuation past `await primeStatusFromDisk()` ignored
// `stopped` and armed all three.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSessionTailer, claudeProjectDir } from '../server/sessionFileTailer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const mkSid = () => `0c3d4e5f-6071-4289-abcd-${String(++n).padStart(12, '0')}`;

function makeAgent(cwd) {
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId: mkSid(), status: 'idle', activity: '', tail: [],
    spawnedAt: Date.now(), appendTail(e) { this.tail.push(e); },
  });
  return agent;
}

test('stop() racing init(): no interval is armed after stop (file exists)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-race-'));
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const agent = makeAgent(cwd);
  writeFileSync(join(claudeProjectDir(cwd), `${agent.sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');

  let stoppedFlag = false, intervalsAfterStop = 0;
  const origSetInterval = globalThis.setInterval;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (...a) => { if (stoppedFlag) intervalsAfterStop++; return origSetInterval(...a); };
  try {
    const t = startSessionTailer({ agent }); // drive:'self' — the leaking shape
    t.stop(); stoppedFlag = true;            // lands mid-await in init()
    await new Promise((r) => origSetTimeout(r, 250));
    assert.equal(intervalsAfterStop, 0,
      '0408-F7: init() must not arm the stat-poll interval after stop()');
  } finally {
    globalThis.setInterval = origSetInterval;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('stop() racing init(): no creation poll is armed after stop (file absent)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-race-'));
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const agent = makeAgent(cwd); // transcript never written → creation-poll path

  let stoppedFlag = false, armedAfterStop = 0;
  const origSetInterval = globalThis.setInterval;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (...a) => { if (stoppedFlag) armedAfterStop++; return origSetInterval(...a); };
  // Count only tailer-scale delays (creationPollDelay is 500/2000ms) so a
  // runner-owned long timer can't false-positive this assertion.
  globalThis.setTimeout = (...a) => { if (stoppedFlag && (a[1] ?? 0) <= 2000) armedAfterStop++; return origSetTimeout(...a); };
  try {
    const t = startSessionTailer({ agent });
    t.stop(); stoppedFlag = true;
    await new Promise((r) => origSetTimeout(r, 250));
    assert.equal(armedAfterStop, 0,
      '0408-F7: neither the creation poll nor the backstop may arm after stop()');
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.setTimeout = origSetTimeout;
    rmSync(cwd, { recursive: true, force: true });
  }
});
