// tests/cardVerdict.test.mjs — 0487: the card's "jump in?" verdict, every case.
//
// The owner, 2026-11-17: "i need to know when it makes sense to jump into a
// session and continue working." Green means ready for you. Anything running,
// in the turn or in the background, must never read green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { triageVerdict, backgroundRowText, fmtAge } from '../tui/lib/cardVerdict.js';

const V = (o) => triageVerdict(o);
const H = 3_600_000;

test('truth table: status × background work × plan', () => {
  const rows = [
    // [input, action, tone]
    [{ status: 'error' }, 'errored · see log', 'red'],
    [{ status: 'error', jobCount: 2 }, 'errored · see log', 'red'],
    [{ status: 'paused', bgLive: true }, 'paused', 'dim'],
    [{ status: 'waiting' }, 'needs input · answer to continue', 'yellow'],
    [{ status: 'waiting', approval: true }, 'needs approval · answer to proceed', 'red'],
    [{ status: 'waiting', bgLive: true, jobCount: 3 }, 'needs input · answer to continue', 'yellow'],
    [{ status: 'working' }, '', 'dim'],
    [{ status: 'working', todoTotal: 4, todoDone: 1 }, 'check back', 'dim'],
    [{ status: 'working', stuckMin: 12 }, 'take a look →', 'yellow'],
    [{ status: 'working', stuckMin: 12, jobCount: 1 }, 'take a look →', 'yellow'],
    [{ status: 'idle' }, 'your turn →', 'green'],
    [{ status: 'idle', todoTotal: 4, todoDone: 4 }, 'ready to review →', 'green'],
    [{ status: 'idle', todoTotal: 4, todoDone: 2 }, 'needs a nudge →', 'yellow'],
    [{ status: 'idle', bgLive: true }, 'check back', 'dim'],
    [{ status: 'idle', jobCount: 1 }, 'check back', 'dim'],
    [{ status: 'idle', jobCount: 2, todoTotal: 4, todoDone: 4 }, 'check back', 'dim'],
    [{ status: 'idle', bgLive: true, todoTotal: 4, todoDone: 2 }, 'check back', 'dim'],
    [{ status: 'empty' }, '', 'dim'],
    [{ status: undefined }, '', 'dim'],
  ];
  for (const [input, action, tone] of rows) {
    assert.deepEqual(V(input), { action, tone }, JSON.stringify(input));
  }
});

test('nothing that is running ever reads green', () => {
  for (const status of ['working', 'waiting', 'idle', 'paused', 'error']) {
    for (const bgLive of [false, true]) {
      for (const jobCount of [0, 1]) {
        const v = V({ status, bgLive, jobCount, todoTotal: 2, todoDone: 2 });
        const running = status === 'working' || bgLive || jobCount > 0;
        if (running) assert.notEqual(v.tone, 'green', JSON.stringify({ status, bgLive, jobCount }));
      }
    }
  }
});

test('ages: minutes, hours, then days', () => {
  assert.equal(fmtAge(45_000), '45s');
  assert.equal(fmtAge(36 * 60_000), '36m');
  assert.equal(fmtAge(3 * H + 5 * 60_000), '3h05m');
  assert.equal(fmtAge((66 * 60 + 12) * 60_000), '2d18h');
});

test('the ↳ row: counts first, then the oldest age, then names', () => {
  const job = (label, h) => ({ label, elapsedMs: h * H });
  const ag = (label) => ({ label });
  const row = (o) => backgroundRowText(o);
  assert.equal(row({}), '');
  assert.equal(row({ jobs: [job('Sync the sample rows', 0.5)] }), 'job 30m: Sync the sample rows');
  assert.equal(row({ jobs: [job(null, 66.2)] }), '1 job · 2d18h');
  assert.equal(row({ jobs: [job(null, 66.2), job('b', 1)] }), '2 jobs · oldest 2d18h');
  assert.equal(row({ agents: [ag('Review the diff')], agentCount: 1 }), '⋔ Review the diff');
  assert.equal(row({ agents: [ag('a'), ag('b'), ag('c')], agentCount: 3 }), '⋔3 agents running');
  assert.equal(row({ agentCount: null, bgLive: true }), '⋔ background agents running', 'live, count unknown: no invented number');
  assert.equal(row({ agents: [ag('a')], agentCount: 1, jobs: [job('x', 2), job('y', 1)] }), '⋔1 agent · 2 jobs · 2h00m');
  assert.equal(row({ agentCount: null, bgLive: true, jobs: [job('x', 2)] }), '⋔ agents · 1 job · 2h00m');
});
