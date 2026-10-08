// tests/ptyCore.drainOneAtATime.test.mjs — 0458: queued messages are sent one
// at a time. With claude's bracketed-paste mode ON, the drain used to write
// paste1 paste2 … and then every CR on later ticks, so claude saw one long
// paste followed by Enters: the queued messages merged into one prompt. Each
// queued message must get its own Enter before the next one is written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

const T0 = 1_800_000_000_000;
const P = (s) => '\x1b[200~' + s + '\x1b[201~';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const pty = {
      pid: 7400 + spawned.length, _writes: [],
      write(s) { this._writes.push(s); },
      kill() {},
      resize() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeAgent(t, overrides = {}, apis = ['setTimeout', 'setImmediate', 'Date']) {
  t.mock.timers.enable({ apis, now: T0 });
  const spawn = makeFakeSpawn();
  const agent = new PtyAgent({
    slot: 4, id: 's4-0458', cwd: '/tmp/fake-0458', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits', sessionId: '04580000-0000-4000-8000-000000000000',
    spawn, ...overrides,
  });
  t.after(() => { try { agent.kill(); } catch {} });
  agent.start();
  // claude at its prompt: bracketed paste ON.
  agent.term = { modes: { bracketedPasteMode: true }, write() {}, dispose() {} };
  return { agent, pty: spawn.spawned[0] };
}

test('0458: bracketed paste ON — each queued message gets its own Enter, in order', (t) => {
  const { agent, pty } = makeAgent(t);
  agent.send('one');
  agent.send('two');
  agent.send('three');
  t.mock.timers.tick(3000); // readiness flips, drain runs (mocked immediates fire in the same tick)
  for (let i = 0; i < 6; i++) t.mock.timers.tick(0);
  assert.deepEqual(pty._writes, [P('one'), '\r', P('two'), '\r', P('three'), '\r']);
  assert.deepEqual(agent.pendingSends, []);
});

test('0458: a send() during the drain waits behind the queued messages', (t) => {
  const { agent, pty } = makeAgent(t);
  agent.send('one');
  agent.send('two');
  // 'late' is sent mid-drain: right after the first paste is written.
  const write = pty.write;
  pty.write = function (s) { write.call(this, s); if (s === P('one')) agent.send('late'); };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 6; i++) t.mock.timers.tick(0);
  assert.deepEqual(pty._writes, [P('one'), '\r', P('two'), '\r', P('late'), '\r']);
});

test('0458: an Enter and the next paste never share a tick', async (t) => {
  // Review defect: the CR callback wrote '\r' and then the next paste in the
  // same callback, so claude could read them as one chunk (#24, #25). Real
  // setImmediate here, wrapped to tag each write with the callback it ran in
  // (mocked immediates scheduled during a tick all run inside that tick).
  const realImmediate = globalThis.setImmediate;
  let cb = 0;
  globalThis.setImmediate = (fn, ...a) => realImmediate(() => { cb++; fn(...a); });
  t.after(() => { globalThis.setImmediate = realImmediate; });
  const { agent, pty } = makeAgent(t, {}, ['setTimeout', 'Date']);
  agent.send('one');
  agent.send('two');
  agent.send('three');
  const log = [];
  const write = pty.write;
  pty.write = function (s) { write.call(this, s); log.push([cb, s]); };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 12; i++) await new Promise((r) => realImmediate(r));
  assert.deepEqual(log.map(([, s]) => s), [P('one'), '\r', P('two'), '\r', P('three'), '\r']);
  for (let i = 1; i < log.length; i++) {
    assert.notEqual(log[i][0], log[i - 1][0], `write ${i} (${JSON.stringify(log[i][1])}) shares a tick with the one before`);
  }
});

test('0458: a failed write mid-drain does not strand the rest or let a new send overtake', async (t) => {
  // Review defect: a failed write cleared the drain flag but left the queue,
  // so the next send() wrote at once, ahead of the older queued messages.
  // Real setImmediate: mocked immediates let the readiness timer fire a
  // second time inside one tick(), which re-drained and hid the defect.
  const { agent, pty } = makeAgent(t, {}, ['setTimeout', 'Date']);
  agent.send('one');
  agent.send('two');
  agent.send('three');
  const write = pty.write;
  let failed = false;
  pty.write = function (s) {
    if (s === P('two') && !failed) { failed = true; throw new Error('EIO'); }
    write.call(this, s);
    if (s === P('one')) agent.send('late');
  };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(pty._writes, [P('one'), '\r', P('three'), '\r', P('late'), '\r']);
  assert.deepEqual(agent.pendingSends, []);
  assert.ok(agent.tail.some((l) => l.kind === 'err' && l.text === 'pty write failed: EIO'));
});
