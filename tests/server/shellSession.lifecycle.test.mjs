// tests/server/shellSession.lifecycle.test.mjs — pins 0312 acceptance criteria.
//
// Acceptance:
//   1. killShellSession() kills the pty and clears the singleton so a later
//      getShellSession() spawns fresh.
//   2. resizeShellSession(cols, rows) forwards to both pty.resize and term.resize.
//   Both no-op safely when no session exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getShellSession,
  killShellSession,
  resizeShellSession,
  _resetForTest,
} from '../../server/shellSession.mjs';

// makeStubSpawn — returns a fake PTY that records kill/resize/onData calls.
function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const pty = {
      pid: 9200 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      killCalls: [],
      resizeCalls: [],
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      kill(sig) { this.killCalls.push(sig); },
      resize(c, r) { this.resizeCalls.push([c, r]); },
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

// ---------------------------------------------------------------------------
// killShellSession — no-op safety
// ---------------------------------------------------------------------------

test('killShellSession() no-ops safely when no session exists', () => {
  // Must not throw before any spawn.
  assert.doesNotThrow(() => killShellSession());
});

// ---------------------------------------------------------------------------
// killShellSession — clears singleton so next getShellSession() spawns fresh
// ---------------------------------------------------------------------------

test('killShellSession() clears the singleton: next call spawns a second PTY', () => {
  const stub = makeStubSpawn();

  getShellSession({ spawn: stub });
  assert.strictEqual(stub.calls.length, 1, 'first spawn happened');

  killShellSession();
  assert.strictEqual(stub.calls.length, 1, 'no extra spawn yet');

  // After kill, singleton is null — getShellSession must spawn fresh.
  getShellSession({ spawn: stub });
  assert.strictEqual(stub.calls.length, 2, 'second spawn happened after kill');
});

// ---------------------------------------------------------------------------
// killShellSession — pty.kill called with SIGTERM
// ---------------------------------------------------------------------------

test('killShellSession() calls pty.kill("SIGTERM")', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });

  killShellSession();

  const pty = stub.calls[0];
  assert.ok(pty.killCalls.includes('SIGTERM'), 'pty.kill("SIGTERM") was called');
});

// ---------------------------------------------------------------------------
// killShellSession — term.dispose() called when term is available
// ---------------------------------------------------------------------------

test('killShellSession() disposes the xterm Terminal when available', () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  if (!session.term) {
    // xterm-headless not available in this environment — skip.
    return;
  }

  let disposed = false;
  const origDispose = session.term.dispose.bind(session.term);
  session.term.dispose = () => { disposed = true; origDispose(); };

  killShellSession();

  assert.ok(disposed, 'term.dispose() was called');
});

// ---------------------------------------------------------------------------
// resizeShellSession — no-op safety
// ---------------------------------------------------------------------------

test('resizeShellSession() no-ops safely when no session exists', () => {
  // Must not throw before any spawn.
  assert.doesNotThrow(() => resizeShellSession(120, 40));
});

// ---------------------------------------------------------------------------
// resizeShellSession — forwards to pty.resize
// ---------------------------------------------------------------------------

test('resizeShellSession(cols, rows) calls pty.resize with the given dims', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });

  resizeShellSession(120, 40);

  const pty = stub.calls[0];
  assert.ok(pty.resizeCalls.length > 0, 'pty.resize was called');
  assert.deepStrictEqual(pty.resizeCalls[0], [120, 40], 'pty.resize received correct dims');
});

// ---------------------------------------------------------------------------
// resizeShellSession — forwards to term.resize
// ---------------------------------------------------------------------------

test('resizeShellSession(cols, rows) calls term.resize with the given dims when term is available', () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  if (!session.term) {
    // xterm-headless not available in this environment — skip.
    return;
  }

  const resizeCalls = [];
  const origResize = session.term.resize.bind(session.term);
  session.term.resize = (c, r) => { resizeCalls.push([c, r]); origResize(c, r); };

  resizeShellSession(100, 30);

  assert.ok(resizeCalls.length > 0, 'term.resize was called');
  assert.deepStrictEqual(resizeCalls[0], [100, 30], 'term.resize received correct dims');
});
