// tests/energy.idleWakeups.test.mjs — pure seams of the 2026-08 idle-energy
// batch (0377–0381): rotation-hunt dir-mtime gate, creation-poll backoff, and
// the external-drive tick() seams the Fleet tailer driver depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  shouldHuntDirMtime,
  creationPollDelay,
  startSessionTailer,
  claudeSessionPath,
} from '../server/sessionFileTailer.mjs';
import { startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

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

// 0465: the per-slot creation polls (a setTimeout chain in each tailer while
// its file doesn't exist yet) bypassed the Fleet's shared driver — 2 timers per
// never-prompted slot, 20 at 10 slots. Under drive:'external' the creation
// check now runs from tick(), so live timers must not grow with slot count.
// Live setTimeout AND setInterval handles are counted by wrapping the globals
// the tailers call — an interval coming back under external drive must count.
function trackTimeouts() {
  const live = new Set();
  const orig = {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = orig.setTimeout((...a) => { live.delete(h); fn(...a); }, ms, ...args);
    live.add(h);
    return h;
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    const h = orig.setInterval(fn, ms, ...args);
    live.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => { live.delete(h); return orig.clearTimeout(h); };
  globalThis.clearInterval = (h) => { live.delete(h); return orig.clearInterval(h); };
  return {
    live,
    wait: (ms) => new Promise((r) => orig.setTimeout(r, ms)),
    restore() { Object.assign(globalThis, orig); },
  };
}

async function liveTimersFor(slots, drive) {
  const t = trackTimeouts();
  const tailers = [];
  try {
    for (let i = 0; i < slots; i++) {
      const a = fakeAgent(join(tmpdir(), `mc-0465-${randomUUID()}`), randomUUID());
      tailers.push(startSessionTailer({ agent: a, drive }));
      tailers.push(startStatusHookTailer({ agent: a, drive }));
    }
    await t.wait(100);   // async init settles; still under the 500 ms first creation poll
    return t.live.size;
  } finally {
    for (const x of tailers) x.stop();
    t.restore();
  }
}

test('0465: drive:external — live timers do not grow with never-prompted slot count', async () => {
  const one = await liveTimersFor(1, 'external');
  const ten = await liveTimersFor(10, 'external');
  assert.equal(ten, one, `10 idle slots hold ${ten} live timers, 1 slot holds ${one}`);
  assert.equal(ten, 0);
});

test('0465: drive:self keeps its own creation poll and stat-poll backstop (two per tailer)', async () => {
  // per tailer: one pending creation-poll timeout + one stat-poll interval
  assert.equal(await liveTimersFor(3, 'self'), 3 * 2 * 2);
});

test('0465: drive:external — tick() picks up a session file created after start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-0465-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const sid = randomUUID();
    const agent = fakeAgent(cwd, sid);
    const tailer = startSessionTailer({ agent, drive: 'external' });
    await new Promise((r) => setTimeout(r, 50));
    tailer.tick();   // no file yet: harmless
    const file = claudeSessionPath({ cwd, sessionId: sid });
    mkdirSync(join(file, '..'), { recursive: true });
    const ts = '2026-10-08T10:00:00.000Z';
    writeFileSync(file, JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'hi' } }) + '\n');
    tailer.tick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(agent.sessionStartedAt, Date.parse(ts), 'record 0 primed once the file appears');
    // The tick must also attach the watcher: a later append is read with no
    // further tick (else the card only moves on Fleet ticks, 1.5-3 s apart).
    let changes = 0;
    agent.on('change', () => { changes++; });
    appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(changes > 0, 'watcher read the append without a tick');
    tailer.stop();
  } finally {
    process.env.HOME = prevHome;
  }
});

test('0465: drive:external — tick() picks up a hook file created after start', async () => {
  const agent = fakeAgent(tmpdir(), randomUUID());
  const tailer = startStatusHookTailer({ agent, drive: 'external' });
  const file = statusFilePath({ sessionId: agent.sessionId });
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ts: Date.now(), event: 'PreToolUse', tool_name: 'Bash' }) + '\n');
  tailer.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.hookStatus, 'working');
  // doRead() reads on every tick with or without a watcher, so the line above
  // alone passes without an attach. A Stop appended with no tick proves it.
  appendFileSync(file, JSON.stringify({ ts: Date.now(), event: 'Stop' }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(agent.hookStatus, 'idle', 'watcher read the append without a tick');
  tailer.stop();
});
