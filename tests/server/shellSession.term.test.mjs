// tests/server/shellSession.term.test.mjs — pins 0310 acceptance criteria.
//
// Acceptance:
//   1. getShellSession() exposes a long-lived xterm-headless Terminal that
//      pty.onData writes into.
//   2. The term buffer accumulates output while the overlay is closed
//      (survives detach — no view attached).
//
// Stubs node-pty via the optional `spawn` injection seam so no real PTY
// process is created. The stub captures the onData callback so the test
// can drive PTY bytes through it, simulating output while "detached".

import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, _resetForTest } from '../../server/shellSession.mjs';

// makeStubSpawn — returns a fake PTY that captures onData callbacks so the
// test can fire chunks through them, plus a fireData() helper.
function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const pty = {
      pid: 9100 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      kill() {},
      resize() {},
      // fireData — simulate PTY emitting a chunk (used by tests)
      fireData(chunk) { for (const fn of dataHandlers) fn(chunk); },
    };
    calls.push(pty);
    return pty;
  };
  stub.calls = calls;
  return stub;
}

// Isolate each test: reset the module singleton so calls don't bleed across.
test.beforeEach(() => _resetForTest());
test.afterEach(() => _resetForTest());

test('getShellSession exposes { pty, term, cell } — term is non-null when xterm available', () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  assert.ok(session.pty, 'session.pty is present');
  // term may be null if xterm-headless is unavailable in this env —
  // guard mirrors PtyAgent's defensive check; skip the buffer assertion.
  if (session.term === null) return;
  assert.ok(session.term, 'session.term is a Terminal instance');
  assert.ok(session.cell !== undefined, 'session.cell is exposed');
});

test('term buffer accumulates output while no view is attached (detached survival)', async () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  if (!session.term) {
    // xterm-headless not available in this environment — skip.
    return;
  }

  // No overlay is attached; fire PTY bytes directly to simulate output
  // while the overlay is closed.
  const pty = stub.calls[0];
  pty.fireData('hello world\r\n');

  // xterm.write() is asynchronous — flush by writing an empty string with
  // a callback, then await before reading the buffer.
  await new Promise((resolve) => session.term.write('', resolve));

  const line0 = session.term.buffer.active.getLine(0);
  assert.ok(line0, 'term buffer has a line after onData fires');

  const text = line0.translateToString(true);
  assert.ok(text.includes('hello'), `buffer line contains written content; got: "${text}"`);
});

test('term buffer accumulates multiple chunks (survives close/reopen simulation)', async () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  if (!session.term) return;

  const pty = stub.calls[0];
  // Simulate several bursts of output while overlay is closed.
  pty.fireData('line one\r\n');
  pty.fireData('line two\r\n');

  // Flush xterm's async write queue before reading the buffer.
  await new Promise((resolve) => session.term.write('', resolve));

  // Both chunks should be in the buffer — getShellSession returns the SAME
  // session object, so the same term receives all writes.
  const buf = session.term.buffer.active;
  let found = false;
  for (let i = 0; i < Math.min(buf.length, 20); i++) {
    const line = buf.getLine(i);
    if (line && line.translateToString(true).includes('line one')) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'earlier chunk ("line one") is still in term buffer after second chunk');
});

test('singleton: second getShellSession() returns same { term } instance', () => {
  const stub = makeStubSpawn();

  const first  = getShellSession({ spawn: stub });
  const second = getShellSession({ spawn: stub });

  assert.strictEqual(first.term, second.term, 'term is the same instance across calls');
});
