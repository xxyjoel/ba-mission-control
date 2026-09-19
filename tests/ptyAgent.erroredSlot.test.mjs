// tests/ptyAgent.erroredSlot.test.mjs — a slot whose claude is gone must say so.
//
// crm-helper, 2026-09-19: auto-restart exhausted after three attempts, no
// claude process left for the slot, and the card still read IDLE while the
// fleet header counted zero errors. The error was stored and then dropped,
// because toJSON derives status fresh from the hook and transcript clocks and
// a dead session's last signals look exactly like a healthy idle one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function agentWithNoPty() {
  const a = new PtyAgent({
    slot: 3, id: 's3', name: 'crm-helper', cwd: '/tmp/crm-helper',
    model: 'opus-4.8', permissionMode: 'auto',
    sessionId: '9ca62749-1cf1-4a04-bee4-9278cc590b65',
  });
  a.pty = null;                       // the process is gone
  return a;
}

test('an exhausted slot reports error, not idle', () => {
  const a = agentWithNoPty();
  a.status = 'error';                 // what #onExit sets when restarts run out
  // The clocks a dead session leaves behind look like a quiet, healthy one.
  a.hookStatus = 'idle';
  a.hookStatusTs = Date.now() - 60_000;
  assert.equal(a.toJSON().status, 'error', 'the card must show the slot is broken');
  a.kill?.();
});

test('a live slot is unaffected by the guard', () => {
  const a = agentWithNoPty();
  a.pty = { pid: 1234, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
  a.status = 'error';
  a.hookStatus = 'working';
  a.hookStatusTs = Date.now();
  assert.notEqual(a.toJSON().status, 'error', 'a running pty still derives its real status');
  a.kill?.();
});

test('a slot in the restart backoff is not mislabelled as errored', () => {
  // pty is null here too, but the agent has NOT given up yet.
  const a = agentWithNoPty();
  a.hookStatus = 'idle';
  a.hookStatusTs = Date.now() - 1000;
  assert.notEqual(a.toJSON().status, 'error', 'only an exhausted slot reports error');
  a.kill?.();
});
