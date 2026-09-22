// tests/ptyAgent.plumbing.characterize.test.mjs — 0420: pin the PTY plumbing
// PtyAgent exposes today (spawn options, readiness gate, send/write rules,
// pause/resume, exit + restart messages, resize, zoom attach) before it is
// extracted into server/ptyCore.mjs.
//
// Characterization: these are the observable effects at b7f8a3b — argv/opts
// handed to spawn, bytes written to the PTY and on which tick, signals sent,
// tail lines, status. The extraction must keep this file green with ZERO
// edits. Existing files (ptyAgent.lifecycle / osc52 / scrollbackReuse /
// deathPaths) pin the P1/P2/P6/P7/S1/0402 fixes; this file covers the rest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { clampPtyDims } from '../tui/lib/zoomGeometry.js';

const T0 = 1_800_000_000_000;
const SID = '0420beef-0000-4000-8000-000000000000';
const CWD = '/tmp/fake-plumbing-0420';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 6200 + spawned.length, _bin: bin, _args: args, _opts: opts,
      _writes: [], _kills: [], _resizes: [],
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize(c, r) { this._resizes.push([c, r]); },
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireData(s) { for (const fn of [...handlers.data]) fn(s); },
      fireExit({ exitCode = 0, signal = null } = {}) { for (const fn of [...handlers.exit]) fn({ exitCode, signal }); },
      _handlers: handlers,
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

// Mocked timers by default. `realTimers` is for cases that must read the
// emulator buffer: xterm-headless parses writes on its own setTimeout, which a
// mocked clock never fires.
function makeAgent(t, overrides = {}, { realTimers = false } = {}) {
  if (!realTimers) t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: T0 });
  const spawn = makeFakeSpawn();
  const agent = new PtyAgent({
    slot: 6, id: 's6-plumb', cwd: CWD, model: 'sonnet-4.6',
    permissionMode: 'acceptEdits', sessionId: SID, spawn, ...overrides,
  });
  t.after(() => { try { agent.kill(); } catch {} });
  return { agent, spawn };
}

const tailTexts = (agent) => agent.tail.map((l) => `${l.kind}:${l.text}`);
const parse = (agent) => new Promise((res) => agent.term.write('', res));
const nextTick = () => new Promise((res) => setImmediate(res));
function forceReady(agent) {
  clearTimeout(agent.readyTimer);
  agent.readyTimer = null;
  agent.ready = true;
}

// ── spawn ─────────────────────────────────────────────────────────────────────

test('spawn: bin, argv prefix, and PTY options', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  assert.equal(p._bin, process.env.CLAUDE_BIN || 'claude');
  assert.deepEqual(p._args.slice(0, 8), [
    '--session-id', SID, '--model', 'claude-sonnet-4-6',
    '--permission-mode', 'acceptEdits', '--add-dir', CWD,
  ]);
  assert.equal(p._args[8], '--settings');
  assert.equal(p._args.length, 10);
  assert.deepEqual(Object.keys(p._opts), ['name', 'cols', 'rows', 'cwd', 'env']);
  assert.equal(p._opts.name, 'xterm-256color');
  assert.equal(p._opts.cols, 80);
  assert.equal(p._opts.rows, 24);
  assert.equal(p._opts.cwd, CWD);
  assert.deepEqual(p._opts.env, { ...process.env, TERM: 'xterm-256color' });
});

test('spawn: viewport geometry from the constructor, clamped like clampPtyDims', (t) => {
  const { agent, spawn } = makeAgent(t, { cols: 150, rows: 3 });
  agent.start();
  const want = clampPtyDims(150, 3, 80, 24);
  assert.equal(spawn.spawned[0]._opts.cols, want.cols);
  assert.equal(spawn.spawned[0]._opts.rows, want.rows);
  assert.equal(agent.term.cols, want.cols);
  assert.equal(agent.term.rows, want.rows);
});

test('spawn: no cwd → process.cwd(), no --add-dir', (t) => {
  const { agent, spawn } = makeAgent(t, { cwd: undefined });
  agent.start();
  assert.equal(spawn.spawned[0]._opts.cwd, process.cwd());
  assert.equal(spawn.spawned[0]._args.includes('--add-dir'), false);
});

test('start: first tail line announces the spawn; a second start() is refused', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  assert.equal(tailTexts(agent)[0], `sys:spawn pid=6200 model=claude-sonnet-4-6 cwd=${CWD}`);
  agent.start();
  assert.equal(spawn.spawned.length, 1);
  assert.equal(tailTexts(agent).at(-1), 'sys:start ignored — PTY already running');
});

test('start: emits change, builds the emulator with 5000 rows of scrollback', (t) => {
  const { agent } = makeAgent(t);
  let changes = 0;
  agent.on('change', () => changes++);
  agent.start();
  assert.ok(changes >= 1);
  assert.ok(agent.term, 'term built');
  assert.ok(agent.cell, 'null cell captured');
  assert.equal(agent.term.options.scrollback, 5000);
  assert.equal(agent.paused, false);
  assert.equal(agent.ready, false);
  assert.ok(agent.readyTimer);
});

test('onData: stamps both activity clocks', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(1234);
  spawn.spawned[0].fireData('hello from claude\r\n');
  assert.equal(agent.lastEventTs, T0 + 1234);
  assert.equal(agent.lastPtyTs, T0 + 1234);
});

test('onData: feeds the emulator', async (t) => {
  const { agent, spawn } = makeAgent(t, {}, { realTimers: true });
  agent.start();
  spawn.spawned[0].fireData('hello from claude\r\n');
  await parse(agent);
  const line = agent.term.buffer.active.getLine(0).translateToString(true);
  assert.equal(line, 'hello from claude');
});

// ── readiness gate + pending sends ────────────────────────────────────────────

test('readiness: sends queue until exactly 3000ms, then drain in order', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  assert.equal(agent.send('one'), true);
  assert.equal(agent.send('two'), true);
  assert.deepEqual(agent.pendingSends, ['one', 'two']);
  assert.deepEqual(tailTexts(agent).slice(-2), [
    'sys:queued · waiting for PTY ready (1 pending)',
    'sys:queued · waiting for PTY ready (2 pending)',
  ]);
  t.mock.timers.tick(2999);
  assert.deepEqual(p._writes, []);
  assert.equal(agent.ready, false);
  t.mock.timers.tick(1);
  assert.equal(agent.ready, true);
  assert.equal(agent.readyTimer, null);
  assert.deepEqual(p._writes, ['one\r', 'two\r']);
  assert.deepEqual(agent.pendingSends, []);
  assert.ok(tailTexts(agent).includes('sys:PTY ready · draining 2 queued messages'));
});

test('readiness: singular drain message, nothing logged when the queue is empty', (t) => {
  const { agent } = makeAgent(t);
  agent.start();
  agent.send('only');
  t.mock.timers.tick(3000);
  assert.ok(tailTexts(agent).includes('sys:PTY ready · draining 1 queued message'));
  const { agent: b } = { agent: new PtyAgent({ slot: 7, cwd: CWD, sessionId: SID, spawn: makeFakeSpawn() }) };
  t.after(() => b.kill());
  b.start();
  t.mock.timers.tick(3000);
  assert.equal(tailTexts(b).some((s) => s.includes('draining')), false);
});

test('send with no pty (not killed): queues, revives with resume, clears backoff', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: 1 });
  assert.ok(agent.restartTimer);
  agent.send('wake');
  assert.equal(agent.restartTimer, null);
  assert.equal(spawn.spawned.length, 2);
  assert.equal(agent.resuming, false, 'no transcript on disk → falls back to --session-id');
  assert.ok(tailTexts(agent).includes('sys:respawning — queued; will resume session'));
  t.mock.timers.tick(3000);
  assert.deepEqual(spawn.spawned[1]._writes, ['wake\r']);
});

test('send on a killed slot with no pty queues but never respawns', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  agent.kill();
  agent.pty = null;
  assert.equal(agent.send('late'), true);
  assert.equal(spawn.spawned.length, 1);
});

test('cost cap blocks the send with an actionable tail line', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  agent.costCapUSD = 1;
  agent.costSession = 1.5;
  assert.equal(agent.send('hi'), false);
  assert.deepEqual(spawn.spawned[0]._writes, []);
  assert.equal(tailTexts(agent).at(-1), 'err:cost cap reached · $1.50 / $1.00 · raise with :cap 6 <usd>');
});

// ── write rules (#24 / #25) ───────────────────────────────────────────────────

test('write: paste mode off → single `text\\r`, status working, activity + user tail', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  assert.equal(agent.send('hello'), true);
  assert.deepEqual(spawn.spawned[0]._writes, ['hello\r']);
  assert.equal(agent.status, 'working');
  assert.equal(agent.workingStartTs, T0 + 3000);
  assert.equal(agent.activity, '▸ sending: hello');
  assert.equal(tailTexts(agent).at(-1), 'user:hello');
});

test('write: activity truncates to 120 chars', (t) => {
  const { agent } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  agent.send('x'.repeat(200));
  assert.equal(agent.activity, '▸ sending: ' + 'x'.repeat(120));
});

test('write: bracketed paste on → wrapped paste, CR on the NEXT tick', async (t) => {
  const { agent, spawn } = makeAgent(t, {}, { realTimers: true });
  agent.start();
  const p = spawn.spawned[0];
  p.fireData('\x1b[?2004h');
  await parse(agent);
  assert.equal(agent.term.modes.bracketedPasteMode, true);
  forceReady(agent);
  agent.send('hi\nthere');
  assert.deepEqual(p._writes, ['\x1b[200~hi\nthere\x1b[201~']);
  await nextTick();
  assert.deepEqual(p._writes, ['\x1b[200~hi\nthere\x1b[201~', '\r']);
});

test('write: slash command raw even with paste on, CR on the next tick', async (t) => {
  const { agent, spawn } = makeAgent(t, {}, { realTimers: true });
  agent.start();
  const p = spawn.spawned[0];
  p.fireData('\x1b[?2004h');
  await parse(agent);
  forceReady(agent);
  agent.send('/clear');
  assert.deepEqual(p._writes, ['/clear']);
  await nextTick();
  assert.deepEqual(p._writes, ['/clear', '\r']);
});

test('write: slash command with paste off also defers the CR', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  agent.send('  /compact');
  assert.deepEqual(spawn.spawned[0]._writes, ['  /compact']);
  t.mock.timers.runAll();
  assert.deepEqual(spawn.spawned[0]._writes, ['  /compact', '\r']);
});

test('write: deferred CR is dropped when the agent is killed in between', async (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  agent.send('/clear');
  agent.kill();
  t.mock.timers.runAll();
  assert.deepEqual(spawn.spawned[0]._writes, ['/clear']);
});

test('write: a throwing pty.write returns false with an err tail', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  spawn.spawned[0].write = () => { throw new Error('EIO'); };
  assert.equal(agent.send('x'), false);
  assert.equal(tailTexts(agent).at(-1), 'err:pty write failed: EIO');
});

test('approve() sends the fixed continuation text', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(3000);
  agent.approve();
  assert.deepEqual(spawn.spawned[0]._writes, ['yes, please continue with the proposed action\r']);
});

// ── pause / resume ────────────────────────────────────────────────────────────

test('pause / resume: signals, status, tail; no pty → false', (t) => {
  const { agent, spawn } = makeAgent(t);
  assert.equal(agent.pause(), false);
  assert.equal(agent.resume(), false);
  agent.start();
  assert.equal(agent.pause(), true);
  assert.equal(agent.paused, true);
  assert.equal(agent.status, 'paused');
  assert.equal(agent.resume(), true);
  assert.equal(agent.paused, false);
  assert.equal(agent.status, 'working');
  assert.deepEqual(spawn.spawned[0]._kills, ['SIGSTOP', 'SIGCONT']);
  assert.deepEqual(tailTexts(agent).slice(-2), ['sys:SIGSTOP — process frozen', 'sys:SIGCONT — process resumed']);
});

test('pause / resume: a throwing kill reports and returns false', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].kill = () => { throw new Error('ESRCH'); };
  assert.equal(agent.pause(), false);
  assert.equal(tailTexts(agent).at(-1), 'err:pause failed: ESRCH');
  assert.equal(agent.resume(), false);
  assert.equal(tailTexts(agent).at(-1), 'err:resume failed: ESRCH');
});

// ── kill / hardKill ───────────────────────────────────────────────────────────

test('kill: clears timers, stops tailers, disposes subs + term, SIGTERMs', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  agent.kill();
  assert.equal(agent.killed, true);
  assert.equal(agent.readyTimer, null);
  assert.equal(agent.tailer, null);
  assert.equal(agent.statusTailer, null);
  assert.equal(agent.usageTailer, null);
  assert.equal(agent.term, null);
  assert.equal(agent.cell, null);
  assert.equal(p._handlers.data.size, 0);
  assert.equal(p._handlers.exit.size, 0);
  assert.deepEqual(p._kills, ['SIGTERM']);
  assert.equal(agent.pty, p, 'kill() leaves pty set; the exit callback would null it');
  agent.hardKill();
  assert.deepEqual(p._kills, ['SIGTERM', 'SIGKILL']);
});

test('hardKill with no pty is a no-op', (t) => {
  const { agent } = makeAgent(t);
  agent.hardKill();
});

// ── exit paths ────────────────────────────────────────────────────────────────

test('exit code 0: session ended, status error, tailers stopped, ready timer cleared', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: 0 });
  assert.equal(agent.pty, null);
  assert.equal(agent.tailer, null);
  assert.equal(agent.readyTimer, null);
  assert.ok(agent.term, 'term survives exit');
  assert.equal(agent.status, 'error');
  assert.deepEqual(tailTexts(agent).slice(-2), [
    'sys:process exited code=0 signal=',
    'err:session ended — K clears the slot',
  ]);
});

test('exit by signal (code 0, signal 9): session ended names the signal', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: 0, signal: 9 });
  assert.equal(tailTexts(agent).at(-1), 'err:session ended (signal 9) — K clears the slot');
});

test('exit with SIGSTOP / SIGCONT signal names: state torn down, no message, no restart', (t) => {
  for (const sig of ['SIGSTOP', 'SIGCONT']) {
    const spawn = makeFakeSpawn();
    const agent = new PtyAgent({ slot: 6, cwd: CWD, sessionId: SID, spawn });
    agent.start();
    const before = agent.tail.length;
    spawn.spawned[0].fireExit({ exitCode: 1, signal: sig });
    assert.equal(agent.pty, null);
    assert.equal(agent.tail.length, before, sig);
    assert.equal(agent.restartTimer, null, sig);
    agent.kill();
  }
});

test('exit after kill(): silent', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  const h = [...p._handlers.exit][0];
  agent.kill();
  const before = agent.tail.length;
  h({ exitCode: 1, signal: null });
  assert.equal(agent.tail.length, before);
  assert.equal(agent.restartTimer, null);
});

test('transient exits: 2s / 5s / 15s backoff, --resume flag set, then exhausted', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const delays = [2000, 5000, 15000];
  for (let i = 0; i < 3; i++) {
    spawn.spawned[i].fireExit({ exitCode: 1 });
    assert.equal(agent.status, 'working');
    assert.equal(agent.restartCount, i + 1);
    assert.equal(tailTexts(agent).at(-1), `sys:auto-restart ${i + 1}/3 in ${delays[i] / 1000}s`);
    t.mock.timers.tick(delays[i] - 1);
    assert.equal(spawn.spawned.length, i + 1);
    t.mock.timers.tick(1);
    assert.equal(spawn.spawned.length, i + 2);
    assert.equal(agent.restartTimer, null);
  }
  spawn.spawned[3].fireExit({ exitCode: 1 });
  assert.equal(agent.status, 'error');
  assert.equal(tailTexts(agent).at(-1), 'err:auto-restart exhausted (3 attempts) — leaving slot errored · K clears');
});

test('restart timer firing after kill() does not spawn', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: 1 });
  const timer = agent.restartTimer;
  assert.ok(timer);
  agent.killed = true; // killed without clearing the timer (kill() would clear it)
  t.mock.timers.tick(2000);
  assert.equal(spawn.spawned.length, 1);
});

test('exit with code null: not transient → session ended', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: null });
  assert.equal(agent.status, 'error');
  assert.equal(agent.restartTimer, null);
});

test('held-by-agent refusal within the spawn window: error, no restart, remediation text', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  p.fireData('Error: session is held by a background agent\r\n');
  t.mock.timers.tick(1000);
  p.fireExit({ exitCode: 1 });
  assert.equal(agent.status, 'error');
  assert.equal(agent.restartTimer, null);
  assert.equal(agent.activity, 'held by a background agent — not retrying');
  assert.match(tailTexts(agent).at(-1), /^err:session is held by a claude background agent — /);
  assert.match(tailTexts(agent).at(-1), /then :resume this slot$/);
});

test('the refusal phrase after the 20s window is a normal transient crash', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  p.fireData('Error: session is held by a background agent\r\n');
  t.mock.timers.tick(20_001);
  p.fireExit({ exitCode: 1 });
  assert.ok(agent.restartTimer);
  assert.equal(agent.status, 'working');
});

test('spawn probe buffer caps near 4096 chars and resets on respawn', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const p = spawn.spawned[0];
  p.fireData('a'.repeat(4000));
  p.fireData('b'.repeat(200));
  p.fireData('c'.repeat(200));
  assert.equal(agent._spawnProbeBuf.length, 4200);
  assert.equal(agent._spawnTs, T0);
  p.fireExit({ exitCode: 1 });
  t.mock.timers.tick(2000);
  assert.equal(agent._spawnProbeBuf, '');
  assert.equal(agent._spawnTs, T0 + 2000);
});

// ── teardown-for-restart (changeModel / changePermissionMode) ────────────────

test('changePermissionMode: same mode no-op; else tail, SIGTERM old, respawn, seam marker', async (t) => {
  const { agent, spawn } = makeAgent(t, {}, { realTimers: true });
  agent.start();
  assert.equal(agent.changePermissionMode('acceptEdits'), false);
  assert.equal(agent.changePermissionMode(''), false);
  const term = agent.term;
  assert.equal(agent.changePermissionMode('plan'), true);
  assert.equal(spawn.spawned.length, 2);
  assert.deepEqual(spawn.spawned[0]._kills, ['SIGTERM']);
  assert.equal(agent.killed, false);
  assert.equal(agent.term, term, 'emulator reused');
  assert.ok(tailTexts(agent).includes('sys:permission: plan'));
  assert.ok(spawn.spawned[1]._args.includes('plan'));
  await parse(agent);
  let found = false;
  const buf = agent.term.buffer.active;
  for (let y = 0; y < buf.length; y++) if (buf.getLine(y)?.translateToString(true).includes('── session restarted ──')) found = true;
  assert.ok(found, 'restart seam marker written');
});

test('changeModel: tail names old → new, nulls resolvedModel', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  agent.resolvedModel = 'claude-sonnet-4-6';
  assert.equal(agent.changeModel('sonnet-4.6'), false);
  assert.equal(agent.changeModel('haiku-4.5'), true);
  assert.equal(agent.resolvedModel, null);
  assert.ok(tailTexts(agent).includes('sys:model: sonnet-4.6 → haiku-4.5'));
  assert.equal(spawn.spawned.length, 2);
});

test('teardown clears the ready timer of the old process and re-arms for the new', (t) => {
  const { agent } = makeAgent(t);
  agent.start();
  const oldTimer = agent.readyTimer;
  agent.changePermissionMode('plan');
  assert.notEqual(agent.readyTimer, oldTimer);
  assert.equal(agent.ready, false);
  t.mock.timers.tick(3000);
  assert.equal(agent.ready, true);
});

// ── resize ────────────────────────────────────────────────────────────────────

test('resize: unchanged → false; changed → pty + term resized, true; clamps', (t) => {
  const { agent, spawn } = makeAgent(t);
  assert.equal(agent.resize(80, 24), false);
  assert.equal(agent.resize(100, 30), true, 'resize before start just records dims');
  agent.start();
  assert.equal(spawn.spawned[0]._opts.cols, 100);
  assert.equal(agent.resize(120, 40), true);
  assert.deepEqual(spawn.spawned[0]._resizes, [[120, 40]]);
  assert.equal(agent.term.cols, 120);
  assert.equal(agent.term.rows, 40);
  const want = clampPtyDims(1, 1, 80, 24);
  agent.resize(1, 1);
  assert.equal(agent.cols, want.cols);
  assert.equal(agent.rows, want.rows);
});

// ── attachZoomView ────────────────────────────────────────────────────────────

test('attachZoomView: shape, zoomAttached toggles, dispose idempotent, no resize', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  const v = agent.attachZoomView({ cols: 200, rows: 60 });
  assert.deepEqual(Object.keys(v), ['pty', 'term', 'cell', 'sessionId', 'dispose']);
  assert.equal(v.pty, spawn.spawned[0]);
  assert.equal(v.term, agent.term);
  assert.equal(v.cell, agent.cell);
  assert.equal(v.sessionId, SID);
  assert.equal(agent.zoomAttached, true);
  assert.deepEqual(spawn.spawned[0]._resizes, []);
  v.dispose();
  assert.equal(agent.zoomAttached, false);
  agent.zoomAttached = true;
  v.dispose();
  assert.equal(agent.zoomAttached, true, 'second dispose is a no-op');
});

test('attachZoomView: killed with no pty throws; backoff window revives once', (t) => {
  const { agent, spawn } = makeAgent(t);
  agent.start();
  spawn.spawned[0].fireExit({ exitCode: 1 });
  assert.ok(agent.restartTimer);
  const v = agent.attachZoomView();
  assert.equal(agent.restartTimer, null);
  assert.equal(spawn.spawned.length, 2);
  assert.equal(v.pty, spawn.spawned[1]);
  t.mock.timers.tick(20_000);
  assert.equal(spawn.spawned.length, 2, 'cancelled backoff never fires');
  agent.kill();
  agent.pty = null;
  assert.throws(() => agent.attachZoomView(), /attachZoomView: agent\.pty not running/);
});

// ── misc surface that stays on the agent ─────────────────────────────────────

test('markUserSubmitted flips working and bumps lastEventTs', (t) => {
  const { agent } = makeAgent(t);
  agent.start();
  t.mock.timers.tick(500);
  agent.markUserSubmitted();
  assert.equal(agent.status, 'working');
  assert.equal(agent.lastEventTs, T0 + 500);
});

test('addNote trims, rejects blanks', (t) => {
  const { agent } = makeAgent(t);
  assert.equal(agent.addNote('   '), false);
  assert.equal(agent.addNote('  hi  '), true);
  assert.equal(tailTexts(agent).at(-1), 'note:hi');
});

test('status setter: stateSince on every change, workingStartTs anchored once', (t) => {
  const { agent } = makeAgent(t);
  t.mock.timers.tick(10);
  agent.status = 'working';
  assert.equal(agent.workingStartTs, T0 + 10);
  assert.equal(agent.stateSince, T0 + 10);
  t.mock.timers.tick(10);
  agent.status = 'working';
  assert.equal(agent.stateSince, T0 + 10, 'no-op set leaves the anchor');
  agent.status = 'waiting';
  assert.equal(agent.workingStartTs, null);
  assert.equal(agent.stateSince, T0 + 20);
  agent._statusValue = undefined;
  assert.equal(agent.status, 'idle', 'unset reads idle');
});
