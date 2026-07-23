// tests/server/shellSession.cd.test.mjs — pins 0311 acceptance criteria.
//
// Acceptance:
//   1. cdToCwd(dir) writes a `cd <quoted-dir>\n` sequence to the pty when the
//      shell is at a fresh prompt (atFreshPrompt === true).
//   2. cdToCwd() is a no-op (returns false, no write) when not at a fresh prompt.
//   3. Path quoting handles spaces and embedded single quotes safely (§4 injection
//      mitigation from overlay-terminal.md).
//
// Stubs node-pty via the `spawn` injection seam; `writes` array captures every
// pty.write() call so tests can assert the emitted command string.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, cdToCwd, _resetForTest } from '../../server/shellSession.mjs';

// makeStubSpawn — returns a stub node-pty spawn function whose PTY objects:
//   - capture onData callbacks (so tests can fire PTY output to drive prompt detection)
//   - record all pty.write() calls in a `writes` array
//   - expose a fireData() helper to simulate PTY output chunks
function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const writes = [];
    const pty = {
      pid: 9200 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write(data) { writes.push(data); },
      kill() {},
      resize() {},
      writes,
      // fireData — simulate the shell emitting a PTY output chunk (drives atFreshPrompt)
      fireData(chunk) { for (const fn of dataHandlers) fn(chunk); },
    };
    calls.push(pty);
    return pty;
  };
  stub.calls = calls;
  return stub;
}

// Isolate each test: reset the module singleton so state doesn't bleed between tests.
test.beforeEach(() => _resetForTest());
test.afterEach(() => _resetForTest());

test('cdToCwd() emits cd command at a fresh prompt and returns true', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  // Simulate the shell printing a prompt ($ at end of chunk → atFreshPrompt=true)
  pty.fireData('joel@mac proj $ ');

  const result = cdToCwd('/repo/foo');

  assert.strictEqual(result, true, 'cdToCwd returns true when emitted');
  assert.strictEqual(pty.writes.length, 1, 'exactly one write to the pty');
  assert.strictEqual(pty.writes[0], "cd '/repo/foo'\n", 'cd command is single-quoted');
});

test('cdToCwd() is a no-op mid-command (returns false, no write)', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  // Simulate mid-command output — no prompt suffix at the end
  pty.fireData("Cloning into 'repo'...\n");

  const result = cdToCwd('/repo/foo');

  assert.strictEqual(result, false, 'cdToCwd returns false when mid-command');
  assert.strictEqual(pty.writes.length, 0, 'no write to the pty when suppressed');
});

test('cdToCwd() is a no-op before any prompt output (session just spawned)', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  // No PTY output fired — atFreshPrompt starts as false
  const result = cdToCwd('/repo');

  assert.strictEqual(result, false, 'cdToCwd returns false when no prompt seen yet');
  assert.strictEqual(pty.writes.length, 0, 'no write issued');
});

test('cdToCwd() resets atFreshPrompt after emitting (prevents double-fire)', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('~ % ');

  // First call should succeed
  const first = cdToCwd('/repo');
  // Second call (no new prompt output) should be suppressed
  const second = cdToCwd('/repo');

  assert.strictEqual(first, true, 'first call emitted');
  assert.strictEqual(second, false, 'second call suppressed (no fresh prompt)');
  assert.strictEqual(pty.writes.length, 1, 'only one write total');
});

test('cdToCwd() is a no-op when no session has been spawned', () => {
  // _resetForTest cleared any prior session; no getShellSession called here
  const result = cdToCwd('/repo');
  assert.strictEqual(result, false, 'cdToCwd returns false with no session');
});

test('path quoting: spaces in dir are safely single-quoted', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd('/my projects/foo bar');

  assert.strictEqual(pty.writes[0], "cd '/my projects/foo bar'\n",
    'spaces are enclosed in single quotes, not escaped with backslash');
});

test('path quoting: embedded single quote uses POSIX escape technique', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd("/root/it's here");

  // Expected: cd '/root/it'\''s here'\n
  assert.strictEqual(pty.writes[0], "cd '/root/it'\\''s here'\n",
    "embedded single quote is escaped as '\\'' (POSIX)");
});

test('path quoting: shell metacharacters (semicolons, dollar signs) are neutralised', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('# ');
  cdToCwd('/repo; rm -rf /');

  // The dangerous part is inside single-quotes — inert to the shell
  assert.strictEqual(pty.writes[0], "cd '/repo; rm -rf /'\n",
    'semicolons inside single-quoted string are not executed by the shell');
});
