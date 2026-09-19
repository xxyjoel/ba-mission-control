// tests/ptyAgent.lifecycle.test.mjs — 0408 process-lifecycle pins.
//
// Findings covered (task 0408, adversarial review 2026-09-18):
//   P1 — a replaced PTY's late exit must not clobber the successor's state
//        (changeModel/changePermissionMode leave the old onExit live; node-pty
//        delivers exit asynchronously).
//   P2 — send() during the auto-restart backoff must cancel the scheduled
//        restart, and start() must refuse to spawn next to a live PTY.
//   P6 — killing a PAUSED (SIGSTOPped) slot must SIGCONT before SIGTERM, or
//        the process stays frozen with the signal pending forever.
//   P7 — the restart budget resets after a stable run; only rapid crash
//        loops exhaust RESTART_MAX.
//   M1 — a relaunch passes the RESOLVED model's cli id when the catalog knows
//        it (a `/model` switch typed inside claude survives restart).
//
// Uses the injected-spawn pattern from tests/ptyAgent.test.mjs, with one
// difference that matters here: onData/onExit disposables actually REMOVE the
// handler, so the P1 teardown-disposal fix is observable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 4321 + spawned.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      _writes: [],
      _kills: [],
      _handlers: handlers,
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize() {},
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireData(s) { for (const fn of [...handlers.data]) fn(s); },
      fireExit({ exitCode = 0, signal = null } = {}) {
        for (const fn of [...handlers.exit]) fn({ exitCode, signal });
      },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeAgent(spawn, overrides = {}) {
  return new PtyAgent({
    slot: 1,
    id: 's1-test',
    cwd: '/tmp/fake-cwd',
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn,
    ...overrides,
  });
}

function forceReady(p) {
  if (p.readyTimer) { clearTimeout(p.readyTimer); p.readyTimer = null; }
  p.ready = true;
}

// ─── P1: stale exit from a replaced PTY ────────────────────────────

test('P1: changeModel — the old PTY exit does not clobber the new PTY state', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const old = fake.spawned[0];
  p.changeModel('opus-4.7');
  assert.equal(fake.spawned.length, 2, 'changeModel respawns once');
  const fresh = fake.spawned[1];
  assert.equal(p.pty, fresh);

  // The teardown must have unsubscribed the old PTY's listeners.
  assert.equal(old._handlers.exit.size, 0, 'old onExit disposed at teardown');
  assert.equal(old._handlers.data.size, 0, 'old onData disposed at teardown');

  // Even if an exit was already queued (fired against surviving handlers),
  // the identity guard must ignore it. Simulate by re-invoking through a
  // fresh handler-free fireExit — nothing to call, and state stays intact.
  old.fireExit({ exitCode: 0, signal: 15 });
  assert.equal(p.pty, fresh, 'stale exit must not null the new pty');
  assert.ok(p.tailer, 'tailer for the new process still running');
  assert.ok(p.statusTailer, 'status tailer still running');
  assert.ok(p.readyTimer, 'ready timer for the new process still armed');

  // A send after the stale exit goes to the SECOND pty — no third spawn.
  forceReady(p);
  const ok = p.send('hello');
  assert.equal(ok, true);
  assert.equal(fake.spawned.length, 2, 'no third claude spawned');
  assert.ok(fresh._writes.length >= 1, 'the live pty received the message');
  p.kill();
});

test('P1: old PTY bytes stop reaching the shared emulator after changeModel', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const old = fake.spawned[0];
  p.changeModel('opus-4.7');
  // With the old data sub disposed, a dying process's output has no path
  // into this agent (the "two pids writing into one emulator" garble).
  assert.equal(old._handlers.data.size, 0);
  old.fireData('garbage from the dying process');
  // The new pty's data handler is the only subscriber left.
  assert.equal(fake.spawned[1]._handlers.data.size, 1);
  p.kill();
});

// ─── P2: revive during backoff / double-start ──────────────────────

test('P2: send() during the auto-restart backoff cancels the scheduled restart', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  fake.spawned[0].fireExit({ exitCode: 1, signal: null });
  assert.ok(p.restartTimer, 'precondition: backoff restart armed');
  assert.equal(p.pty, null);

  p.send('typed during the backoff');
  assert.equal(p.restartTimer, null, 'revive must clear the backoff timer');
  assert.equal(fake.spawned.length, 2, 'revive spawned exactly one new pty');
  p.kill();
});

test('P2: start() refuses to spawn a sibling next to a live PTY', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  assert.equal(fake.spawned.length, 1);
  p.start(); // must be a no-op
  assert.equal(fake.spawned.length, 1, 'second start() while running spawns nothing');
  assert.equal(p.pty, fake.spawned[0]);
  p.kill();
});

// ─── P6: kill on a paused slot ─────────────────────────────────────

test('P6: kill() on a PAUSED agent sends SIGCONT before SIGTERM', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.pause();
  assert.equal(p.paused, true);
  p.kill();
  assert.deepEqual(fake.spawned[0]._kills, ['SIGSTOP', 'SIGCONT', 'SIGTERM'],
    'a stopped process must be woken or the SIGTERM stays pending forever');
});

test('P6: kill() on a running (never paused) agent sends no SIGCONT', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.kill();
  assert.deepEqual(fake.spawned[0]._kills, ['SIGTERM']);
});

test('P6: pause then resume then kill — no spurious SIGCONT at kill time', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.pause();
  p.resume();
  p.kill();
  assert.deepEqual(fake.spawned[0]._kills, ['SIGSTOP', 'SIGCONT', 'SIGTERM']);
});

test('P6: changeModel on a PAUSED agent wakes the old process before SIGTERM', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.pause();
  p.changeModel('opus-4.7');
  assert.deepEqual(fake.spawned[0]._kills, ['SIGSTOP', 'SIGCONT', 'SIGTERM']);
  p.kill();
});

// ─── P7: restart budget resets after a stable run ──────────────────

test('P7: a crash after a stable run restarts with a FRESH budget', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  // Two earlier flaps, then a long stable run (backdate the spawn clock).
  p.restartCount = 2;
  p._spawnTs = Date.now() - 10 * 60 * 1000;
  fake.spawned[0].fireExit({ exitCode: 1, signal: null });
  assert.equal(p.restartCount, 1, 'stable-run crash counts as the FIRST of a new budget');
  assert.ok(p.restartTimer, 'restart scheduled');
  assert.notEqual(p.status, 'error');
  clearTimeout(p.restartTimer);
  p.restartTimer = null;
});

test('P7: a crash after a stable run never permanently errors the slot (old lifetime-counter bug)', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  // Budget already exhausted by flaps long ago; the process then ran for days.
  p.restartCount = 3;
  p._spawnTs = Date.now() - 10 * 60 * 1000;
  fake.spawned[0].fireExit({ exitCode: 1, signal: null });
  assert.notEqual(p.status, 'error', 'three transient crashes days apart must not brick the slot');
  assert.ok(p.restartTimer, 'restart scheduled after the stable run');
  clearTimeout(p.restartTimer);
  p.restartTimer = null;
});

test('P7: rapid crash loops still exhaust the budget', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.restartCount = 3; // exhausted, and the crash comes seconds after spawn
  p._spawnTs = Date.now();
  fake.spawned[0].fireExit({ exitCode: 1, signal: null });
  assert.equal(p.status, 'error', 'flapping session still errors after RESTART_MAX');
  assert.equal(p.restartTimer, null);
});

// ─── M1: relaunch keeps the resolved model ─────────────────────────

test('M1: relaunch passes the resolved model cli id when the catalog knows it', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  // A `/model` switch typed inside claude lands in resolvedModel only.
  p.resolvedModel = 'claude-fable-5';
  p.changePermissionMode('plan'); // any teardown+restart path
  const args = fake.spawned[1]._args;
  const mi = args.indexOf('--model');
  assert.notEqual(mi, -1);
  assert.equal(args[mi + 1], 'claude-fable-5', 'relaunch keeps the in-session /model switch');
  p.kill();
});

test('M1: an unknown resolved model falls back to the launch model', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.resolvedModel = 'claude-mystery-99'; // not in the catalog
  p.changePermissionMode('plan');
  const args = fake.spawned[1]._args;
  const mi = args.indexOf('--model');
  assert.equal(args[mi + 1], 'claude-sonnet-4-6', 'unknown resolved model → launch model');
  p.kill();
});

test('M1: a deliberate changeModel() from mc still wins over resolvedModel', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.resolvedModel = 'claude-fable-5';
  p.changeModel('haiku-4.5'); // nulls resolvedModel by design
  const args = fake.spawned[1]._args;
  const mi = args.indexOf('--model');
  assert.equal(args[mi + 1], 'claude-haiku-4-5-20251001');
  assert.equal(p.resolvedModel, null);
  p.kill();
});
