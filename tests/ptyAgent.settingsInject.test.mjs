// tests/ptyAgent.settingsInject.test.mjs — 0212: PtyAgent.start() injects --settings argv-safely
//
// Pins the acceptance criteria for task 0212:
//   1. After start(), captured args contain '--settings' followed immediately by
//      a plain string that JSON.parses to an object deep-equal to
//      buildHookSettings({ emitterPath }) for the agent's emitter path.
//   2. '--settings' and its value are TWO SEPARATE argv elements (not a single
//      concatenated string, not a shell-quoted single blob).
//   3. Existing args (--session-id/--resume, --model, --permission-mode, --add-dir)
//      are still present and unbroken after --settings is added.
//
// These tests MUST FAIL until task 0213 edits ptyAgent.start() to push the
// '--settings' + JSON.stringify(settingsObject) pair before calling _spawn.
//
// NOTE for impl (0213 reminder): buildHookSettings() builds the command string as
//   `${process.execPath} ${emitterPath}`
// If emitterPath contains spaces (e.g. a user installed MC to a path with spaces),
// the space-split `node <path>` form will cause claude to misparse the command.
// TODO(0213): consider quoting emitterPath in the command string to handle
//   install paths with spaces — e.g. `"${process.execPath}" "${emitterPath}"`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { buildHookSettings } from '../server/hookSettings.mjs';

// Absolute path to the hook emitter script (same path impl 0213 will use).
const EMITTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../server/hooks/emit-status.mjs',
);

// ─── shared spawn stub (mirrors tests/ptyAgent.test.mjs pattern) ───────────────

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 9000 + spawned.length,
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

function makeAgent(spawn, overrides = {}) {
  return new PtyAgent({
    slot: 3,
    id: 's3-inject-test',
    cwd: '/tmp/safe-cwd',
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'cccccccc-dddd-eeee-ffff-000000000001',
    spawn,
    ...overrides,
  });
}

// ─── 0212 criterion 1: --settings is present in args ───────────────────────────

test('0212: start() args include the --settings flag', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    assert.ok(
      args.includes('--settings'),
      `args must contain '--settings' — got: ${JSON.stringify(args)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0212 criterion 2: --settings value is a separate element, valid JSON ───────

test('0212: --settings value is the NEXT element (two distinct argv entries)', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    // The next element must exist and be a string — not --settings itself
    assert.ok(
      idx + 1 < args.length,
      '--settings must be followed by a value element; args ended immediately after it',
    );
    const value = args[idx + 1];
    assert.ok(
      typeof value === 'string',
      `the element after '--settings' must be a string — got ${typeof value}: ${JSON.stringify(value)}`,
    );
    // It must not start with '--' (which would mean the value was omitted and
    // the next flag was consumed, e.g. --settings --model)
    assert.ok(
      !value.startsWith('--'),
      `the element after '--settings' looks like a flag, not a value: ${JSON.stringify(value)}`,
    );
  } finally {
    p.kill();
  }
});

test('0212: --settings value is valid JSON (parseable)', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
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
        `--settings value must be valid JSON; JSON.parse threw: ${e.message}\nValue was: ${JSON.stringify(raw)}`,
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

// ─── 0212 criterion 3: --settings value is deep-equal to buildHookSettings() ──

test('0212: --settings JSON deep-equals buildHookSettings({ emitterPath })', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
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
      `--settings JSON must deep-equal buildHookSettings output.\nGot:      ${JSON.stringify(parsed, null, 2)}\nExpected: ${JSON.stringify(expected, null, 2)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0212 criterion 4: no single arg concatenates '--settings' with the value ──

test('0212: no single argv element contains both "--settings" and the JSON blob', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const concatenated = args.filter(
      (a) => a.includes('--settings') && a.includes('{'),
    );
    assert.equal(
      concatenated.length,
      0,
      `no single arg must concatenate --settings with the JSON value — found: ${JSON.stringify(concatenated)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0212 criterion 5: pre-existing args are unbroken ──────────────────────────

test('0212: existing --session-id arg is still present after --settings injection', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    assert.ok(
      args.includes('--session-id') || args.includes('--resume'),
      `args must still contain --session-id or --resume — got: ${JSON.stringify(args)}`,
    );
  } finally {
    p.kill();
  }
});

test('0212: existing --model arg is still present after --settings injection', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    assert.ok(
      args.includes('--model'),
      `args must still contain --model — got: ${JSON.stringify(args)}`,
    );
  } finally {
    p.kill();
  }
});

test('0212: existing --add-dir arg is still present after --settings injection', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    assert.ok(
      args.includes('--add-dir'),
      `args must still contain --add-dir — got: ${JSON.stringify(args)}`,
    );
  } finally {
    p.kill();
  }
});

test('0212: --session-id value immediately follows --session-id flag (not corrupted by --settings)', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake, { sessionId: 'cccccccc-dddd-eeee-ffff-000000000002' });
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const sidIdx = args.indexOf('--session-id');
    if (sidIdx === -1) return; // using --resume path; skip this check
    const sidValue = args[sidIdx + 1];
    assert.ok(
      typeof sidValue === 'string' && !sidValue.startsWith('--'),
      `element after --session-id must be the session id value, not another flag — got: ${JSON.stringify(sidValue)}`,
    );
  } finally {
    p.kill();
  }
});

// ─── 0212 criterion 6: hooks block carries all 3 events ─────────────────────────

test('0212: --settings JSON has hooks.Notification, PreToolUse, and Stop', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  try {
    const args = fake.spawned[0]._args;
    const idx = args.indexOf('--settings');
    assert.ok(idx !== -1, '--settings must be present in args');
    const parsed = JSON.parse(args[idx + 1]);
    assert.ok(parsed.hooks, '--settings JSON must have a hooks key');
    assert.ok(
      Array.isArray(parsed.hooks.Notification) && parsed.hooks.Notification.length > 0,
      `hooks.Notification must be a non-empty array — got: ${JSON.stringify(parsed.hooks.Notification)}`,
    );
    assert.ok(
      Array.isArray(parsed.hooks.PreToolUse) && parsed.hooks.PreToolUse.length > 0,
      `hooks.PreToolUse must be a non-empty array — got: ${JSON.stringify(parsed.hooks.PreToolUse)}`,
    );
    assert.ok(
      Array.isArray(parsed.hooks.Stop) && parsed.hooks.Stop.length > 0,
      `hooks.Stop must be a non-empty array — got: ${JSON.stringify(parsed.hooks.Stop)}`,
    );
  } finally {
    p.kill();
  }
});
