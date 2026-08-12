// tests/deriveStatus.test.mjs — 0293: pure base-status derivation.
//
// The rule under test: THE NEWEST SIGNAL WINS, symmetrically, across the
// hook feed and the JSONL connector. Plus the BLIND state for zero-signal
// sessions. Each root-cause case is named for its live specimen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBaseStatus, WORKING_IDLE_GRACE_MS } from '../server/deriveStatus.mjs';

const T0 = 1_000_000;

function d(overrides, now = T0 + 10 * 60_000) {
  // Default `now` is 10 minutes past T0 so second-scale fixtures are all
  // comfortably beyond the idle-grace window unless a test says otherwise.
  return deriveBaseStatus({
    hookStatus: null,
    hookStatusTs: 0,
    connectorStatus: 'idle',
    lastConnectorTs: 0,
    approvalScan: false,
    workingScan: false,
    ...overrides,
  }, now);
}

// ── RC1b: sticky WORKING after a dropped Stop ──────────────────────────────
// Live specimen 2026-08-12: gtm-gov-miner card read WORKING 31.9 min after
// its transcript's turn_duration. Hook feed ended on PreToolUse (no Stop).

test('dropped Stop: newer connector idle beats stale hook working', () => {
  const r = d({
    hookStatus: 'working', hookStatusTs: T0,          // PreToolUse, long ago
    connectorStatus: 'idle', lastConnectorTs: T0 + 120_000, // turn_duration later
  });
  assert.equal(r.status, 'idle');
  assert.equal(r.signalHealth, 'hooked');
});

test('intra-turn end_turn flash: young connector idle does NOT defeat hook working (0250/0253 preserved)', () => {
  const now = T0 + 9_000;
  const r = d({
    hookStatus: 'working', hookStatusTs: T0,           // PreToolUse 9s ago
    connectorStatus: 'idle', lastConnectorTs: T0 + 8_000, // idle flashed 1s ago
  }, now);
  assert.equal(r.status, 'working',
    'the mid-turn idle flash must ride the grace window');
});

test('genuinely outstanding tool: hook working newer than last JSONL event stays working', () => {
  const r = d({
    hookStatus: 'working', hookStatusTs: T0 + 5_000,  // PreToolUse just fired
    connectorStatus: 'idle', lastConnectorTs: T0,     // JSONL quiet during tool
  });
  assert.equal(r.status, 'working');
});

// ── RC1: sticky WAITING over live streaming work ───────────────────────────

test('stale waiting yields to newer connector working (post-approval text turn)', () => {
  const r = d({
    hookStatus: 'waiting', hookStatusTs: T0,               // permission_prompt, answered
    connectorStatus: 'working', lastConnectorTs: T0 + 30_000, // streaming resumed
  });
  assert.equal(r.status, 'working');
});

test('fresh waiting still wins while the box is actually up', () => {
  const r = d({
    hookStatus: 'waiting', hookStatusTs: T0 + 10_000,
    connectorStatus: 'working', lastConnectorTs: T0,
  });
  assert.equal(r.status, 'waiting');
});

// ── the pre-existing idle arbitration keeps its exact semantics ────────────

test('fresh Stop beats older connector working (0248 behavior preserved)', () => {
  const r = d({
    hookStatus: 'idle', hookStatusTs: T0 + 1_000,
    connectorStatus: 'working', lastConnectorTs: T0,
  });
  assert.equal(r.status, 'idle');
});

test('text-only turn: newer connector working beats older Stop (0248 behavior preserved)', () => {
  const r = d({
    hookStatus: 'idle', hookStatusTs: T0,
    connectorStatus: 'working', lastConnectorTs: T0 + 1_000,
  });
  assert.equal(r.status, 'working');
});

test('tie goes to the hook (lifecycle fact over inference)', () => {
  const r = d({
    hookStatus: 'idle', hookStatusTs: T0,
    connectorStatus: 'working', lastConnectorTs: T0,
  });
  assert.equal(r.status, 'idle');
});

// ── approval fast-path survives arbitration ────────────────────────────────

test('approval scan flips a winning working to waiting', () => {
  const r = d({
    hookStatus: 'working', hookStatusTs: T0 + 5_000,
    connectorStatus: 'idle', lastConnectorTs: T0,
    approvalScan: true,
  });
  assert.equal(r.status, 'waiting');
  assert.equal(r.approvalWaiting, true);
});

test('approval scan does NOT fire when the winning signal is not working', () => {
  const r = d({
    hookStatus: 'working', hookStatusTs: T0,
    connectorStatus: 'idle', lastConnectorTs: T0 + 5_000, // idle wins
    approvalScan: true,
  });
  assert.equal(r.status, 'idle');
  assert.equal(r.approvalWaiting, false);
});

// ── BLIND: zero signals must be visible, not guessed over ──────────────────
// Live specimen 2026-08-12: gtm-gov-miner session with no status ndjson and
// no transcript match — mining hard, card confidently said idle.

test('no hook feed + no transcript ever = blind', () => {
  const r = d({});
  assert.equal(r.signalHealth, 'blind');
  assert.equal(r.status, 'idle'); // value kept for sorting; health carries truth
});

test('blind is metadata, not a scraper bypass: PTY overlay still works', () => {
  // A blind session (both feeds dark) whose terminal shows the working hint
  // with fresh bytes must still read working — and an approval box must
  // still flip it to waiting. This is how an otherwise invisible session
  // stays honest. (Regression guard for the first cut of this fn, which
  // short-circuited before the scrapers and broke approvalPrompt tests.)
  const working = d({ workingScan: true });
  assert.equal(working.status, 'working');
  assert.equal(working.signalHealth, 'blind');
  const blocked = d({ connectorStatus: 'working', approvalScan: true });
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.approvalWaiting, true);
});

test('connector attached but no hooks = unhooked, not blind', () => {
  const r = d({ connectorStatus: 'working', lastConnectorTs: T0 });
  assert.equal(r.signalHealth, 'unhooked');
  assert.equal(r.status, 'working');
});

// ── un-hooked fallback keeps the 0180/0198 overlay semantics ───────────────

test('unhooked: working overlay bridges the turn-boundary idle window', () => {
  const r = d({
    connectorStatus: 'idle', lastConnectorTs: T0, workingScan: true,
  });
  assert.equal(r.status, 'working');
  assert.equal(r.signalHealth, 'unhooked');
});

test('unhooked: approval scan flips working to waiting', () => {
  const r = d({
    connectorStatus: 'working', lastConnectorTs: T0, approvalScan: true,
  });
  assert.equal(r.status, 'waiting');
  assert.equal(r.approvalWaiting, true);
});

test('unhooked: paused/error pass through untouched', () => {
  assert.equal(d({ connectorStatus: 'paused', lastConnectorTs: T0 }).status, 'paused');
  assert.equal(d({ connectorStatus: 'error', lastConnectorTs: T0 }).status, 'error');
});

// ── hooked paused/error from the connector still surface when newer ────────

test('hooked: newer connector error beats older hook working', () => {
  const r = d({
    hookStatus: 'working', hookStatusTs: T0,
    connectorStatus: 'error', lastConnectorTs: T0 + 1_000,
  });
  assert.equal(r.status, 'error');
});
