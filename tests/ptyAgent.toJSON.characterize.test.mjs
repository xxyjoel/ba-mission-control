// tests/ptyAgent.toJSON.characterize.test.mjs — 0420: pin PtyAgent.toJSON()'s
// status derivation BEFORE it is extracted into server/deriveStatus.mjs
// (0285/0286) and before the PTY plumbing moves to server/ptyCore.mjs.
//
// Characterization, not specification: every expectation here is what the
// code did at b7f8a3b, including the quirks (a hooked AskUserQuestion wait
// still accrues stuckMin; a hooked slot ignores a stored 'paused'). The
// extraction must keep this file green with ZERO edits. A behavior change is
// a separate task with its own reason, not a side effect of a refactor.
//
// The clock is mocked so boundary cases (WORKING_FRESH_MS, the 5-minute stuck
// threshold, BG_SUB_ACTIVE_MS, BG_ABANDON_MS) are exact rather than racy.
// Scanner cases paint a real xterm-headless buffer through the injected PTY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const h = { data: [], exit: [] };
    const pty = {
      pid: 5100 + spawned.length, _bin: bin, _args: args, _opts: opts,
      write() {}, kill() {}, resize() {},
      onData(fn) { h.data.push(fn); return { dispose() {} }; },
      onExit(fn) { h.exit.push(fn); return { dispose() {} }; },
      fireData(s) { for (const fn of h.data) fn(s); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

// Boot an agent on the mocked clock. Every clock the derivation reads starts
// long in the past so a case sets only the signals it is about.
function boot(t) {
  const clock = { now: T0 };
  t.mock.method(Date, 'now', () => clock.now);
  const spawn = makeFakeSpawn();
  const agent = new PtyAgent({
    slot: 4, id: 's4-char', cwd: '/tmp/fake-char-0420', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: '0420c0de-0000-4000-8000-000000000000',
    spawn,
  });
  agent.start();
  t.after(() => { try { agent.kill(); } catch {} });
  agent.lastPtyTs = T0 - 10 * MIN;
  agent.lastEventTs = T0;
  agent.lastConnectorTs = 0;
  agent.lastSubHookTs = 0;
  return { agent, pty: spawn.spawned[0], clock };
}

// Paint rows into the real emulator and wait for xterm's async parse. The
// onData handler stamps lastPtyTs with the mocked clock, so a paint IS fresh
// PTY output at clock.now.
async function paint(agent, pty, rows) {
  let s = '';
  for (let i = 0; i < 20; i++) s += `filler line ${i}\r\n`;
  s += rows.join('\r\n') + '\r\n';
  pty.fireData(s);
  await new Promise((res) => agent.term.write('', res));
}

const APPROVAL = [
  '│ Bash command                          │',
  '│ Do you want to proceed?               │',
  '│ ❯ 1. Yes                              │',
  '│   3. No, and tell Claude what to do   │',
];
const SPINNER = ['✻ Crunching… (esc to interrupt)'];
const COMPOSER = ['╭───────────╮', '│ >         │', '╰───────────╯', '  ? for shortcuts'];

// The status-bearing slice of the snapshot.
function pick(j) {
  return { status: j.status, stuckMin: j.stuckMin, bgCount: j.bgCount, bgStatus: j.bgStatus };
}

// ── shape ─────────────────────────────────────────────────────────────────────

test('toJSON key set and order is pinned', (t) => {
  const { agent } = boot(t);
  assert.deepEqual(Object.keys(agent.toJSON()), [
    'id', 'slot', 'name', 'model', 'resolvedModel', 'branch', 'dirty', 'ahead',
    'behind', 'status', 'activeSubagents', 'context', 'tokensIn',
    'tokensCacheRead', 'tokensOut', 'costSession', 'costWeek', 'spark',
    'procCpu', 'procMemKb', 'lastTokRate', 'activity', 'cwd', 'sessionId',
    'permissionMode', 'workingStartTs', 'spawnedAt', 'sessionStartedAt',
    'claudeVersion', 'stateSince', 'turnCount', 'messageCount', 'lastEventTs',
    'stuckMin', 'bgCount', 'bgStatus', 'costCapUSD', 'capReached',
    'apiErrorCount', 'lastApiErrorTs', 'tail', 'todos',
  ]);
});

test('fresh agent, nothing reported: idle, no stuck, no bg', (t) => {
  const { agent } = boot(t);
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: 0, bgStatus: null });
  assert.deepEqual(agent.toJSON().activeSubagents, []);
});

// ── hooked: waiting ───────────────────────────────────────────────────────────

test('hooked waiting wins over connector working and never accrues stuck', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'working';
  agent.hookStatus = 'waiting';
  agent.hookStatusTs = T0 - 1000;
  agent.lastEventTs = T0 - 30 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 0, bgCount: 0, bgStatus: null });
});

// ── hooked: working + tool-sourced awaitingPrompt ─────────────────────────────

test('hooked working + awaitingPrompt.tool reads waiting — and STILL accrues stuck (quirk)', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'waiting';
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 500;
  agent.awaitingPrompt = { kind: 'single-select', tool: 'AskUserQuestion' };
  agent.awaitingPromptTs = T0 - 10 * MIN;
  agent.lastEventTs = T0 - 10 * MIN;
  // stuckEligible keys off hookStatus==='working' && !approvalWaiting; the ask
  // override does not set approvalWaiting, so a 10-minute wait shows stuck 10.
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 10, bgCount: 0, bgStatus: null });
});

test('hooked working + text-guess awaitingPrompt (no .tool) stays working', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'waiting';
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 500;
  agent.awaitingPrompt = { kind: 'binary' };
  assert.equal(agent.toJSON().status, 'working');
});

// ── hooked: working, approval scrape gated on PTY freshness ───────────────────

test('hooked working + approval on screen while PTY fresh → working (0256 gate)', async (t) => {
  const { agent, pty, clock } = boot(t);
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  await paint(agent, pty, APPROVAL);
  assert.equal(agent.lastPtyTs, T0);
  clock.now = T0 + 2499;
  assert.equal(agent.toJSON().status, 'working', '2499ms after the last byte is still fresh');
});

test('hooked working + approval on screen once PTY settled → waiting, stuck suppressed', async (t) => {
  const { agent, pty, clock } = boot(t);
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  await paint(agent, pty, APPROVAL);
  agent.lastEventTs = T0 - 20 * MIN;
  clock.now = T0 + 2500; // exactly WORKING_FRESH_MS — `<` makes this settled
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('hooked working, no approval on screen, settled PTY → working', async (t) => {
  const { agent, pty, clock } = boot(t);
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  await paint(agent, pty, COMPOSER);
  clock.now = T0 + 10_000;
  assert.equal(agent.toJSON().status, 'working');
});

test('hooked working never uses the working scrape (spinner irrelevant)', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 8000;
  agent.lastConnectorTs = T0 - 1000;
  await paint(agent, pty, COMPOSER);
  assert.equal(agent.toJSON().status, 'working', 'sticky working over a fresher connector idle');
});

test('hooked working with term gone: scan fails closed → working', (t) => {
  const { agent } = boot(t);
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  agent.term = null;
  assert.equal(agent.toJSON().status, 'working');
});

// ── hooked: stuckMin ──────────────────────────────────────────────────────────

test('hooked working stuck threshold: 4m59s → 0, 5m → 5, 12m30s → 12', (t) => {
  const { agent } = boot(t);
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  agent.lastEventTs = T0 - (5 * MIN - 1000);
  assert.equal(agent.toJSON().stuckMin, 0);
  agent.lastEventTs = T0 - 5 * MIN;
  assert.equal(agent.toJSON().stuckMin, 5);
  agent.lastEventTs = T0 - 12.5 * MIN;
  assert.equal(agent.toJSON().stuckMin, 12);
});

test('hooked idle never accrues stuck, even with a stale connector working', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'working';
  agent.hookStatus = 'idle';
  agent.hookStatusTs = T0 - 1000;
  agent.lastConnectorTs = T0 - 5000;
  agent.lastEventTs = T0 - 30 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('hooked idle that loses to a fresher connector working: status working, stuck 0 (hook is not working)', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'working';
  agent.hookStatus = 'idle';
  agent.hookStatusTs = T0 - 10 * MIN;
  agent.lastConnectorTs = T0 - 9 * MIN;
  agent.lastEventTs = T0 - 9 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 0, bgCount: 0, bgStatus: null });
});

// ── hooked: idle vs connector freshness ───────────────────────────────────────

test('hooked idle: hook strictly fresher → idle; tie → connector', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'working';
  agent.hookStatus = 'idle';
  agent.hookStatusTs = T0 - 1000;
  agent.lastConnectorTs = T0 - 1001;
  assert.equal(agent.toJSON().status, 'idle');
  agent.lastConnectorTs = T0 - 1000;
  assert.equal(agent.toJSON().status, 'working', 'equal clocks hand the card to the connector');
});

test('hooked idle losing to connector passes the connector value through verbatim (paused / waiting)', (t) => {
  const { agent } = boot(t);
  agent.hookStatus = 'idle';
  agent.hookStatusTs = T0 - 5000;
  agent.lastConnectorTs = T0 - 1000;
  agent._statusValue = 'paused';
  assert.equal(agent.toJSON().status, 'paused');
  agent._statusValue = 'waiting';
  assert.equal(agent.toJSON().status, 'waiting');
});

test('hooked idle ignores a fresh spinner on screen', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  agent.hookStatus = 'idle';
  agent.hookStatusTs = T0 - 1000;
  await paint(agent, pty, SPINNER);
  assert.equal(agent.toJSON().status, 'idle');
});

test('hooked working ignores a stored paused (quirk: paused only surfaces un-hooked)', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'paused';
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  assert.equal(agent.toJSON().status, 'working');
});

// ── un-hooked: working overlay needs BOTH scan and fresh PTY ─────────────────

test('un-hooked idle + spinner + fresh PTY → working overlay, no stuck', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  await paint(agent, pty, SPINNER);
  agent.lastEventTs = T0 - 30 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('un-hooked idle + spinner + settled PTY → idle', async (t) => {
  const { agent, pty, clock } = boot(t);
  agent._statusValue = 'idle';
  await paint(agent, pty, SPINNER);
  clock.now = T0 + 2500;
  assert.equal(agent.toJSON().status, 'idle');
  clock.now = T0 + 2499;
  assert.equal(agent.toJSON().status, 'working');
});

test('un-hooked idle + fresh PTY, no spinner → idle', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  await paint(agent, pty, COMPOSER);
  assert.equal(agent.toJSON().status, 'idle');
});

test('un-hooked overlay only lifts idle — paused + spinner stays paused', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'paused';
  await paint(agent, pty, SPINNER);
  assert.deepEqual(pick(agent.toJSON()), { status: 'paused', stuckMin: 0, bgCount: 0, bgStatus: null });
});

// ── un-hooked: approval overlay ───────────────────────────────────────────────

test('un-hooked working + approval on screen → waiting with NO freshness gate', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'working';
  await paint(agent, pty, APPROVAL);
  assert.equal(agent.lastPtyTs, T0, 'the PTY is fresh this instant');
  agent.lastEventTs = T0 - 20 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('un-hooked idle + spinner + approval, fresh → overlay working then approval → waiting', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  await paint(agent, pty, [...APPROVAL, ...SPINNER]);
  assert.equal(agent.toJSON().status, 'waiting');
});

test('un-hooked idle + approval, settled → idle (approval overlay needs a working base)', async (t) => {
  const { agent, pty, clock } = boot(t);
  agent._statusValue = 'idle';
  await paint(agent, pty, APPROVAL);
  clock.now = T0 + 5000;
  assert.equal(agent.toJSON().status, 'idle');
});

// ── un-hooked: stuckMin ───────────────────────────────────────────────────────

test('un-hooked stored working accrues stuck; stored waiting does too', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'working';
  agent.lastEventTs = T0 - 7 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 7, bgCount: 0, bgStatus: null });
  agent._statusValue = 'waiting';
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 7, bgCount: 0, bgStatus: null });
});

test('un-hooked idle / paused / error never accrue stuck', (t) => {
  const { agent } = boot(t);
  agent.lastEventTs = T0 - 7 * MIN;
  for (const s of ['idle', 'paused', 'error']) {
    agent._statusValue = s;
    assert.equal(agent.toJSON().stuckMin, 0, s);
  }
});

// ── error ─────────────────────────────────────────────────────────────────────

test('error with no pty wins over every hooked branch', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'error';
  agent.pty = null;
  for (const [hs, extra] of [['idle', {}], ['working', {}], ['waiting', {}],
    ['working', { awaitingPrompt: { tool: 'AskUserQuestion' } }]]) {
    agent.hookStatus = hs;
    agent.hookStatusTs = T0;
    agent.awaitingPrompt = extra.awaitingPrompt ?? null;
    assert.equal(agent.toJSON().status, 'error', `hookStatus=${hs}`);
  }
});

test('error with no pty, hooked working: status error but stuck still accrues off the hook (quirk)', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'error';
  agent.pty = null;
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  agent.lastEventTs = T0 - 8 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'error', stuckMin: 8, bgCount: 0, bgStatus: null });
});

test('error with a live pty: hooked derives normally, un-hooked passes error through', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'error';
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0;
  assert.equal(agent.toJSON().status, 'working');
  agent.hookStatus = null;
  assert.equal(agent.toJSON().status, 'error');
});

test('un-hooked error with no pty and no term → error', (t) => {
  const { agent } = boot(t);
  agent._statusValue = 'error';
  agent.pty = null;
  agent.term = null;
  assert.equal(agent.toJSON().status, 'error');
});

// ── sub-agents: stuck suppression, bgCount, activeSubagents ──────────────────

test('outstanding Task suppresses stuck (hooked and un-hooked) and counts toward bg', (t) => {
  const { agent } = boot(t);
  agent.pendingSubagents.set('toolu_1', { label: 'build', type: 'agent', startTs: T0 - 3 * MIN });
  agent.lastEventTs = T0 - 20 * MIN;
  agent.hookStatus = 'working';
  agent.hookStatusTs = T0 - 1000;
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 0, bgCount: 1, bgStatus: 'working' });
  agent.hookStatus = null;
  agent._statusValue = 'working';
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 0, bgCount: 1, bgStatus: 'working' });
});

test('activeSubagents from the pending map: sorted by startTs, elapsed on the one clock', (t) => {
  const { agent } = boot(t);
  agent.pendingSubagents.set('b', { label: 'later', type: 'agent', startTs: T0 - 1000 });
  agent.pendingSubagents.set('a', { label: 'earlier', type: 'Explore', startTs: T0 - 5000, extra: 'dropped' });
  assert.deepEqual(agent.toJSON().activeSubagents, [
    { label: 'earlier', type: 'Explore', elapsedMs: 5000 },
    { label: 'later', type: 'agent', elapsedMs: 1000 },
  ]);
});

test('abandoned Task (>30min): not counted, still suppresses stuck, still listed, liveAgents not consulted', (t) => {
  const { agent } = boot(t);
  let calls = 0;
  agent.usageTailer = { liveAgents: () => { calls++; return [{ id: 'x', lastGrowTs: T0 }]; }, stop() {}, scan() {} };
  agent.pendingSubagents.set('old', { label: 'ghost', type: 'agent', startTs: T0 - 30 * MIN - 1 });
  agent._statusValue = 'working';
  agent.lastEventTs = T0 - 40 * MIN;
  const j = agent.toJSON();
  assert.deepEqual(pick(j), { status: 'working', stuckMin: 0, bgCount: 0, bgStatus: null });
  assert.deepEqual(j.activeSubagents, [{ label: 'ghost', type: 'agent', elapsedMs: 30 * MIN + 1 }]);
  assert.equal(calls, 0, 'live sub files are read only when the pending map is empty');
});

test('Task exactly at the abandon cutoff still counts', (t) => {
  const { agent } = boot(t);
  agent.pendingSubagents.set('edge', { label: 'edge', type: 'agent', startTs: T0 - 30 * MIN });
  assert.equal(agent.toJSON().bgCount, 1);
});

test('pending entry with no startTs is treated as ts 0 (abandoned)', (t) => {
  const { agent } = boot(t);
  agent.pendingSubagents.set('nots', { label: 'x', type: 'agent' });
  assert.equal(agent.toJSON().bgCount, 0);
});

test('abandoned Task + fresh sub hook → uncounted ?bg', (t) => {
  const { agent } = boot(t);
  agent.pendingSubagents.set('old', { label: 'ghost', type: 'agent', startTs: T0 - 31 * MIN });
  agent.lastSubHookTs = T0 - 1000;
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: null, bgStatus: 'working' });
});

test('live sub-agent files: counted, named, liveAgents called with the bg window and the one clock', (t) => {
  const { agent } = boot(t);
  const seen = [];
  agent.usageTailer = {
    liveAgents: (opts) => { seen.push(opts); return [
      { id: 'abcdef0123456789', lastGrowTs: T0 - 4000 },
      { id: 'fedcba98', lastGrowTs: T0 - 100 },
    ]; },
    stop() {}, scan() {},
  };
  agent.lastSubHookTs = T0 - 1000;
  const j = agent.toJSON();
  assert.deepEqual(pick(j), { status: 'idle', stuckMin: 0, bgCount: 2, bgStatus: 'working' });
  assert.deepEqual(j.activeSubagents, [
    { label: 'agent abcdef01', type: 'agent', elapsedMs: 4000 },
    { label: 'agent fedcba98', type: 'agent', elapsedMs: 100 },
  ]);
  assert.deepEqual(seen, [{ withinMs: 60_000, now: T0 }]);
});

test('live sub-agent files do NOT suppress stuck (only the pending map does)', (t) => {
  const { agent } = boot(t);
  agent.usageTailer = { liveAgents: () => [{ id: 'a1', lastGrowTs: T0 }], stop() {}, scan() {} };
  agent._statusValue = 'working';
  agent.lastEventTs = T0 - 6 * MIN;
  assert.deepEqual(pick(agent.toJSON()), { status: 'working', stuckMin: 6, bgCount: 1, bgStatus: 'working' });
});

test('liveAgents throwing is swallowed → falls through to the hook clock', (t) => {
  const { agent } = boot(t);
  agent.usageTailer = { liveAgents: () => { throw new Error('boom'); }, stop() {}, scan() {} };
  agent.lastSubHookTs = T0 - 59_999;
  const j = agent.toJSON();
  assert.deepEqual(pick(j), { status: 'idle', stuckMin: 0, bgCount: null, bgStatus: 'working' });
  assert.deepEqual(j.activeSubagents, []);
});

test('no usage tailer at all → no live files', (t) => {
  const { agent } = boot(t);
  agent.usageTailer = null;
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('sub hook clock window: 59.999s → ?bg, exactly 60s → nothing', (t) => {
  const { agent } = boot(t);
  agent.lastSubHookTs = T0 - 59_999;
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: null, bgStatus: 'working' });
  agent.lastSubHookTs = T0 - 60_000;
  assert.deepEqual(pick(agent.toJSON()), { status: 'idle', stuckMin: 0, bgCount: 0, bgStatus: null });
});

test('bg never changes the main-thread status (waiting stays waiting)', (t) => {
  const { agent } = boot(t);
  agent.hookStatus = 'waiting';
  agent.hookStatusTs = T0;
  agent.lastSubHookTs = T0 - 10;
  assert.deepEqual(pick(agent.toJSON()), { status: 'waiting', stuckMin: 0, bgCount: null, bgStatus: 'working' });
});

// ── toJSON is a read: it never mutates the stored status ─────────────────────

test('deriving an overlay leaves _statusValue / workingStartTs untouched', async (t) => {
  const { agent, pty } = boot(t);
  agent._statusValue = 'idle';
  agent.workingStartTs = null;
  await paint(agent, pty, SPINNER);
  const before = agent.stateSince;
  assert.equal(agent.toJSON().status, 'working');
  assert.equal(agent._statusValue, 'idle');
  assert.equal(agent.workingStartTs, null);
  assert.equal(agent.stateSince, before);
});
