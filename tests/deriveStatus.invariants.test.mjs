// tests/deriveStatus.invariants.test.mjs — 0295: executable invariants for the
// pure deriveStatus(signals, now) extracted by 0285.
//
// Covers the invariants the CURRENT rules satisfy: purity (same input → same
// output, no clock, no mutation), no latching, terminal states, stuck
// suppression during fan-out, and which detector a branch may consult.
// 0450: the two plan invariants that were test.todo (inv.5 stuck never beside
// waiting, inv.6 paused wins on a hooked slot) now hold and are real tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveStatus, WORKING_FRESH_MS, BG_ABANDON_MS, STUCK_MIN_THRESHOLD,
} from '../server/deriveStatus.mjs';

const NOW = 1_900_000_000_000;
const MIN = 60_000;

// A counting thunk: records how often a detector was consulted.
function thunk(value) {
  const f = (...args) => { f.calls.push(args); if (value instanceof Error) throw value; return value; };
  f.calls = [];
  return f;
}

function sig(over = {}) {
  return {
    hookStatus: null, hookStatusTs: 0,
    connectorStatus: 'idle', lastConnectorTs: 0,
    lastPtyTs: NOW - 10 * MIN, lastEventTs: NOW, lastSubHookTs: 0,
    awaitingPrompt: null, awaitingPromptTs: 0,
    pendingSubagents: new Map(),
    hasPty: true, paused: false, errored: false,
    scanApproval: () => false, scanWorking: () => false, liveSubAgents: () => [],
    ...over,
  };
}

// ── purity ────────────────────────────────────────────────────────────────────

test('same signals + now ⇒ deep-equal output (every branch)', () => {
  const cases = [
    sig(),
    sig({ hookStatus: 'waiting' }),
    sig({ hookStatus: 'working', awaitingPrompt: { tool: 'AskUserQuestion' }, lastEventTs: NOW - 9 * MIN }),
    sig({ hookStatus: 'working', scanApproval: () => true }),
    sig({ hookStatus: 'idle', hookStatusTs: 5, lastConnectorTs: 4 }),
    sig({ connectorStatus: 'idle', lastPtyTs: NOW, scanWorking: () => true }),
    sig({ connectorStatus: 'error', hasPty: false, errored: true }),
    sig({ pendingSubagents: new Map([['a', { label: 'x', type: 'agent', startTs: NOW - 1000 }]]) }),
    sig({ liveSubAgents: () => [{ id: 'abcdefghij', lastGrowTs: NOW - 5 }] }),
  ];
  for (const s of cases) assert.deepEqual(deriveStatus(s, NOW), deriveStatus(s, NOW));
});

test('never reads the wall clock', (t) => {
  t.mock.method(Date, 'now', () => { throw new Error('deriveStatus must not call Date.now()'); });
  deriveStatus(sig({ hookStatus: 'working', lastEventTs: NOW - 9 * MIN }), NOW);
  deriveStatus(sig({ lastSubHookTs: NOW - 5, liveSubAgents: () => [] }), NOW);
});

test('source contains no clock, timer, or I/O', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'deriveStatus.mjs'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  for (const rx of [/Date\.now/, /new Date\(/, /setTimeout|setInterval|setImmediate/, /node:fs|node:child_process|process\./]) {
    assert.doesNotMatch(code, rx);
  }
});

test('does not mutate its input', () => {
  const pending = new Map([['a', { label: 'x', type: 'agent', startTs: NOW - 2000 }]]);
  const s = Object.freeze(sig({ pendingSubagents: pending }));
  const before = JSON.stringify([...pending.entries()]);
  deriveStatus(s, NOW);
  assert.equal(JSON.stringify([...pending.entries()]), before);
});

test('output depends on `now`, not on when it is called', () => {
  const s = sig({ connectorStatus: 'working', lastEventTs: NOW - 7 * MIN });
  assert.equal(deriveStatus(s, NOW).stuckMin, 7);
  assert.equal(deriveStatus(s, NOW + 3 * MIN).stuckMin, 10);
  assert.equal(deriveStatus(s, NOW - 3 * MIN).stuckMin, 0);
});

test('empty / missing signals derive a quiet idle slot', () => {
  const r = deriveStatus({}, NOW);
  assert.equal(r.status, 'idle');
  assert.equal(r.stuckMin, 0);
  assert.equal(r.bgCount, 0);
  assert.equal(r.bgStatus, null);
  assert.deepEqual(r.activeSubagents, []);
  assert.equal(deriveStatus(undefined, NOW).status, 'idle');
});

// ── no latching ───────────────────────────────────────────────────────────────

test('a detector that flips back flips the status back on the next read', () => {
  let onScreen = true;
  const s = sig({ connectorStatus: 'working', scanApproval: () => onScreen });
  assert.equal(deriveStatus(s, NOW).status, 'waiting');
  onScreen = false;
  assert.equal(deriveStatus(s, NOW).status, 'working');
});

test('hook waiting → working releases immediately', () => {
  assert.equal(deriveStatus(sig({ hookStatus: 'waiting' }), NOW).status, 'waiting');
  assert.equal(deriveStatus(sig({ hookStatus: 'working' }), NOW).status, 'working');
});

// ── terminal states ───────────────────────────────────────────────────────────

test('errored with no pty is error regardless of every other signal', () => {
  const variants = [
    {}, { hookStatus: 'idle', hookStatusTs: NOW }, { hookStatus: 'working' },
    { hookStatus: 'waiting' }, { hookStatus: 'working', awaitingPrompt: { tool: 'ExitPlanMode' } },
    { lastPtyTs: NOW, scanWorking: () => true, scanApproval: () => true },
    { lastSubHookTs: NOW },
  ];
  for (const v of variants) {
    const r = deriveStatus(sig({ connectorStatus: 'error', errored: true, hasPty: false, ...v }), NOW);
    assert.equal(r.status, 'error', JSON.stringify(Object.keys(v)));
    assert.equal(r.reason, 'error-no-pty');
  }
});

test('un-hooked paused and error pass through untouched by detectors', () => {
  for (const st of ['paused', 'error']) {
    const r = deriveStatus(sig({
      connectorStatus: st, paused: st === 'paused', errored: st === 'error',
      lastPtyTs: NOW, scanWorking: () => true, scanApproval: () => true,
    }), NOW);
    assert.equal(r.status, st);
    assert.equal(r.stuckMin, 0);
  }
});

// 0450 (was test.todo, 0295 inv.6): a SIGSTOPped slot is paused no matter what
// the hook channel last said. A stopped process reads as a settled PTY, so the
// approval scrape must not flip it either, and it never accrues stuck.
test('0295 inv.6: paused wins on every hooked branch, with no approval scrape and no stuck', () => {
  const stale = NOW - 30 * MIN;
  const cases = [
    { hookStatus: 'working', hookStatusTs: stale },
    { hookStatus: 'working', hookStatusTs: stale, scanApproval: () => true },
    { hookStatus: 'working', hookStatusTs: stale, awaitingPrompt: { kind: 'single-select', tool: 'AskUserQuestion' } },
    { hookStatus: 'waiting', hookStatusTs: stale },
    { hookStatus: 'idle', hookStatusTs: 9, lastConnectorTs: 10 },
    { hookStatus: 'idle', hookStatusTs: 11, lastConnectorTs: 10 },
    { hookStatus: null, scanTrust: () => true },
  ];
  for (const c of cases) {
    const r = deriveStatus(sig({ connectorStatus: 'paused', paused: true, lastEventTs: stale, ...c }), NOW);
    assert.equal(r.status, 'paused', JSON.stringify(c));
    assert.equal(r.reason, 'paused', JSON.stringify(c));
    assert.equal(r.approvalWaiting, false, JSON.stringify(c));
    assert.equal(r.stuckMin, 0, JSON.stringify(c));
  }
});

// ── hook precedence and which detector a branch may consult ───────────────────

test('hook waiting wins with no detector consulted', () => {
  const a = thunk(false), w = thunk(true);
  const r = deriveStatus(sig({ hookStatus: 'waiting', scanApproval: a, scanWorking: w }), NOW);
  assert.equal(r.status, 'waiting');
  assert.equal(r.reason, 'hook-waiting');
  assert.equal(a.calls.length + w.calls.length, 0);
});

test('hooked: the working scrape is never consulted', () => {
  for (const hookStatus of ['idle', 'working', 'waiting']) {
    const w = thunk(true);
    deriveStatus(sig({ hookStatus, lastPtyTs: NOW, scanWorking: w }), NOW);
    assert.equal(w.calls.length, 0, hookStatus);
  }
});

test('hooked working: approval scrape consulted only once the PTY settled', () => {
  const fresh = thunk(true);
  const r1 = deriveStatus(sig({ hookStatus: 'working', lastPtyTs: NOW - (WORKING_FRESH_MS - 1), scanApproval: fresh }), NOW);
  assert.equal(r1.status, 'working');
  assert.equal(fresh.calls.length, 0);
  const settled = thunk(true);
  const r2 = deriveStatus(sig({ hookStatus: 'working', lastPtyTs: NOW - WORKING_FRESH_MS, scanApproval: settled }), NOW);
  assert.equal(r2.status, 'waiting');
  assert.equal(r2.approvalWaiting, true);
  assert.equal(r2.reason, 'hook-working-approval-scrape');
  assert.equal(settled.calls.length, 1);
});

test('hooked idle: buffer content never overrides the hook/connector arbitration', () => {
  const w = thunk(true), a = thunk(true);
  const r = deriveStatus(sig({ hookStatus: 'idle', hookStatusTs: 10, lastConnectorTs: 9, lastPtyTs: NOW, scanWorking: w, scanApproval: a }), NOW);
  assert.equal(r.status, 'idle');
  assert.equal(w.calls.length + a.calls.length, 0);
});

test('hooked idle vs connector: strictly fresher hook → idle, else connector verbatim', () => {
  assert.equal(deriveStatus(sig({ hookStatus: 'idle', hookStatusTs: 10, lastConnectorTs: 9, connectorStatus: 'working' }), NOW).reason, 'hook-idle');
  const tie = deriveStatus(sig({ hookStatus: 'idle', hookStatusTs: 10, lastConnectorTs: 10, connectorStatus: 'working' }), NOW);
  assert.equal(tie.status, 'working');
  assert.equal(tie.reason, 'hook-idle-connector-fresher');
});

test('0384: tool-sourced ask outranks sticky working; a text guess does not', () => {
  assert.equal(deriveStatus(sig({ hookStatus: 'working', awaitingPrompt: { tool: 'AskUserQuestion' } }), NOW).reason, 'hook-tool-prompt');
  assert.equal(deriveStatus(sig({ hookStatus: 'working', awaitingPrompt: { kind: 'binary' } }), NOW).status, 'working');
});

test('un-hooked: working overlay needs idle + fresh PTY + the scrape', () => {
  const on = (o) => deriveStatus(sig({ connectorStatus: 'idle', lastPtyTs: NOW, scanWorking: () => true, ...o }), NOW).status;
  assert.equal(on({}), 'working');
  assert.equal(on({ lastPtyTs: NOW - WORKING_FRESH_MS }), 'idle');
  assert.equal(on({ scanWorking: () => false }), 'idle');
  assert.equal(on({ connectorStatus: 'paused' }), 'paused');
  assert.equal(deriveStatus(sig({ connectorStatus: 'idle', lastPtyTs: NOW, scanWorking: () => true }), NOW).reason, 'connector-working-scrape');
});

test('un-hooked: working scrape is lazy (not consulted unless idle and fresh)', () => {
  const w = thunk(true);
  deriveStatus(sig({ connectorStatus: 'working', lastPtyTs: NOW, scanWorking: w }), NOW);
  deriveStatus(sig({ connectorStatus: 'idle', lastPtyTs: NOW - WORKING_FRESH_MS, scanWorking: w }), NOW);
  assert.equal(w.calls.length, 0);
});

test('un-hooked: approval overlay only on a working base, with no freshness gate', () => {
  const r = deriveStatus(sig({ connectorStatus: 'working', lastPtyTs: NOW, scanApproval: () => true }), NOW);
  assert.equal(r.status, 'waiting');
  assert.equal(r.reason, 'connector-approval-scrape');
  const a = thunk(true);
  assert.equal(deriveStatus(sig({ connectorStatus: 'idle', scanApproval: a }), NOW).status, 'idle');
  assert.equal(a.calls.length, 0);
});

test('a throwing detector fails closed', () => {
  const boom = new Error('term api hiccup');
  assert.equal(deriveStatus(sig({ connectorStatus: 'working', scanApproval: thunk(boom) }), NOW).status, 'working');
  assert.equal(deriveStatus(sig({ connectorStatus: 'idle', lastPtyTs: NOW, scanWorking: thunk(boom) }), NOW).status, 'idle');
  const r = deriveStatus(sig({ liveSubAgents: thunk(boom), lastSubHookTs: NOW - 1 }), NOW);
  assert.equal(r.bgCount, null);
  assert.deepEqual(r.activeSubagents, []);
});

test('missing detectors read as false / []', () => {
  const r = deriveStatus(sig({ connectorStatus: 'working', scanApproval: undefined, scanWorking: undefined, liveSubAgents: undefined }), NOW);
  assert.equal(r.status, 'working');
  assert.equal(r.bgCount, 0);
});

// ── stuck ─────────────────────────────────────────────────────────────────────

test('stuck is never set on idle, and is suppressed during fan-out', () => {
  const stale = NOW - 30 * MIN;
  assert.equal(deriveStatus(sig({ connectorStatus: 'idle', lastEventTs: stale }), NOW).stuckMin, 0);
  assert.equal(deriveStatus(sig({ hookStatus: 'idle', hookStatusTs: 9, lastEventTs: stale }), NOW).stuckMin, 0);
  const pending = new Map([['t', { label: 'b', type: 'agent', startTs: NOW - 45 * MIN }]]);
  for (const o of [{ connectorStatus: 'working' }, { hookStatus: 'working' }]) {
    assert.equal(deriveStatus(sig({ ...o, lastEventTs: stale, pendingSubagents: pending }), NOW).stuckMin, 0);
  }
});

test('stuck is never set while the approval scrape holds waiting', () => {
  const stale = NOW - 30 * MIN;
  assert.equal(deriveStatus(sig({ hookStatus: 'working', scanApproval: () => true, lastEventTs: stale }), NOW).stuckMin, 0);
  assert.equal(deriveStatus(sig({ connectorStatus: 'working', scanApproval: () => true, lastEventTs: stale }), NOW).stuckMin, 0);
});

test('stuck threshold is whole minutes from lastEventTs', () => {
  const at = (ms) => deriveStatus(sig({ connectorStatus: 'working', lastEventTs: NOW - ms }), NOW).stuckMin;
  assert.equal(at(STUCK_MIN_THRESHOLD * MIN - 1), 0);
  assert.equal(at(STUCK_MIN_THRESHOLD * MIN), STUCK_MIN_THRESHOLD);
  assert.equal(at(12.9 * MIN), 12);
});

// 0450 (was test.todo, 0295 inv.5): a card parked on the user is not wedged.
// Sweep every branch that yields 'waiting' with a stale clock.
test('0295 inv.5: stuck never coexists with waiting, on any branch', () => {
  const stale = NOW - 30 * MIN;
  const cases = [
    { hookStatus: 'waiting', hookStatusTs: stale },
    { hookStatus: 'working', hookStatusTs: stale, awaitingPrompt: { kind: 'single-select', tool: 'AskUserQuestion' } },
    { hookStatus: 'working', hookStatusTs: stale, scanApproval: () => true },
    { hookStatus: 'working', hookStatusTs: stale, scanTrust: () => true },
    { connectorStatus: 'waiting' },
    { connectorStatus: 'working', scanApproval: () => true },
    { connectorStatus: 'working', scanTrust: () => true },
  ];
  for (const c of cases) {
    const r = deriveStatus(sig({ lastEventTs: stale, ...c }), NOW);
    assert.equal(r.status, 'waiting', JSON.stringify(c));
    assert.equal(r.stuckMin, 0, JSON.stringify(c));
  }
});

// 0450: the stuck clock is real events only. A hook event counts as one; PTY
// bytes never do (lastPtyTs is not read for stuck).
test('stuck clock: fresh PTY bytes do not reset it; a fresh hook event does', () => {
  const stale = NOW - 30 * MIN;
  const r1 = deriveStatus(sig({ hookStatus: 'working', hookStatusTs: stale, lastEventTs: stale, lastPtyTs: NOW }), NOW);
  assert.equal(r1.stuckMin, 30);
  const r2 = deriveStatus(sig({ hookStatus: 'working', hookStatusTs: NOW - MIN, lastEventTs: stale }), NOW);
  assert.equal(r2.stuckMin, 0);
  const r3 = deriveStatus(sig({ connectorStatus: 'working', lastEventTs: stale, lastPtyTs: NOW }), NOW);
  assert.equal(r3.stuckMin, 30);
  // An absent clock stays "not stuck" (NaN), never a 0-epoch giant.
  const r4 = deriveStatus(sig({ hookStatus: 'working', hookStatusTs: 0, lastEventTs: undefined }), NOW);
  assert.equal(r4.stuckMin, 0);
});

// ── background work ───────────────────────────────────────────────────────────

test('bg never alters status', () => {
  for (const o of [{ lastSubHookTs: NOW }, { liveSubAgents: () => [{ id: 'a', lastGrowTs: NOW }] },
    { pendingSubagents: new Map([['t', { startTs: NOW }]]) }]) {
    assert.equal(deriveStatus(sig({ hookStatus: 'idle', hookStatusTs: 9, ...o }), NOW).status, 'idle');
    assert.equal(deriveStatus(sig({ hookStatus: 'waiting', ...o }), NOW).status, 'waiting');
  }
});

test('bg count precedence: pending map, then live files, then uncounted hook clock', () => {
  const live = thunk([{ id: 'f1', lastGrowTs: NOW - 10 }, { id: 'f2', lastGrowTs: NOW - 20 }]);
  const pending = new Map([['t', { label: 'L', type: 'agent', startTs: NOW - 1000 }]]);
  const r1 = deriveStatus(sig({ pendingSubagents: pending, liveSubAgents: live }), NOW);
  assert.equal(r1.bgCount, 1);
  assert.equal(live.calls.length, 0, 'live files not read while the pending map has entries');
  const r2 = deriveStatus(sig({ liveSubAgents: live }), NOW);
  assert.equal(r2.bgCount, 2);
  assert.deepEqual(live.calls, [[{ withinMs: 60_000, now: NOW }]]);
  assert.equal(deriveStatus(sig({ lastSubHookTs: NOW - 59_999 }), NOW).bgCount, null);
  assert.equal(deriveStatus(sig({ lastSubHookTs: NOW - 60_000 }), NOW).bgCount, 0);
});

test('bgStatus is working iff bgCount is null or positive', () => {
  for (const o of [{}, { lastSubHookTs: NOW }, { liveSubAgents: () => [{ id: 'a', lastGrowTs: NOW }] },
    { pendingSubagents: new Map([['t', { startTs: NOW - BG_ABANDON_MS - 1 }]]) }]) {
    const r = deriveStatus(sig(o), NOW);
    assert.equal(r.bgStatus, (r.bgCount === null || r.bgCount > 0) ? 'working' : null);
  }
});

test('abandon cutoff is inclusive at BG_ABANDON_MS', () => {
  const at = (age) => deriveStatus(sig({ pendingSubagents: new Map([['t', { startTs: NOW - age }]]) }), NOW).bgCount;
  assert.equal(at(BG_ABANDON_MS), 1);
  assert.equal(at(BG_ABANDON_MS + 1), 0);
});
