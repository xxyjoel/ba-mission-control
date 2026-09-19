// tests/server/shellSession.staleexit.test.mjs — S5 (0408): stale-pid guard.
//
// node-pty keeps `pid` after exit and swallows ESRCH, so killShellSession()
// on a dead handle used to SIGTERM whatever process now owned the recycled
// pid. Contract now: the singleton drops itself the moment the shell exits on
// its own; a later getShellSession() spawns fresh, and killShellSession()
// never signals the dead handle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, killShellSession, _resetForTest } from '../../server/shellSession.mjs';

function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const exitHandlers = [];
    const kills = [];
    const pty = {
      pid: 9300 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      kills,
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit(fn) {
        exitHandlers.push(fn);
        return { dispose() { const i = exitHandlers.indexOf(fn); if (i >= 0) exitHandlers.splice(i, 1); } };
      },
      write() {},
      kill(sig) { kills.push(sig ?? 'SIGTERM'); },
      resize() {},
      fireExit({ exitCode = 0, signal = null } = {}) {
        for (const fn of [...exitHandlers]) fn({ exitCode, signal });
      },
    };
    calls.push(pty);
    return pty;
  };
  stub.calls = calls;
  return stub;
}

test.beforeEach(() => _resetForTest());
test.afterEach(() => _resetForTest());

test('S5: the singleton drops itself when the shell exits on its own', () => {
  const stub = makeStubSpawn();
  const s1 = getShellSession({ spawn: stub });
  assert.equal(stub.calls.length, 1);
  stub.calls[0].fireExit({ exitCode: 0 });
  // A fresh call must spawn a NEW shell, not hand back the dead one.
  const s2 = getShellSession({ spawn: stub });
  assert.notEqual(s2, s1, 'dead singleton must not be reused');
  assert.equal(stub.calls.length, 2, 'a fresh shell was spawned');
  assert.equal(s2.pty, stub.calls[1]);
});

test('S5: killShellSession after a self-exit signals nothing', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const dead = stub.calls[0];
  dead.fireExit({ exitCode: 0 });
  killShellSession(); // singleton already dropped — must be a silent no-op
  assert.deepEqual(dead.kills, [], 'the dead handle (recycled pid) was never signaled');
});

test('S5: a deliberate killShellSession still SIGTERMs a LIVE shell once', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const live = stub.calls[0];
  killShellSession();
  assert.deepEqual(live.kills, ['SIGTERM']);
  // The exit that follows our own SIGTERM must not disturb a future session.
  live.fireExit({ exitCode: 0, signal: 15 });
  const s2 = getShellSession({ spawn: stub });
  assert.equal(stub.calls.length, 2);
  assert.equal(s2.pty, stub.calls[1], 'future session unaffected by the old exit');
});
