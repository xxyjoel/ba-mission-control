// tests/fleet.sessionPoll.test.mjs — 0463: `claude agents --json` cadence.
//
// Each listing forks the real claude binary (0.10 s CPU, 156 MB peak). It ran
// every 20 s at any fleet size. Now: every 120 s at idle, plus ONE debounced
// refresh when a slot launches, is killed, or its process exits.
//
// The listing and the clock are injected (`listSessions`, `timers`), so no
// claude process runs and no real time passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// launch() must not spawn a real `claude`; MOCK_FIXTURE is read at import time.
process.env.MC_MOCK = 'approval-request';
const { Fleet } = await import('../server/fleet.mjs');

// Manual clock: timers fire in due order as time advances, and the async poll
// callback gets its microtasks drained before the next timer runs.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      pending.set(id, { at: now + Math.max(0, ms), fn, id });
      return { id, unref() { return this; } };
    },
    clearTimeout(h) { if (h) pending.delete(h.id); },
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const t of pending.values()) {
        if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      pending.delete(next.id);
      now = next.at;
      next.fn();
    }
    now = end;
    await flush();
  }
  return { timers, advance, get now() { return now; } };
}

function harness() {
  const clock = fakeClock();
  const calls = [];
  const listSessions = async () => {
    calls.push(clock.now);
    return { background: [] };
  };
  const fleet = new Fleet({ slots: 3, listSessions, timers: clock.timers });
  return { clock, calls, fleet };
}

test('idle fleet lists claude sessions every 120 s, not every 20 s (0463)', async () => {
  const { clock, calls, fleet } = harness();
  try {
    await clock.advance(0);
    assert.equal(calls.length, 1, 'one listing at boot');
    await clock.advance(119_000);
    assert.equal(calls.length, 1, `no listing before 120 s at idle (calls at ${calls.join(', ')} ms)`);
    await clock.advance(1_000);
    assert.equal(calls.length, 2, 'second listing at 120 s');
    await clock.advance(600_000 - 120_000);
    assert.equal(calls.length, 6, `10 min of idle = boot + 5 polls (calls at ${calls.join(', ')} ms)`);
  } finally { fleet.stopPolling(); }
});

test('a launch triggers one debounced refresh, then the 120 s cadence resumes (0463)', async () => {
  const { clock, calls, fleet } = harness();
  try {
    await clock.advance(30_000);
    assert.equal(calls.length, 1);
    fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    fleet.launch({ slot: 2, cwd: '/tmp', model: 'sonnet-4.6', name: 'b' });
    await clock.advance(10_000);
    assert.equal(calls.length, 2, `two launches in a row = one refresh (calls at ${calls.join(', ')} ms)`);
    const refreshAt = calls[1];
    // The refresh restarts the slow timer: next listing 120 s after it.
    await clock.advance(refreshAt + 119_000 - clock.now);
    assert.equal(calls.length, 2, 'no listing before 120 s after the refresh');
    await clock.advance(1_000);
    assert.equal(calls.length, 3);
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('a kill triggers one refresh (0463)', async () => {
  const { clock, calls, fleet } = harness();
  try {
    const a = fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    await clock.advance(30_000);
    const before = calls.length;
    fleet.kill(a.id);
    await clock.advance(10_000);
    assert.equal(calls.length, before + 1, 'kill → one refresh');
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('a slot whose process exits on its own triggers one refresh (0463)', async () => {
  const { clock, calls, fleet } = harness();
  try {
    // Stand-in agent with the surface Fleet reads: a pty that goes away.
    const a = fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    a.pty = { pid: 4242 };
    a.emit('change');
    await clock.advance(30_000);
    const before = calls.length;
    a.emit('change'); // still alive: no refresh
    await clock.advance(10_000);
    assert.equal(calls.length, before, 'a change on a live slot does not refresh');
    a.pty = null;     // the process ended
    a.emit('change');
    a.emit('change');
    await clock.advance(10_000);
    assert.equal(calls.length, before + 1, 'exit → one refresh');
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('a changed listing still emits change; an unchanged one does not', async () => {
  const clock = fakeClock();
  let bg = [];
  const fleet = new Fleet({ slots: 1, timers: clock.timers, listSessions: async () => ({ background: bg }) });
  let changes = 0;
  fleet.on('change', () => changes++);
  try {
    await clock.advance(0);
    assert.equal(changes, 1, 'first answer differs from null');
    await clock.advance(120_000);
    assert.equal(changes, 1, 'same answer → no change');
    bg = [{ id: 'x', status: 'working' }];
    await clock.advance(120_000);
    assert.equal(changes, 2);
    assert.deepEqual(fleet.claudeSessions.background, bg);
  } finally { fleet.stopPolling(); }
});

test('a refresh during a running listing waits for it; stopPolling mid-listing stays stopped (0463)', async () => {
  const clock = fakeClock();
  let running = 0, maxRunning = 0, calls = 0;
  let release = [];
  const listSessions = () => new Promise((res) => {
    calls++; running++; maxRunning = Math.max(maxRunning, running);
    release.push(() => { running--; res({ background: [] }); });
  });
  const fleet = new Fleet({ slots: 2, timers: clock.timers, listSessions });
  try {
    await clock.advance(0);
    assert.equal(calls, 1, 'boot listing in flight');
    fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    await clock.advance(10_000);
    assert.equal(calls, 1, 'refresh waits for the running listing');
    release.shift()();
    await clock.advance(0);
    assert.equal(calls, 2, 'then runs once');
    assert.equal(maxRunning, 1, 'never two listings at once');
    fleet.stopPolling();
    release.shift()();
    await clock.advance(600_000);
    assert.equal(calls, 2, 'no listing after stopPolling');
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

// ── review follow-ups (0463) ─────────────────────────────────────────────────

test('every fleet listing skips the 5 s module cache (0463 review)', async () => {
  // listClaudeSessions caches each answer for 5 s. A refresh that lands inside
  // that window — a slot that exits 3 s after its launch refresh, or the
  // "run again" path that fires right after a listing — would get the stale
  // copy and the next real look would be 120 s away.
  const clock = fakeClock();
  const args = [];
  const fleet = new Fleet({ slots: 2, timers: clock.timers, listSessions: async (opts) => { args.push(opts); return { background: [] }; } });
  try {
    await clock.advance(0);
    fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    await clock.advance(10_000);
    assert.equal(args.length, 2);
    for (const a of args) assert.equal(a?.cacheMs, 0, `fleet listing must pass cacheMs: 0, got ${JSON.stringify(a)}`);
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('a stream-json agent (process kept in .proc) exiting triggers one refresh (0463 review)', async () => {
  // server/agent.mjs (FLEET_USE_PTY=0) holds its process in `this.proc`.
  const { clock, calls, fleet } = harness();
  try {
    const a = fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    a.proc = { pid: 4243 };
    a.emit('change');
    await clock.advance(30_000);
    const before = calls.length;
    a.proc = null;
    a.emit('change');
    await clock.advance(10_000);
    assert.equal(calls.length, before + 1, 'exit of a .proc agent → one refresh');
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('killing a slot that is still stopping refreshes after it stops, not before (0463 review)', async () => {
  // PtyCore agents may live STOP_GRACE_MS (1.5 s) after SIGTERM plus exit
  // time; a listing at +2 s could still show the old process.
  const { clock, calls, fleet } = harness();
  try {
    const a = fleet.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'a' });
    await clock.advance(30_000);
    const before = calls.length;
    a.stopping = true;
    fleet.kill(a.id);
    await clock.advance(10_000);
    assert.equal(calls.length, before, 'no listing while the killed process is still stopping');
    a.emit('stopped');
    await clock.advance(2_000);
    assert.equal(calls.length, before + 1, 'one listing once it has stopped');
  } finally { fleet.killAll(); fleet.stopPolling(); }
});

test('deleting a background session refreshes the fleet list (0463 review)', async () => {
  // App.jsx calls removeSession(); the row must not linger for the 120 s poll.
  const { removeSession } = await import('../server/claudeSessions.mjs');
  const { clock, calls, fleet } = harness();
  try {
    await clock.advance(30_000);
    const before = calls.length;
    const r = await removeSession('deadbeef', { claudeBin: '/usr/bin/true' });
    assert.equal(r.ok, true);
    await clock.advance(2_000);
    assert.equal(calls.length, before + 1, 'claude rm → one refresh');
  } finally { fleet.stopPolling(); }
});

test('a change to attached sessions emits change; a status-only change does not (0463 review)', async () => {
  // `attached` feeds each card's otherSessions count (otherLiveSessionsInRepo
  // reads sessionId + cwd). Comparing only `background` never redrew it.
  const clock = fakeClock();
  let attached = [];
  const fleet = new Fleet({ slots: 1, timers: clock.timers, listSessions: async () => ({ background: [], attached }) });
  let changes = 0;
  fleet.on('change', () => changes++);
  try {
    await clock.advance(0);
    assert.equal(changes, 1);
    attached = [{ sessionId: 's1', cwd: '/r', status: 'idle' }];
    await clock.advance(120_000);
    assert.equal(changes, 2, 'a new attached session → change');
    attached = [{ sessionId: 's1', cwd: '/r', status: 'working' }];
    await clock.advance(120_000);
    assert.equal(changes, 2, 'attached status flicker alone → no change');
  } finally { fleet.stopPolling(); }
});
