// tests/agent.reliability.test.mjs — server-side reliability bookkeeping.
//
// Covers the new fields on Agent.toJSON() introduced by #25
// (stuckMin) and the restart timer state introduced by #29
// (restartCount). We do NOT spawn a real claude subprocess; we exercise
// the bookkeeping directly via constructor + manual field mutation,
// because the only behavior under test is the derivation logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../server/agent.mjs';

function makeAgentBare() {
  return new Agent({
    slot: 1,
    cwd: '/tmp',
    branch: 'main',
    model: 'sonnet-4.6',
    name: 'unit',
    permissionMode: 'acceptEdits',
  });
}

test('agent.toJSON.stuckMin: zero when idle (no expected stream)', () => {
  const a = makeAgentBare();
  a.status = 'idle';
  a.lastEventTs = Date.now() - 10 * 60 * 1000; // 10 min silence
  const snap = a.toJSON();
  assert.equal(snap.stuckMin, 0, 'idle slots are intentionally silent');
});

test('agent.toJSON.stuckMin: zero when paused', () => {
  const a = makeAgentBare();
  a.status = 'paused';
  a.lastEventTs = Date.now() - 30 * 60 * 1000;
  const snap = a.toJSON();
  assert.equal(snap.stuckMin, 0, 'paused is explicit user action, not stuck');
});

test('agent.toJSON.stuckMin: zero under 5min while working', () => {
  const a = makeAgentBare();
  a.status = 'working';
  a.lastEventTs = Date.now() - 2 * 60 * 1000;
  const snap = a.toJSON();
  assert.equal(snap.stuckMin, 0, 'under threshold should not flag');
});

test('agent.toJSON.stuckMin: positive when working + silent past 5min', () => {
  const a = makeAgentBare();
  a.status = 'working';
  a.lastEventTs = Date.now() - 6 * 60 * 1000;
  const snap = a.toJSON();
  assert.ok(snap.stuckMin >= 5, `stuckMin should be >= 5, got ${snap.stuckMin}`);
});

test('agent.toJSON.stuckMin: also positive while waiting (permission stall)', () => {
  const a = makeAgentBare();
  a.status = 'waiting';
  a.lastEventTs = Date.now() - 8 * 60 * 1000;
  const snap = a.toJSON();
  assert.ok(snap.stuckMin >= 5, 'waiting slots can stall on permission prompts');
});

test('agent.restartCount: initializes to 0', () => {
  const a = makeAgentBare();
  assert.equal(a.restartCount, 0);
  assert.equal(a.restartTimer, null);
});

test('agent.lastEventTs: initialized at construction time', () => {
  const before = Date.now();
  const a = makeAgentBare();
  const after = Date.now();
  assert.ok(a.lastEventTs >= before && a.lastEventTs <= after,
    `expected lastEventTs in [${before}, ${after}], got ${a.lastEventTs}`);
});

test('agent.toJSON includes lastEventTs and stuckMin fields', () => {
  const a = makeAgentBare();
  const snap = a.toJSON();
  assert.ok('lastEventTs' in snap, 'snapshot must expose lastEventTs');
  assert.ok('stuckMin' in snap, 'snapshot must expose stuckMin');
});

// ─── per-session metrics (#12) ──────────────────────────────────────

test('agent: turnCount / messageCount initialize to 0', () => {
  const a = makeAgentBare();
  assert.equal(a.turnCount, 0);
  assert.equal(a.messageCount, 0);
});

test('agent: spawnedAt / stateSince initialize at construction time', () => {
  const before = Date.now();
  const a = makeAgentBare();
  const after = Date.now();
  assert.ok(a.spawnedAt >= before && a.spawnedAt <= after);
  assert.ok(a.stateSince >= before && a.stateSince <= after);
});

test('agent.stateSince: refreshed on real status transition only', async () => {
  const a = makeAgentBare();
  const t0 = a.stateSince;
  // No-op assignment (same value) must NOT refresh the anchor.
  a.status = 'idle';
  assert.equal(a.stateSince, t0, 'no-op write should not reset stateSince');
  // Real transition refreshes.
  await new Promise(r => setTimeout(r, 5));
  a.status = 'working';
  assert.ok(a.stateSince > t0, 'real transition should advance stateSince');
});

test('agent.toJSON exposes turnCount, messageCount, spawnedAt, stateSince', () => {
  const a = makeAgentBare();
  const snap = a.toJSON();
  assert.ok('turnCount' in snap, 'snapshot must expose turnCount');
  assert.ok('messageCount' in snap, 'snapshot must expose messageCount');
  assert.ok('spawnedAt' in snap, 'snapshot must expose spawnedAt');
  assert.ok('stateSince' in snap, 'snapshot must expose stateSince');
});

