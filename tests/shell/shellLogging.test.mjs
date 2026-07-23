// tests/shell/shellLogging.test.mjs — pins 0321 acceptance criteria.
//
// Acceptance:
//   1. dlog('shell', ...) fires on spawn, cd-issued, and kill with pid/cwd context.
//   2. No secrets or full env are logged (only shell path, pid, cwd/dir).
//
// Approach: dlog is a named ESM import inside shellSession.mjs (not stubbable
// cleanly), and the point of a logging task is to verify the REAL redaction, so
// we exercise the real dlog end-to-end: set MC_DEBUG=1, point XDG_STATE_HOME at
// a throwaway temp dir, run the lifecycle, then read debug.log and assert the
// emitted records. The overlay open/close (overlay-attach/detach) events live in
// ShellOverlay.jsx and are covered by 0334 (needs Ink render) — not duplicated here.
//
// node-pty is stubbed via the `spawn` injection seam (same makeStubSpawn as
// shellSession.cd.test.mjs); fireData() drives atFreshPrompt so cdToCwd emits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getShellSession,
  cdToCwd,
  killShellSession,
  _resetForTest,
} from '../../server/shellSession.mjs';

// makeStubSpawn — stub node-pty spawn: PTYs capture onData handlers, record
// write()s, and expose fireData() to simulate output that drives atFreshPrompt.
// Mirrors shellSession.cd.test.mjs so prompt-gated cd behaviour is identical.
function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const writes = [];
    const pty = {
      pid: 9300 + calls.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write(data) { writes.push(data); },
      kill() {},
      resize() {},
      writes,
      fireData(chunk) { for (const fn of dataHandlers) fn(chunk); },
    };
    calls.push(pty);
    return pty;
  };
  stub.calls = calls;
  return stub;
}

// Read every JSON record from the temp debug.log (one object per line).
function readRecords() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// One stable temp XDG_STATE_HOME for the whole file. debugLog.js caches a
// module-level `dirReady` flag after its first mkdirSync, so we must NOT delete
// and recreate the directory per test (that would strand dlog writing to a
// vanished path). Instead we keep the dir stable and truncate the log between
// tests. Env is set at module load — before the first getShellSession() spawn
// dlog can fire.
const stateDir = mkdtempSync(join(tmpdir(), 'mc-shelllog-'));
const logPath = join(stateDir, 'claude-mc', 'debug.log');
const savedEnv = {
  MC_DEBUG: process.env.MC_DEBUG,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  SHELL: process.env.SHELL,
  FAKE_SECRET: process.env.FAKE_SECRET,
};
const SENTINEL = 'SUPER_SECRET_TOKEN_do_not_log_me_42';

process.env.MC_DEBUG = '1';
process.env.XDG_STATE_HOME = stateDir;
process.env.SHELL = '/bin/zsh';
// Sentinel secret in the inherited env — must never surface in the log.
process.env.FAKE_SECRET = SENTINEL;

test.beforeEach(() => {
  _resetForTest();
  // Truncate the shared log so each test reads only its own records.
  if (existsSync(logPath)) writeFileSync(logPath, '');
});

test.afterEach(() => {
  _resetForTest();
});

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

test('spawn emits dlog shell/spawn with pid, shell, cwd', () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });

  const recs = readRecords();
  const spawn = recs.find((r) => r.scope === 'shell' && r.msg === 'spawn');

  assert.ok(spawn, 'a shell/spawn record was written');
  assert.strictEqual(spawn.pid, session.pty.pid, 'pid matches the spawned PTY');
  assert.strictEqual(spawn.shell, '/bin/zsh', 'shell binary path logged');
  assert.ok(typeof spawn.cwd === 'string' && spawn.cwd.length > 0, 'cwd logged');
});

test('cd emits dlog shell/cd with pid and dir when at a fresh prompt', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];
  pty.fireData('~ % '); // prompt suffix → atFreshPrompt = true

  const ok = cdToCwd('/repo/foo');
  assert.strictEqual(ok, true, 'cd was emitted');

  const cd = readRecords().find((r) => r.scope === 'shell' && r.msg === 'cd');
  assert.ok(cd, 'a shell/cd record was written');
  assert.strictEqual(cd.pid, pty.pid, 'pid matches the PTY');
  assert.strictEqual(cd.dir, '/repo/foo', 'target dir logged');
  assert.strictEqual(cd.emitted, true, 'emitted flag recorded');
});

test('kill emits dlog shell/kill with pid', () => {
  const stub = makeStubSpawn();
  const session = getShellSession({ spawn: stub });
  const pid = session.pty.pid;

  killShellSession();

  const kill = readRecords().find((r) => r.scope === 'shell' && r.msg === 'kill');
  assert.ok(kill, 'a shell/kill record was written');
  assert.strictEqual(kill.pid, pid, 'pid of the killed PTY logged');
});

test('spawn, cd, and kill all fire in one lifecycle', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  stub.calls[0].fireData('$ ');
  cdToCwd('/repo');
  killShellSession();

  const msgs = readRecords()
    .filter((r) => r.scope === 'shell')
    .map((r) => r.msg);
  for (const expected of ['spawn', 'cd', 'kill']) {
    assert.ok(msgs.includes(expected), `shell/${expected} was logged`);
  }
});

test('redaction: no env sentinel secret ever reaches the log (acceptance #2)', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  stub.calls[0].fireData('$ ');
  cdToCwd('/repo');
  killShellSession();

  const p = join(stateDir, 'claude-mc', 'debug.log');
  const raw = readFileSync(p, 'utf8');
  assert.ok(
    !raw.includes(SENTINEL),
    'the inherited-env sentinel secret must never appear anywhere in the log',
  );
});

test('redaction: spawn record carries no full-env blob (no env key)', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });

  const spawn = readRecords().find((r) => r.scope === 'shell' && r.msg === 'spawn');
  assert.ok(spawn, 'spawn record present');
  assert.ok(!('env' in spawn), 'spawn record must not log the process env');
  // Only the whitelisted lifecycle fields — no keystroke buffer, no env.
  const allowed = new Set(['t', 'scope', 'msg', 'pid', 'shell', 'cwd', 'cols', 'rows', 'scrollback']);
  for (const k of Object.keys(spawn)) {
    assert.ok(allowed.has(k), `unexpected field "${k}" in spawn record (possible leak)`);
  }
});
