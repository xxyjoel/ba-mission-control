// tests/server/shellSession.spawnfail.test.mjs — the shell overlay must never
// crash the whole TUI when the PTY can't spawn (posix_spawnp failed). 0343.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, killShellSession, cdToCwd } from '../../server/shellSession.mjs';

function fakePty() {
  return { pid: 4242, onData() { return { dispose() {} }; }, write() {}, kill() {}, resize() {} };
}

test('getShellSession returns a degraded session (no throw) when spawn fails', () => {
  killShellSession();
  const throwingSpawn = () => { throw new Error('posix_spawnp failed.'); };
  let session;
  assert.doesNotThrow(() => { session = getShellSession({ spawn: throwingSpawn }); });
  assert.equal(session.pty, null);
  assert.equal(session.term, null);
  assert.match(session.error, /shell failed to start/);
  assert.match(session.error, /posix_spawnp failed/);
  killShellSession();
});

test('a degraded session is safe to cd + kill (no throw on null pty)', () => {
  killShellSession();
  const session = getShellSession({ spawn: () => { throw new Error('boom'); } });
  assert.equal(session.pty, null);
  assert.doesNotThrow(() => cdToCwd('/tmp'));      // returns false, never touches pty
  assert.equal(cdToCwd('/tmp'), false);
  assert.doesNotThrow(() => killShellSession());   // null-safe teardown
});

test('a successful spawn yields a live session with error=null', () => {
  killShellSession();
  const session = getShellSession({ spawn: fakePty });
  assert.ok(session.pty);
  assert.equal(session.error, null);
  assert.equal(session.pty.pid, 4242);
  killShellSession();
});
