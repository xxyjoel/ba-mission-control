// tests/heapProbe.test.mjs — coverage for the opt-in OOM instrumentation (#18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetCounts, heapSample, startHeapProbe } from '../server/heapProbe.mjs';

// A fake fleet whose agents expose only the fields the probe reads.
function fakeFleet() {
  return {
    agents: [
      { term: { buffer: { active: { length: 120 } } }, pendingSubagents: new Map([['a', 1], ['b', 2]]), _usageByMsg: new Map([['m1', {}]]), tail: [1, 2, 3], usageTailer: { settledCount: () => 5 } },
      null, // empty slot — must be skipped
      { term: { buffer: { active: { length: 80 } } }, pendingSubagents: new Map(), _usageByMsg: new Map([['m2', {}], ['m3', {}]]), tail: [1], usageTailer: { settledCount: () => 3 } },
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
  assert.equal(c.settledSub, 8);    // 5 + 3 (subagent tailer settled Set — 0350/0354 watch)
});

test('fleetCounts never throws on a malformed/half-torn-down fleet', () => {
  assert.doesNotThrow(() => fleetCounts(undefined));
  assert.doesNotThrow(() => fleetCounts({ agents: [{}, { term: null }, { pendingSubagents: null }] }));
  const c = fleetCounts({ agents: [{}] });
  assert.equal(c.agents, 1);
  assert.equal(c.termLines, 0);
  assert.equal(c.settledSub, 0);   // no usageTailer → 0, never throws
});

test('heapSample emits a well-formed record with memory + counts', () => {
  const s = heapSample(fakeFleet(), Date.now() - 120000);
  for (const k of ['rssMB', 'heapMB', 'heapTotalMB', 'extMB', 'abMB', 'agents', 'termLines', 'pendingSub', 'usageByMsg', 'tail', 'settledSub', 't', 'upMin']) {
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

// The watchdog writes real heap snapshots to STATE_DIR, which binds at module load
// from XDG_STATE_HOME. The old tests pointed that at the REAL shared dir and counted
// every `watchdog*` file there — so they saw the real 4.3GB OOM snapshot + leftovers
// from prior failed runs (cleanup was skipped when the assert threw) and self-poisoned
// across runs (RED at HEAD; 0353). Fix: give each test a fresh temp XDG_STATE_HOME and
// load a FRESH heapProbe instance (cache-busting import query) so STATE_DIR resolves
// inside the temp dir. The test never touches — and can never delete — the real dir.
async function withIsolatedHeapDir(fn) {
  const { mkdtempSync, existsSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const saved = process.env.XDG_STATE_HOME;
  const tmp = mkdtempSync(join(tmpdir(), 'mc-heap-test-'));
  process.env.XDG_STATE_HOME = tmp;
  try {
    // Fresh module instance so its module-load STATE_DIR reads the temp path.
    const mod = await import(`../server/heapProbe.mjs?heapTest=${process.pid}-${Date.now()}`);
    const dir = join(tmp, 'claude-mc', 'heap');
    const snapCount = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('watchdog') && f.endsWith('.heapsnapshot')).length : 0);
    await fn({ startHeapProbe: mod.startHeapProbe, snapCount });
  } finally {
    process.env.XDG_STATE_HOME = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('watchdog auto-captures ONE snapshot when heap crosses the threshold', async () => {
  await withIsolatedHeapDir(async ({ startHeapProbe, snapCount }) => {
    // frac ~0 → threshold below current heap → fires immediately; runs even without MC_HEAP_LOG.
    const stop = startHeapProbe({ agents: [] }, { env: {}, watchdogMs: 15, watchdogFrac: 0.00001 });
    await new Promise((r) => setTimeout(r, 130));
    stop();
    assert.equal(snapCount(), 1, 'watchdog captures exactly once (guarded), even across many ticks');
  });
});

test('watchdog does NOT fire under normal heap (high frac)', async () => {
  await withIsolatedHeapDir(async ({ startHeapProbe, snapCount }) => {
    const stop = startHeapProbe({ agents: [] }, { env: {}, watchdogMs: 15, watchdogFrac: 0.99 });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    assert.equal(snapCount(), 0, 'no false-fire when heap is well under the limit');
  });
});
