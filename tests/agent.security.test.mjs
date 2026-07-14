// tests/agent.security.test.mjs — 0110: CLAUDE_BIN is user-controlled and must
// be spawned via argv (execFile/spawn positional form), never interpolated into
// a shell string. A hostile CLAUDE_BIN like '/x; echo PWNED' must be treated as
// a single literal binary path (that won't exist), NOT split and run by a shell.
//
// Pins the CLAUDE.md rule: "Never spawn shell strings ... Always use argv-form
// helpers. CLAUDE_BIN is user-controlled — treat it as untrusted."

import { test } from 'node:test';
import assert from 'node:assert/strict';

// CLAUDE_BIN is read at module-load in ptyAgent.mjs, so set the hostile value
// BEFORE importing — hence the dynamic import. PtyAgent is the live agent and
// exposes an injectable spawn, so we can capture exactly how claude is invoked.
const HOSTILE = '/tmp/no-such-claude; echo PWNED';
process.env.CLAUDE_BIN = HOSTILE;
const { PtyAgent } = await import('../server/ptyAgent.mjs');

function fakePty() {
  return {
    pid: 1, write() {}, kill() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  };
}

test('CLAUDE_BIN is passed as argv[0], never shell-interpolated (0110)', () => {
  const calls = [];
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return fakePty(); };
  const a = new PtyAgent({
    slot: 1, id: 's1', cwd: '/tmp', model: 'sonnet-4.6', name: 't',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', spawn,
  });
  a.start();

  assert.equal(calls.length, 1, 'spawned exactly once');
  const { bin, args, opts } = calls[0];
  // The hostile string is the LITERAL binary path — not split on ';' and not
  // handed to a shell. If it were shell-interpolated, bin would be a shell and
  // the payload would live in an args string.
  assert.equal(bin, HOSTILE, 'CLAUDE_BIN passed verbatim as the binary path');
  assert.ok(Array.isArray(args), 'args is an argv array, not a shell string');
  assert.notStrictEqual(opts?.shell, true, 'no shell:true option');
  // No element of argv is a shell that would execute the payload.
  assert.ok(!args.some((x) => /\b(sh|bash|zsh|-c)\b/.test(String(x))), 'no shell invocation in argv');

  a.kill?.();
});
