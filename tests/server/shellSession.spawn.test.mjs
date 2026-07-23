// tests/server/shellSession.spawn.test.mjs — pins 0309 acceptance criteria.
//
// Acceptance:
//   1. getShellSession() lazily spawns node-pty running $SHELL (fallback
//      /bin/bash) via argv-form, in $HOME.
//   2. Second call returns the SAME pty (singleton, not a new spawn).
//
// Stubs node-pty via the optional `spawn` injection seam so no real PTY
// process is created in the test environment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { getShellSession, _resetForTest } from '../../server/shellSession.mjs';

// makeStubSpawn — records every call; returns a lightweight fake PTY object.
function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const pty = {
      pid: 9000 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      kill() {},
      resize() {},
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

test('spawns $SHELL as argv[0] with empty args array (argv-form)', () => {
  const stub = makeStubSpawn();
  const expectedShell = process.env.SHELL || '/bin/bash';

  const { pty } = getShellSession({ spawn: stub });

  assert.strictEqual(stub.calls.length, 1, 'spawn called exactly once');
  assert.strictEqual(pty._bin, expectedShell, 'argv[0] is $SHELL');
  assert.deepStrictEqual(pty._args, [], 'args array is empty (argv-form)');
});

test('spawns with cwd=$HOME', () => {
  const stub = makeStubSpawn();

  getShellSession({ spawn: stub });

  assert.strictEqual(stub.calls[0]._opts.cwd, homedir(), 'cwd is $HOME');
});

test('singleton: second call returns the same object, no second spawn', () => {
  const stub = makeStubSpawn();

  const first  = getShellSession({ spawn: stub });
  const second = getShellSession({ spawn: stub }); // stub NOT used again

  assert.strictEqual(stub.calls.length, 1, 'node-pty spawned exactly once');
  assert.strictEqual(first, second, 'both calls return the identical object');
});

test('falls back to /bin/bash when $SHELL is unset', () => {
  const stub = makeStubSpawn();
  const saved = process.env.SHELL;
  delete process.env.SHELL;

  try {
    const { pty } = getShellSession({ spawn: stub });
    assert.strictEqual(pty._bin, '/bin/bash', 'fallback shell is /bin/bash');
  } finally {
    if (saved !== undefined) process.env.SHELL = saved;
  }
});
