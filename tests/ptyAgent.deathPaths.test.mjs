// tests/ptyAgent.deathPaths.test.mjs — a slot whose process is gone must never
// report a healthy status, whichever way the process died.
//
// node-pty reports a signal death as exit code ZERO with the signal as a
// number, and a clean exit as zero too. The restart logic only treated a
// non-zero code as a failure, so three of the four ways a session can end left
// the card reading IDLE over a process that no longer existed.
//
// This drives the REAL exit handler through the real spawn seam. An earlier
// test in this repo set the status by hand and asserted the guard, which
// tested the guard and not the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

// Build an agent whose pty is a fake we can make "exit" on demand.
function agentWithFakePty() {
  const a = new PtyAgent({
    slot: 1, id: 's1', name: 'x', cwd: '/tmp/nonexistent-for-test',
    model: 'opus-4.8', permissionMode: 'auto',
    sessionId: '00000000-0000-4000-8000-000000000000',
  });
  let exitCb = null;
  a._spawn = () => ({
    pid: 4242,
    onData() {}, write() {}, resize() {}, kill() {},
    onExit(cb) { exitCb = cb; },
  });
  a.start();
  return { agent: a, die: (exitCode, signal) => exitCb?.({ exitCode, signal }) };
}

const cases = [
  ['a clean exit (user typed /exit)', 0, 0],
  ['a SIGKILL from outside',          0, 9],
  ['a SIGTERM from outside',          0, 15],
  ['no exit code at all',             null, null],
];

for (const [label, code, signal] of cases) {
  test(`${label} does not leave the slot reporting a healthy status`, () => {
    const { agent, die } = agentWithFakePty();
    die(code, signal);
    const status = agent.toJSON().status;
    assert.notEqual(status, 'idle', `${label} reported idle over a dead process`);
    assert.notEqual(status, 'working', `${label} reported working over a dead process`);
    assert.equal(status, 'error');
    agent.kill?.();
  });
}

test('a deliberate kill is silent — it is not an error', () => {
  const { agent, die } = agentWithFakePty();
  agent.kill();              // the user pressed K
  die(0, 15);
  assert.notEqual(agent.toJSON().status, 'error', 'a kill the user asked for is not a fault');
});

test('a crash that will be retried reports working, not error', () => {
  const { agent, die } = agentWithFakePty();
  die(1, 0);                 // first transient crash — inside the restart budget
  assert.equal(agent.toJSON().status, 'working', 'a retry in flight is not a dead slot');
  agent.kill?.();
});
