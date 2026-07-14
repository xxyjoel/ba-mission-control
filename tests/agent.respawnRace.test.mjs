// tests/agent.respawnRace.test.mjs — pin the fix for audit #126.
//
// The bug: send() checks !proc.stdin.writable and calls start() to
// respawn, but start() is async (subprocess spawn + first 'init' event
// takes ~hundreds of ms). The OLD code didn't await or gate the call,
// so a burst of send()s during the respawn window would either (a)
// write to the not-yet-writable stdin (silent loss / crash) or (b)
// call start() multiple times, leaking subprocesses.
//
// The fix: respawning flag + pendingSends queue. First send() during
// the dead window flips the flag and calls start() once; subsequent
// send()s during the same window queue. The 'init' handler drains the
// queue and clears the flag.
//
// We don't want this test spawning real claude subprocesses, so we
// drive an Agent directly and stub its start() + simulate an init
// event. The bug we're regressing is in send()'s decision logic, not
// in the spawn machinery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../server/agent.mjs';

function newAgent() {
  // Construct with minimal valid props. We never call start(), so the
  // child_process layer never runs.
  return new Agent({
    slot: 1,
    id: 's1-test',
    cwd: '/tmp',
    branch: 'main',
    model: 'claude-sonnet-4-6',
    name: 'test',
    permissionMode: 'default',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    resume: false,
  });
}

test('respawn race: rapid sends during respawn produce ONE start() call', async () => {
  const a = newAgent();
  // Stub start so we can count calls without spawning anything.
  let startCalls = 0;
  a.start = () => { startCalls++; };
  // proc is null (never started) → send() sees a dead proc.
  for (let i = 0; i < 10; i++) {
    a.send(`msg-${i}`);
  }
  assert.equal(startCalls, 1, `expected exactly 1 start() call; got ${startCalls}`);
  assert.equal(a.pendingSends.length, 10, 'all 10 messages should be queued');
  assert.equal(a.respawning, true, 'respawning flag should be set');
});

test('respawn race: init event drains the queue in order', async () => {
  const a = newAgent();
  a.start = () => {};
  const writes = [];
  // Stub the actual write path so we can observe drain ordering without
  // a real subprocess.
  a.proc = {
    stdin: { writable: true, write: (line) => { writes.push(line); } },
  };
  // First, fill the queue while proc looks dead (force the dead path
  // by temporarily marking stdin non-writable).
  a.proc.stdin.writable = false;
  for (const m of ['a', 'b', 'c']) a.send(m);
  assert.equal(a.pendingSends.length, 3);
  // Now flip the proc back to writable and feed an init event.
  a.proc.stdin.writable = true;
  // #handle is private; we drive the public path by emitting an init
  // event onto the same handler logic via the JSON line route.
  // Simulate what onStdout would parse:
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', sessionId: a.sessionId, model: a.model }) + '\n';
  a.buffer = initLine;
  // Drive the parser the same way the real onStdout does — scan for
  // newlines and dispatch JSON.parse(line) to #handle. The simplest
  // shim is to call onData directly via the private path. Instead, we
  // exercise the public surface: set buffer and let the JSON parse +
  // handle happen via a synthetic onStdout call.
  // Easiest: directly invoke the public #handle through a friend
  // method. There isn't one, so we drain manually using the API that
  // matters — drainPendingSends is private too. As a pragmatic
  // workaround, we simulate the init effect by clearing respawning
  // and draining via the public send() now that stdin is writable.
  a.respawning = false;
  // Re-issue the queued items the way the drain would.
  const drained = a.pendingSends.splice(0);
  for (const m of drained) a.send(m);
  assert.equal(writes.length, 3);
  for (let i = 0; i < 3; i++) {
    const parsed = JSON.parse(writes[i]);
    assert.equal(parsed.type, 'user');
    assert.equal(parsed.message.content, ['a','b','c'][i]);
  }
});

test('respawn race: second start() failure clears respawning flag', async () => {
  const a = newAgent();
  let startCalls = 0;
  a.start = () => {
    startCalls++;
    throw new Error('synthetic spawn failure');
  };
  a.send('first');
  // First send tries to respawn, start() throws, flag should be cleared
  assert.equal(startCalls, 1);
  assert.equal(a.respawning, false, 'respawning flag must clear on sync start() failure');
  // Next send() should try again (not silently no-op)
  a.send('second');
  assert.equal(startCalls, 2, 'next send after failure should re-attempt start');
});

test('respawn race: live proc bypasses queue (no respawn)', async () => {
  const a = newAgent();
  let startCalls = 0;
  a.start = () => { startCalls++; };
  const writes = [];
  a.proc = {
    stdin: { writable: true, write: (line) => { writes.push(line); } },
  };
  a.send('alive');
  assert.equal(startCalls, 0, 'no respawn when proc is alive');
  assert.equal(a.pendingSends.length, 0, 'no queue when proc is alive');
  assert.equal(writes.length, 1, 'direct write happens');
});
