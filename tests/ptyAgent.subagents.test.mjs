// tests/ptyAgent.subagents.test.mjs
// Pins the parallel-fan-out snapshot: PtyAgent.toJSON() derives activeSubagents
// from the pendingSubagents map (jsonlConnector mutates it on tool_use/result),
// and STUCK is suppressed while fan-out is outstanding — sub-agents run on
// sidechains the tailer never reads, so main-thread lastEventTs goes stale even
// though work is happening.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const h = { data: [], exit: [] };
    const pty = {
      pid: 9000 + spawned.length, _bin: bin, _args: args, _opts: opts,
      write() {}, kill() {}, resize() {},
      onData(fn) { h.data.push(fn); return { dispose() {} }; },
      onExit(fn) { h.exit.push(fn); return { dispose() {} }; },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function bootAgent() {
  const agent = new PtyAgent({
    slot: 2, id: 's2-sub-test', cwd: '/tmp/fake-sub-test', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'cccccccc-dddd-eeee-ffff-000000000001',
    spawn: makeFakeSpawn(),
  });
  agent.start();
  agent.lastPtyTs = Date.now() - 30000; // suppress working-overlay
  return agent;
}

test('activeSubagents: toJSON reflects the pending map, sorted by start, with elapsed', () => {
  const agent = bootAgent();
  const t0 = Date.now();
  agent.pendingSubagents.set('toolu_b', { label: 'later', type: 'agent', startTs: t0 - 1000 });
  agent.pendingSubagents.set('toolu_a', { label: 'earlier', type: 'Explore', startTs: t0 - 5000 });
  const subs = agent.toJSON().activeSubagents;
  assert.equal(subs.length, 2);
  assert.equal(subs[0].label, 'earlier', 'sorted by startTs ascending');
  assert.equal(subs[0].type, 'Explore');
  assert.ok(subs[0].elapsedMs >= 5000, 'elapsed derived from startTs');
  assert.equal(subs[1].label, 'later');
});

test('activeSubagents: empty map → empty array', () => {
  const agent = bootAgent();
  assert.deepEqual(agent.toJSON().activeSubagents, []);
});

test('STUCK suppressed while a sub-agent is in flight (stale main-thread clock)', () => {
  const agent = bootAgent();
  agent.hookStatus = 'working';
  agent.hookStatusTs = Date.now();
  agent.lastEventTs = Date.now() - 6 * 60000; // 6 min stale → would be STUCK
  // Without fan-out: STUCK accrues.
  assert.ok(agent.toJSON().stuckMin >= 5, 'baseline: stale working session reads STUCK');
  // With fan-out outstanding: STUCK suppressed.
  agent.pendingSubagents.set('toolu_1', { label: 'x', type: 'agent', startTs: Date.now() });
  assert.equal(agent.toJSON().stuckMin, 0, 'active sub-agent suppresses STUCK');
});
