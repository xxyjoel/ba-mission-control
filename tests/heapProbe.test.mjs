// tests/heapProbe.test.mjs — coverage for the opt-in OOM instrumentation (#18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetCounts, heapSample, startHeapProbe } from '../server/heapProbe.mjs';

// A fake fleet whose agents expose only the fields the probe reads.
function fakeFleet() {
  return {
    agents: [
      { term: { buffer: { active: { length: 120 } } }, pendingSubagents: new Map([['a', 1], ['b', 2]]), _usageByMsg: new Map([['m1', {}]]), tail: [1, 2, 3] },
      null, // empty slot — must be skipped
      { term: { buffer: { active: { length: 80 } } }, pendingSubagents: new Map(), _usageByMsg: new Map([['m2', {}], ['m3', {}]]), tail: [1] },
    ],
  };
}

test('fleetCounts sums per-structure sizes and skips empty slots', () => {
  const c = fleetCounts(fakeFleet());
  assert.equal(c.agents, 2);
  assert.equal(c.termLines, 200);   // 120 + 80
  assert.equal(c.pendingSub, 2);    // 2 + 0
  assert.equal(c.usageByMsg, 3);    // 1 + 2
  assert.equal(c.tail, 4);          // 3 + 1
});

test('fleetCounts never throws on a malformed/half-torn-down fleet', () => {
  assert.doesNotThrow(() => fleetCounts(undefined));
  assert.doesNotThrow(() => fleetCounts({ agents: [{}, { term: null }, { pendingSubagents: null }] }));
  const c = fleetCounts({ agents: [{}] });
  assert.equal(c.agents, 1);
  assert.equal(c.termLines, 0);
});

test('heapSample emits a well-formed record with memory + counts', () => {
  const s = heapSample(fakeFleet(), Date.now() - 120000);
  for (const k of ['rssMB', 'heapMB', 'heapTotalMB', 'extMB', 'abMB', 'agents', 'termLines', 'pendingSub', 'usageByMsg', 'tail', 't', 'upMin']) {
    assert.ok(k in s, `missing key ${k}`);
  }
  assert.equal(typeof s.heapMB, 'number');
  assert.ok(s.upMin >= 1);           // ~2 min of synthetic uptime
  assert.equal(s.termLines, 200);
});

test('startHeapProbe is a no-op (returns a stop fn) without MC_HEAP_LOG', () => {
  const stop = startHeapProbe(fakeFleet(), { env: {} });
  assert.equal(typeof stop, 'function');
  assert.doesNotThrow(() => stop());
});

test('startHeapProbe with MC_HEAP_LOG returns a working stop() that clears the timer', () => {
  const stop = startHeapProbe(fakeFleet(), { env: { MC_HEAP_LOG: '1' }, intervalMs: 999999 });
  assert.equal(typeof stop, 'function');
  assert.doesNotThrow(() => stop());  // clears the interval; test exits cleanly
});
