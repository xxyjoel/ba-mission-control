// tests/server/shellSession.injection.test.mjs — pins 0326 AC#2: malicious cwd
// cannot inject a second command via the cd path argument.
//
// Acceptance:
//   A malicious cwd (e.g. `/tmp/a'; touch PWNED`) cannot break out of the
//   single-quoted `cd` argument — the POSIX single-quote escape must produce
//   exactly ONE pty.write() whose value is a safely-quoted literal string.
//
// These tests exercise the POSIX escape path of cdToCwd() committed in 0311
// and cleared by the security review in 0322 (overlay-terminal.md §4).
// They are retroactive paired tests (impl pre-exists and passes review).
//
// Reuses the same stub pattern as shellSession.cd.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, cdToCwd, _resetForTest } from '../../server/shellSession.mjs';

// makeStubSpawn — records every pty.write() call so tests can inspect the
// exact bytes the shell receives. Mirrors the stub in shellSession.cd.test.mjs.
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

// Reset singleton between tests so state doesn't bleed.
test.beforeEach(() => _resetForTest());
test.afterEach(() => _resetForTest());

// --- Core injection scenario from the How-sketch ---

test('injection: semicolon-terminated path cannot execute a second command', () => {
  // Adversarial cwd: /tmp/a'; touch PWNED
  // Naïve unquoted cd /tmp/a'; touch PWNED would run two commands.
  // POSIX-escaped: cd '/tmp/a'\'; touch PWNED'
  // which evaluates to the literal path /tmp/a'; touch PWNED — one argument.
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  const result = cdToCwd("/tmp/a'; touch PWNED");

  assert.strictEqual(result, true, 'cdToCwd returns true (cd was emitted)');
  assert.strictEqual(pty.writes.length, 1,
    'exactly ONE write — the semicolon did not split into two commands');
  assert.strictEqual(pty.writes[0], "cd '/tmp/a'\\''; touch PWNED'\n",
    "the single-quote escape neutralises the ; so touch PWNED is a literal, not a command");
});

// --- Additional injection vectors ---

test('injection: path with $() subshell expression is neutralised', () => {
  // cwd crafted to expand a subshell: /proj/$(id)
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('% ');
  cdToCwd('/proj/$(id)');

  // Inside single quotes $() is literal — no expansion.
  assert.strictEqual(pty.writes[0], "cd '/proj/$(id)'\n",
    'dollar-paren subshell expansion is suppressed inside single quotes');
});

test('injection: path with backtick command substitution is neutralised', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd('/proj/`id`');

  // Backtick substitution is literal inside single quotes.
  assert.strictEqual(pty.writes[0], "cd '/proj/`id`'\n",
    'backtick command substitution is suppressed inside single quotes');
});

test('injection: path with pipe operator is neutralised', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('# ');
  cdToCwd('/tmp/a | cat /etc/passwd');

  assert.strictEqual(pty.writes[0], "cd '/tmp/a | cat /etc/passwd'\n",
    'pipe operator inside single-quoted string is not executed by the shell');
});

test('injection: newline character in path is neutralised', () => {
  // A newline inside the cd argument would terminate the current command and
  // begin a new one. Single quoting includes the literal newline.
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd("/tmp/dir\nrm -rf /");

  // The newline is enclosed in single quotes — the shell receives a literal
  // multi-line string argument, not two separate commands.
  assert.strictEqual(pty.writes[0], "cd '/tmp/dir\nrm -rf /'\n",
    'embedded newline is quoted, not treated as command terminator');
  assert.strictEqual(pty.writes.length, 1, 'only one write — no split commands');
});

test('injection: double-ampersand chaining is neutralised', () => {
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd('/tmp/a && touch PWNED');

  assert.strictEqual(pty.writes[0], "cd '/tmp/a && touch PWNED'\n",
    '&& operator inside single-quoted string is literal, not a chaining operator');
});

test('injection: embedded single-quote in malicious path is escaped, not a breakout', () => {
  // Path: /tmp/x'; rm -rf /
  // This is the most dangerous case: the embedded ' could close the single-quote
  // and let '; rm -rf / execute as a command.
  // POSIX escape: /tmp/x → '/tmp/x'\'' ; rm -rf /' → still a single cd argument.
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  const result = cdToCwd("/tmp/x'; rm -rf /");

  assert.strictEqual(result, true, 'cdToCwd returns true');
  assert.strictEqual(pty.writes.length, 1, 'single write — no command breakout');
  assert.strictEqual(pty.writes[0], "cd '/tmp/x'\\''; rm -rf /'\n",
    "embedded single quote is escaped as '\\'' (POSIX), preventing breakout");
});

test('injection: combined metacharacters in one path are all neutralised', () => {
  // A maximally adversarial path combining several metacharacters.
  const stub = makeStubSpawn();
  getShellSession({ spawn: stub });
  const pty = stub.calls[0];

  pty.fireData('$ ');
  cdToCwd('/tmp/$(id); touch $HOME/.ssh/authorized_keys');

  assert.strictEqual(pty.writes.length, 1,
    'all metacharacters in single write — no multiple commands');
  // $, (, ), ;, space are all literal inside single quotes
  assert.strictEqual(pty.writes[0],
    "cd '/tmp/$(id); touch $HOME/.ssh/authorized_keys'\n",
    'combined metacharacters are all neutralised by single-quoting');
});
