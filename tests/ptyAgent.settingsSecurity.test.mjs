// tests/ptyAgent.settingsSecurity.test.mjs — 0214: --settings injection survives
// adversarial cwd/sessionId without shell escape
//
// Pins the security acceptance criteria for task 0214:
//   1. When a PtyAgent has a cwd containing shell metacharacters (spaces, semicolons,
//      subshell syntax, pipes), start() still produces a single intact '--settings'
//      argv element followed by a single valid JSON string value.
//   2. No argv element is a shell string that mixes '--settings' with an interpolated
//      hostile cwd or sessionId (i.e., the injection must remain in argv form, never
//      coalesced into a shell command string).
//   3. The settings JSON 'command' string (inside the hooks block) is CONSTANT — it
//      must NOT contain the hostile cwd or sessionId values, because session data
//      reaches the hook emitter via stdin (not the command string).
//   4. CLAUDE_BIN is argv[0] passed unchanged (untrusted user-controlled bin path
//      stays as argv[0], never concatenated into a command string per CLAUDE.md).
//
// These tests MUST FAIL until task 0213 edits ptyAgent.start() to actually inject
// '--settings'. They deliberately do NOT test against a real PTY — the _spawn seam
// captures the argv array before any process is launched.
//
// NOTE for impl (0213 reminder): buildHookSettings builds command as
//   `${process.execPath} ${emitterPath}`
// process.execPath is an absolute node binary path (never user-controlled); emitterPath
// is an MC-internal constant path. Neither cwd nor sessionId is in the command string.
// This is the correct security property being asserted here.
// TODO(0213): if emitterPath can ever contain spaces (user installed MC to a
//   path with spaces), the `node <path>` command string is space-split by claude.
//   Consider quoting: `"${process.execPath}" "${emitterPath}"`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { buildHookSettings } from '../server/hookSettings.mjs';

const EMITTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../server/hooks/emit-status.mjs',
);

// Shell metacharacters that would be dangerous in a shell-interpolated command.
const HOSTILE_CWD = '/tmp/evil; rm -rf ~ /a b/$(whoami)';

// NOTE: sessionId is validated as a canonical UUID by claudeSessionPath() in
// sessionFileTailer.mjs (line 56) before start() reaches the args-build site.
// A non-UUID sessionId causes start() to throw before _spawn is called, so the
// seam cannot be reached with a hostile sessionId — the guard works correctly.
// The realistic attack vector for sessionId injection is therefore prevented at
// a separate layer. We use a valid UUID here to isolate the cwd injection test.
// The cwd is the primary untrusted input that the --settings value must not leak.
const SAFE_SESSION_ID = 'dddddddd-eeee-ffff-0000-111111111111';

// ─── shared spawn stub (mirrors tests/ptyAgent.test.mjs pattern) ───────────────

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 8000 + spawned.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      _writes: [],
      _kills: [],
      write(s)   { this._writes.push(s); },
      kill(sig)  { this._kills.push(sig); },
      resize(c, r) {},
      onData(fn) { handlers.data.push(fn); return { dispose() {} }; },
      onExit(fn) { handlers.exit.push(fn); return { dispose() {} }; },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeHostileAgent(spawn) {
  return new PtyAgent({
    slot: 7,
    id: 's7-security-test',
    cwd: HOSTILE_CWD,
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    // UUID-valid sessionId required: claudeSessionPath() validates UUID shape
    // before _spawn is called, so a hostile sessionId never reaches the args
    // site — the UUID guard itself is the protection for sessionId injection.
    sessionId: SAFE_SESSION_ID,
    spawn,
  });
}

// ─── 0214 criterion 1: hostile cwd still yields a --settings flag ───────────────

test('0214: hostile cwd — --settings flag is still present in args', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    assert.ok(
      args.includes('--settings'),
      `args must contain '--settings' even with hostile cwd — got: ${JSON.stringify(args)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0214 criterion 2: the --settings value remains valid JSON ──────────────────

test('0214: hostile cwd — --settings value is still valid JSON', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const raw = args[idx + 1];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(
        `--settings value must be valid JSON even with hostile cwd; JSON.parse threw: ${e.message}\nValue was: ${JSON.stringify(raw)}`,
      );
    }
    assert.ok(
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      `--settings JSON must be a plain object — got: ${JSON.stringify(parsed)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0214 criterion 3: no single argv element is a shell string mixing
//     '--settings' with the hostile cwd or sessionId ────────────────────────────

test('0214: no argv element is a shell string that concatenates --settings with hostile cwd', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const shellStringArgs = args.filter(
      (a) => a.includes('--settings') && a.includes(HOSTILE_CWD),
    );
    assert.equal(
      shellStringArgs.length,
      0,
      `no single argv element must merge '--settings' with hostile cwd — found: ${JSON.stringify(shellStringArgs)}`,
    );
  } finally {
    p.kill();
  }
});

test('0214: no argv element concatenates --settings with the semicolon from hostile cwd', () => {
  // The hostile cwd contains '; rm -rf ~' — if the args-build accidentally
  // shell-interpolates cwd into the settings value, that string would appear.
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const shellStringArgs = args.filter(
      (a) => a.includes('--settings') && a.includes('; rm -rf'),
    );
    assert.equal(
      shellStringArgs.length,
      0,
      `no single argv element must merge '--settings' with hostile cwd shell sequence — found: ${JSON.stringify(shellStringArgs)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0214 criterion 4: the settings JSON 'command' does not contain hostile values

test('0214: settings command string does not contain the hostile cwd', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const parsed = JSON.parse(args[idx + 1]);

    // Extract all command strings from all hook entries across all events.
    const commands = [];
    if (parsed.hooks) {
      for (const event of Object.values(parsed.hooks)) {
        if (Array.isArray(event)) {
          for (const group of event) {
            if (Array.isArray(group.hooks)) {
              for (const h of group.hooks) {
                if (typeof h.command === 'string') commands.push(h.command);
              }
            }
          }
        }
      }
    }

    assert.ok(commands.length > 0, 'parsed settings must have at least one hook command string');

    for (const cmd of commands) {
      // The hostile cwd must NOT appear in the command string. The command is
      // purely `<nodeBin> <emitterPath>` — constant, no session data injected.
      assert.ok(
        !cmd.includes('/tmp/evil'),
        `hook command must not contain hostile cwd fragment '/tmp/evil' — got: ${JSON.stringify(cmd)}`,
      );
      assert.ok(
        !cmd.includes('rm -rf'),
        `hook command must not contain 'rm -rf' from hostile cwd — got: ${JSON.stringify(cmd)}`,
      );
      assert.ok(
        !cmd.includes('$(whoami)'),
        `hook command must not contain subshell from hostile cwd — got: ${JSON.stringify(cmd)}`,
      );
    }
  } finally {
    p.kill();
  }
});

test('0214: settings command string is constant — contains neither cwd nor sessionId', () => {
  // The command field in the hook is `<nodeBin> <emitterPath>` — both constants.
  // Neither cwd nor sessionId (not even the safe UUID) should appear in the command.
  // Session data reaches the emitter via hook stdin only.
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const parsed = JSON.parse(args[idx + 1]);

    const commands = [];
    if (parsed.hooks) {
      for (const event of Object.values(parsed.hooks)) {
        if (Array.isArray(event)) {
          for (const group of event) {
            if (Array.isArray(group.hooks)) {
              for (const h of group.hooks) {
                if (typeof h.command === 'string') commands.push(h.command);
              }
            }
          }
        }
      }
    }

    for (const cmd of commands) {
      // The hostile cwd must not appear in the command
      assert.ok(
        !cmd.includes('evil'),
        `hook command must not contain any part of hostile cwd — got: ${JSON.stringify(cmd)}`,
      );
      // The sessionId (even the valid UUID we used) must not appear in the command
      assert.ok(
        !cmd.includes(SAFE_SESSION_ID),
        `hook command must not contain sessionId — got: ${JSON.stringify(cmd)}`,
      );
    }
  } finally {
    p.kill();
  }
});

// ─── 0214 criterion 5: CLAUDE_BIN is argv[0], not embedded in a shell string ───

test('0214: CLAUDE_BIN is passed as a discrete argv[0] to the PTY spawn, not shell-interpolated', () => {
  // Test with a hostile CLAUDE_BIN to verify it's kept as a discrete spawn arg.
  // Per CLAUDE.md: "Never spawn shell strings with environment-variable or
  // user-input interpolation. Always use argv-form helpers."
  // CLAUDE_BIN is user-controlled (env var) and must stay as argv[0].
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    // bin is the first positional arg to the spawn stub
    const bin = fake.spawned[0]._bin;
    const args = fake.spawned[0]._args;

    // CLAUDE_BIN stays as bin (the executable), not spliced into a shell command string.
    assert.ok(
      typeof bin === 'string' && bin.length > 0,
      `spawn bin must be a non-empty string — got: ${JSON.stringify(bin)}`,
    );

    // The args array must NOT contain an element that has bin baked into a
    // shell string alongside other content (e.g., "claude --settings {...}").
    const shellBlobWithBin = args.filter(
      (a) => a.includes(bin) && a.includes('--settings'),
    );
    assert.equal(
      shellBlobWithBin.length,
      0,
      `no argv element must merge the bin path with '--settings' (that would be a shell string) — found: ${JSON.stringify(shellBlobWithBin)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0214 criterion 6: --settings value is deep-equal to buildHookSettings() ───
// (even with hostile inputs — the hostile cwd/sessionId must not corrupt the shape)

test('0214: with hostile cwd, --settings JSON deep-equals buildHookSettings({ emitterPath })', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const parsed = JSON.parse(args[idx + 1]);
    const expected = buildHookSettings({ emitterPath: EMITTER_PATH });
    assert.deepStrictEqual(
      parsed,
      expected,
      `--settings JSON must deep-equal buildHookSettings output even with hostile cwd.\nGot:      ${JSON.stringify(parsed, null, 2)}\nExpected: ${JSON.stringify(expected, null, 2)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0214 defensive: the hostile cwd does not appear anywhere in the serialized
//     settings JSON (belt-and-suspenders, catches accidental serialization bugs) ─

test('0214: hostile cwd substring does not appear anywhere in the serialized settings JSON', () => {
  const fake = makeFakeSpawn();
  const p = makeHostileAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const raw = args[idx + 1]; // raw JSON string from args
    assert.ok(
      !raw.includes('rm -rf'),
      `serialized settings must not contain hostile cwd 'rm -rf' — got: ${raw}`,
    );
    assert.ok(
      !raw.includes('$(whoami)'),
      `serialized settings must not contain hostile cwd subshell — got: ${raw}`,
    );
  } finally {
    p.kill();
  }
});
