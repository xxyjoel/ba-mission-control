// tests/ptyCore.contract.test.mjs — 0420: the PtyCore provider contract.
//
// PtyAgent's own behavior is pinned by the ptyAgent.* files; this file drives
// PtyCore through a minimal NON-claude provider so the seam a CursorAgent
// will use is tested on its own: required hooks, hook call order, the env
// override, early-exit short-circuit, and the scrape-based readiness path
// (PtyAgent only uses the fixed timer).

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyCore, pasteForSubmit, bottomContentRows, childEnv } from '../server/ptyCore.mjs';
import * as agentMod from '../server/ptyAgent.mjs';

const T0 = 1_700_000_000_000;

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 8800 + spawned.length, _bin: bin, _args: args, _opts: opts, _writes: [], _kills: [],
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize() {},
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireExit({ exitCode = 0, signal = null } = {}) { for (const fn of [...handlers.exit]) fn({ exitCode, signal }); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

class ToyProvider extends PtyCore {
  constructor({ readiness, env, earlyExit = false, ...rest } = {}) {
    super(rest);
    this.slot = 9;
    this.cwd = '/tmp/toy-provider';
    this.sessionId = 'toy-chat-1';
    this.tail = [];
    this.calls = [];
    this._readiness = readiness;
    this._env = env;
    this._earlyExit = earlyExit;
  }
  buildSpawn() {
    this.calls.push('buildSpawn');
    return { bin: 'toy-cli', args: ['--resume', this.sessionId], ...(this._env ? { env: this._env } : {}) };
  }
  onSpawned(spec) { this.calls.push(`onSpawned:${spec.bin}:${this.pty.pid}`); }
  startSidecars() { this.calls.push('startSidecars'); }
  stopSidecars() { this.calls.push('stopSidecars'); }
  handleEarlyExit(code) { this.calls.push(`handleEarlyExit:${code}`); return this._earlyExit; }
  readiness() { this.calls.push('readiness'); return this._readiness; }
  afterStart() { this.calls.push('afterStart'); }
  appendTail(ln) { this.tail.push(ln); }
}

function toy(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: T0 });
  const spawn = makeFakeSpawn();
  const p = new ToyProvider({ spawn, readiness: { delayMs: 100 }, ...opts });
  t.after(() => { try { p.kill(); } catch {} });
  return { p, spawn };
}

test('ptyAgent re-exports the moved helpers (same functions)', () => {
  assert.equal(agentMod.pasteForSubmit, pasteForSubmit);
  assert.equal(agentMod.bottomContentRows, bottomContentRows);
});

test('a provider missing a required hook fails loudly', () => {
  const bare = new PtyCore({ spawn: makeFakeSpawn() });
  assert.throws(() => bare.buildSpawn(), /buildSpawn/);
  assert.throws(() => bare.appendTail({}), /appendTail/);
  assert.throws(() => bare.readiness(), /readiness/);
  assert.throws(() => bare.start(), /buildSpawn/);
});

test('start(): hook order and argv handed to spawn', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  assert.deepEqual(p.calls, ['buildSpawn', 'onSpawned:toy-cli:8800', 'startSidecars', 'readiness', 'afterStart']);
  assert.equal(spawn.spawned[0]._bin, 'toy-cli');
  assert.deepEqual(spawn.spawned[0]._args, ['--resume', 'toy-chat-1']);
  // 0469: the default env is process.env minus claude's session markers.
  assert.deepEqual(spawn.spawned[0]._opts.env, childEnv());
});

test('buildSpawn env replaces the default env', (t) => {
  const env = { PATH: '/usr/bin', TERM: 'xterm-256color', MC_SLOT_TOKEN: 'x' };
  const { p, spawn } = toy(t, { env });
  p.start();
  assert.equal(spawn.spawned[0]._opts.env, env);
});

test('fixed-delay readiness drains the queue at delayMs', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  p.send('hi');
  t.mock.timers.tick(99);
  assert.deepEqual(spawn.spawned[0]._writes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(spawn.spawned[0]._writes, ['hi\r']);
});

test('predicate readiness: polls until true, then drains; a throw reads as not ready', (t) => {
  let answer = false;
  let polls = 0;
  const predicate = (core) => {
    polls++;
    assert.ok(core instanceof ToyProvider, 'predicate receives the agent');
    if (polls === 2) throw new Error('term not built');
    return answer;
  };
  const { p, spawn } = toy(t, { readiness: { predicate, pollMs: 50 } });
  p.start();
  p.send('first prompt');
  t.mock.timers.tick(49);
  assert.equal(polls, 0);
  t.mock.timers.tick(1);
  assert.equal(polls, 1);
  t.mock.timers.tick(50);
  assert.equal(polls, 2, 'throwing poll');
  assert.equal(p.ready, false);
  t.mock.timers.tick(500);
  assert.equal(p.ready, false, 'a dialog on screen keeps the gate shut indefinitely');
  assert.deepEqual(spawn.spawned[0]._writes, []);
  answer = true;
  t.mock.timers.tick(50);
  assert.equal(p.ready, true);
  assert.equal(p.readyTimer, null);
  assert.deepEqual(spawn.spawned[0]._writes, ['first prompt\r']);
  const n = polls;
  t.mock.timers.tick(1000);
  assert.equal(polls, n, 'polling stops once ready');
});

test('predicate readiness: default poll interval is 250ms', (t) => {
  let polls = 0;
  const { p } = toy(t, { readiness: { predicate: () => { polls++; return false; } } });
  p.start();
  t.mock.timers.tick(249);
  assert.equal(polls, 0);
  t.mock.timers.tick(1);
  assert.equal(polls, 1);
});

test('predicate polling stops on kill, exit and restart teardown', (t) => {
  for (const end of ['kill', 'exit', 'teardown']) {
    let polls = 0;
    const { p, spawn } = toy(t, { readiness: { predicate: () => { polls++; return false; }, pollMs: 10 } });
    p.start();
    t.mock.timers.tick(30);
    const n = polls;
    if (end === 'kill') p.kill();
    else if (end === 'exit') spawn.spawned[0].fireExit({ exitCode: 0 });
    else p._teardownForRestart();
    assert.equal(p.readyTimer, null, end);
    // 0441: kill and teardown leave the old pty stopping (SIGKILL pending);
    // an exit on its own leaves nothing to stop.
    assert.equal(p.stopping, end !== 'exit', `${end}: stopping`);
    t.mock.timers.tick(100);
    assert.equal(polls, n, end);
    p.kill();
    t.mock.timers.reset();
  }
});

test('stopSidecars runs on exit, kill and teardown', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  spawn.spawned[0].fireExit({ exitCode: 0 });
  assert.equal(p.calls.filter((c) => c === 'stopSidecars').length, 1);
  p.start();
  p._teardownForRestart();
  assert.equal(p.calls.filter((c) => c === 'stopSidecars').length, 2);
  p.kill();
  assert.equal(p.calls.filter((c) => c === 'stopSidecars').length, 3);
});

// ── 0441: kill and restart never leave the old process running ──────────────

test('0441: kill SIGTERMs, then SIGKILLs at 1.5 s when the process ignores it', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  let stopped = 0;
  p.on('stopped', () => stopped++);
  p.kill();
  assert.deepEqual(old._kills, ['SIGTERM']);
  assert.equal(p.stopping, true);
  t.mock.timers.tick(1499);
  assert.deepEqual(old._kills, ['SIGTERM'], 'no SIGKILL inside the grace');
  t.mock.timers.tick(1);
  assert.deepEqual(old._kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(p.stopping, false);
  assert.equal(stopped, 1, "Fleet hears 'stopped' once");
});

test('0441: an exit inside the grace clears the SIGKILL timer', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p.kill();
  old.fireExit({ exitCode: 0, signal: 15 });
  assert.equal(p.stopping, false);
  t.mock.timers.tick(5000);
  assert.deepEqual(old._kills, ['SIGTERM'], 'an exited process is never SIGKILLed');
});

test('0441: hardKill reaches a pty a restart teardown dropped', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p._teardownForRestart();
  assert.equal(p.pty, null);
  p.hardKill();
  assert.deepEqual(old._kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(p.stopping, false);
});

test('0441: hardKill without kill() never spawns the deferred respawn', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p._teardownForRestart();
  p.start(); // deferred: the old process is still stopping
  p.hardKill();
  assert.equal(spawn.spawned.length, 1, 'shutdown does not start a new claude');
  assert.deepEqual(old._kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(p.stopping, false);
});

test('0441: hardKill after kill() skips a pty whose exit was already seen', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p.kill();
  old.fireExit({ exitCode: 0, signal: 15 });
  p.hardKill();
  assert.deepEqual(old._kills, ['SIGTERM'], 'no signal to a pid that may be reused');
});

test('0441: a respawn waits for the old exit; sends queue and drain on the new pty', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p._teardownForRestart();
  p.start(); // what changeModel / changePermissionMode do next
  assert.equal(spawn.spawned.length, 1, 'no spawn while the old process runs');
  assert.equal(p.send('during the wait'), true);
  assert.equal(p.send('second'), true);
  assert.equal(spawn.spawned.length, 1, 'send() revive does not spawn early either');
  assert.deepEqual(p.pendingSends, ['during the wait', 'second']);
  old.fireExit({ exitCode: 0, signal: 15 });
  assert.equal(spawn.spawned.length, 2, 'spawned once the old process ended');
  assert.equal(p.pty, spawn.spawned[1]);
  t.mock.timers.tick(100); // readiness delayMs
  assert.deepEqual(p.pendingSends, []);
  assert.deepEqual(spawn.spawned[1]._writes, ['during the wait\r', 'second\r']);
  assert.deepEqual(old._writes, [], 'nothing reached the dying process');
});

test('0441: a respawn waiting on a wedged process runs after the SIGKILL', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p._teardownForRestart();
  p.start();
  t.mock.timers.tick(1499);
  assert.equal(spawn.spawned.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(old._kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(spawn.spawned.length, 2);
});

test('0441: kill() while a respawn waits cancels it', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  const old = spawn.spawned[0];
  p._teardownForRestart();
  p.start();
  p.kill();
  old.fireExit({ exitCode: 0, signal: 15 });
  t.mock.timers.tick(5000);
  assert.equal(spawn.spawned.length, 1, 'a killed slot is never revived');
});

test('0441: zoom during a waiting respawn reports it instead of binding a null pty', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  p._teardownForRestart();
  p.start();
  assert.throws(() => p.attachZoomView({}), /restarting/);
  spawn.spawned[0].fireExit({ exitCode: 0, signal: 15 });
  const view = p.attachZoomView({});
  assert.equal(view.pty, spawn.spawned[1]);
  view.dispose();
});

test('handleEarlyExit returning true skips auto-restart and the generic error', (t) => {
  const { p, spawn } = toy(t, { earlyExit: true });
  p.start();
  spawn.spawned[0].fireExit({ exitCode: 1 });
  assert.ok(p.calls.includes('handleEarlyExit:1'));
  assert.equal(p.restartTimer, null);
  assert.equal(p.restartCount, 0);
  assert.deepEqual(p.tail.map((l) => l.text), ['process exited code=1 signal=']);
});

test('handleEarlyExit returning false falls through to auto-restart', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  spawn.spawned[0].fireExit({ exitCode: 1 });
  assert.ok(p.restartTimer);
  t.mock.timers.tick(2000);
  assert.equal(spawn.spawned.length, 2);
  assert.equal(p.resuming, true, 'restart asks the provider to resume');
});

test('handleEarlyExit is not consulted for a deliberate kill or a SIGSTOP report', (t) => {
  const { p, spawn } = toy(t);
  p.start();
  spawn.spawned[0].fireExit({ exitCode: 1, signal: 'SIGSTOP' });
  assert.equal(p.calls.some((c) => c.startsWith('handleEarlyExit')), false);
});
