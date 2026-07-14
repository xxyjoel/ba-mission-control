// tests/hookSettings.test.mjs — 0210: buildHookSettings() constructs the correct hooks block
//
// Pins the acceptance criteria for server/hookSettings.mjs (task 0211).
// That module does not exist yet — these tests MUST fail until 0211 ships.
//
// Contract:
//   buildHookSettings({ emitterPath }) — pure, returns a plain object whose
//   `hooks` key wires Notification, PreToolUse, and Stop events to the emitter.
//   The command invokes node + the absolute emitter path in argv form (no shell
//   string interpolation). A short timeout is set. The returned object carries
//   NO per-session fields — it is constant given emitterPath.
//
// Claude Code hook settings shape:
//   { hooks: { <EventName>: [ { hooks: [ { type: "command", command: "...", timeout?: N } ] } ] } }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHookSettings } from '../server/hookSettings.mjs';

// A realistic absolute path for a hook emitter script.
const EMITTER_PATH = '/home/user/.local/share/ba-mission-control/hooks/emit-status.mjs';

// ── shape: top-level structure ─────────────────────────────────────────────────

test('0210: buildHookSettings returns a plain object with a hooks key', () => {
  const result = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(result !== null && typeof result === 'object', 'result must be a plain object');
  assert.ok(!Array.isArray(result), 'result must not be an array');
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'hooks'), 'result must have a hooks key');
  assert.ok(result.hooks !== null && typeof result.hooks === 'object', 'hooks must be an object');
});

// ── event wiring: all three events must be present ────────────────────────────

test('0210: hooks block contains a Notification entry', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(
    Object.prototype.hasOwnProperty.call(hooks, 'Notification'),
    'hooks must have a Notification key',
  );
  assert.ok(Array.isArray(hooks.Notification), 'hooks.Notification must be an array');
  assert.ok(hooks.Notification.length >= 1, 'hooks.Notification must have at least one entry');
});

test('0210: hooks block contains a PreToolUse entry', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(
    Object.prototype.hasOwnProperty.call(hooks, 'PreToolUse'),
    'hooks must have a PreToolUse key',
  );
  assert.ok(Array.isArray(hooks.PreToolUse), 'hooks.PreToolUse must be an array');
  assert.ok(hooks.PreToolUse.length >= 1, 'hooks.PreToolUse must have at least one entry');
});

test('hooks block contains a UserPromptSubmit entry (turn-start → working)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(
    Object.prototype.hasOwnProperty.call(hooks, 'UserPromptSubmit'),
    'hooks must have a UserPromptSubmit key',
  );
  assert.ok(Array.isArray(hooks.UserPromptSubmit), 'hooks.UserPromptSubmit must be an array');
  assert.ok(hooks.UserPromptSubmit.length >= 1, 'hooks.UserPromptSubmit must have at least one entry');
});

test('0210: hooks block contains a Stop entry', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(
    Object.prototype.hasOwnProperty.call(hooks, 'Stop'),
    'hooks must have a Stop key',
  );
  assert.ok(Array.isArray(hooks.Stop), 'hooks.Stop must be an array');
  assert.ok(hooks.Stop.length >= 1, 'hooks.Stop must have at least one entry');
});

// ── each hook entry must contain a type:"command" sub-hook ────────────────────

function extractCommandHooks(eventArray) {
  // Each top-level array entry is a hook group: { matcher?, hooks: [...] }
  // Flatten all inner hooks from all groups.
  return eventArray.flatMap((group) => {
    assert.ok(
      Array.isArray(group.hooks),
      `each entry in the event array must have a 'hooks' array — got: ${JSON.stringify(group)}`,
    );
    return group.hooks;
  });
}

test('0210: Notification hook group wires a type:"command" hook', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const cmds = extractCommandHooks(hooks.Notification);
  const commandHook = cmds.find((h) => h.type === 'command');
  assert.ok(commandHook !== undefined, 'Notification must have a hook with type:"command"');
});

test('0210: PreToolUse hook group wires a type:"command" hook', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const cmds = extractCommandHooks(hooks.PreToolUse);
  const commandHook = cmds.find((h) => h.type === 'command');
  assert.ok(commandHook !== undefined, 'PreToolUse must have a hook with type:"command"');
});

test('0210: Stop hook group wires a type:"command" hook', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const cmds = extractCommandHooks(hooks.Stop);
  const commandHook = cmds.find((h) => h.type === 'command');
  assert.ok(commandHook !== undefined, 'Stop must have a hook with type:"command"');
});

// ── emitter path: command must reference the absolute emitterPath ─────────────

function findCommandHook(hooks, event) {
  const cmds = hooks[event].flatMap((group) => group.hooks);
  return cmds.find((h) => h.type === 'command');
}

test('0210: Notification command contains the absolute emitterPath', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Notification');
  assert.ok(
    typeof hook.command === 'string' && hook.command.includes(EMITTER_PATH),
    `Notification command must contain the emitterPath — got: ${JSON.stringify(hook.command)}`,
  );
});

test('0210: PreToolUse command contains the absolute emitterPath', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'PreToolUse');
  assert.ok(
    typeof hook.command === 'string' && hook.command.includes(EMITTER_PATH),
    `PreToolUse command must contain the emitterPath — got: ${JSON.stringify(hook.command)}`,
  );
});

test('0210: Stop command contains the absolute emitterPath', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Stop');
  assert.ok(
    typeof hook.command === 'string' && hook.command.includes(EMITTER_PATH),
    `Stop command must contain the emitterPath — got: ${JSON.stringify(hook.command)}`,
  );
});

// ── node invocation: command must invoke via node, not a bare emitter call ────

test('0210: Notification command invokes node (references "node" binary)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Notification');
  // The command string must reference node — either "node " prefix or process.execPath.
  // It must never just be the bare script path (that would require the file to be executable).
  const cmd = hook.command;
  assert.ok(
    /\bnode\b/.test(cmd) || cmd.includes('/node'),
    `Notification command must invoke via node — got: ${JSON.stringify(cmd)}`,
  );
});

test('0210: PreToolUse command invokes node (references "node" binary)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'PreToolUse');
  const cmd = hook.command;
  assert.ok(
    /\bnode\b/.test(cmd) || cmd.includes('/node'),
    `PreToolUse command must invoke via node — got: ${JSON.stringify(cmd)}`,
  );
});

test('0210: Stop command invokes node (references "node" binary)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Stop');
  const cmd = hook.command;
  assert.ok(
    /\bnode\b/.test(cmd) || cmd.includes('/node'),
    `Stop command must invoke via node — got: ${JSON.stringify(cmd)}`,
  );
});

// ── no shell metacharacter injection: emitterPath appears as-is ───────────────
//
// The emitterPath is an absolute path supplied by MC (not user input), but
// the invariant still holds: the emitterPath must appear verbatim in the
// command, not transformed through shell escaping or interpolated with other
// untrusted values like cwd or sessionId.

test('0210: emitterPath appears verbatim in the Notification command (no shell rewriting)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Notification');
  // The raw emitterPath string must appear literally — not URL-encoded, quoted
  // with shell metacharacters changed, or combined with `&&` / `;` / `${}`.
  assert.ok(
    hook.command.includes(EMITTER_PATH),
    `emitterPath must appear verbatim in command — got: ${JSON.stringify(hook.command)}`,
  );
  // Guard: no shell injection metacharacters surrounding the path.
  // Specifically, the command must NOT embed the sessionId (which would require
  // per-session shell interpolation). The session_id reaches the emitter via stdin.
  assert.ok(
    !hook.command.includes('${'),
    `command must not use shell variable interpolation — got: ${JSON.stringify(hook.command)}`,
  );
  assert.ok(
    !hook.command.includes('&&') && !hook.command.includes(';'),
    `command must not chain shell commands — got: ${JSON.stringify(hook.command)}`,
  );
});

// ── timeout: must be present and small (1–5 seconds) ─────────────────────────

test('0210: Notification command hook has a timeout field', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Notification');
  assert.ok(
    Object.prototype.hasOwnProperty.call(hook, 'timeout'),
    'Notification command hook must have a timeout field',
  );
});

test('0210: PreToolUse command hook has a timeout field', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'PreToolUse');
  assert.ok(
    Object.prototype.hasOwnProperty.call(hook, 'timeout'),
    'PreToolUse command hook must have a timeout field',
  );
});

test('0210: Stop command hook has a timeout field', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Stop');
  assert.ok(
    Object.prototype.hasOwnProperty.call(hook, 'timeout'),
    'Stop command hook must have a timeout field',
  );
});

test('0210: Notification timeout is a number between 1 and 5 (seconds)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Notification');
  const t = hook.timeout;
  assert.ok(typeof t === 'number', `timeout must be a number — got: ${typeof t}`);
  assert.ok(t >= 1 && t <= 5, `timeout must be 1–5s (inclusive) — got: ${t}`);
});

test('0210: PreToolUse timeout is a number between 1 and 5 (seconds)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'PreToolUse');
  const t = hook.timeout;
  assert.ok(typeof t === 'number', `timeout must be a number — got: ${typeof t}`);
  assert.ok(t >= 1 && t <= 5, `timeout must be 1–5s (inclusive) — got: ${t}`);
});

test('0210: Stop timeout is a number between 1 and 5 (seconds)', () => {
  const { hooks } = buildHookSettings({ emitterPath: EMITTER_PATH });
  const hook = findCommandHook(hooks, 'Stop');
  const t = hook.timeout;
  assert.ok(typeof t === 'number', `timeout must be a number — got: ${typeof t}`);
  assert.ok(t >= 1 && t <= 5, `timeout must be 1–5s (inclusive) — got: ${t}`);
});

// ── purity and determinism ────────────────────────────────────────────────────

test('0210: same emitterPath always returns a deep-equal object (pure/deterministic)', () => {
  const a = buildHookSettings({ emitterPath: EMITTER_PATH });
  const b = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.deepStrictEqual(a, b, 'same emitterPath must produce deep-equal output');
});

test('0210: different emitterPaths produce different command strings', () => {
  const PATH_B = '/opt/other/emit-status.mjs';
  const a = buildHookSettings({ emitterPath: EMITTER_PATH });
  const b = buildHookSettings({ emitterPath: PATH_B });
  const cmdA = findCommandHook(a.hooks, 'Stop').command;
  const cmdB = findCommandHook(b.hooks, 'Stop').command;
  assert.notEqual(cmdA, cmdB, 'different emitter paths must produce different command strings');
  assert.ok(cmdB.includes(PATH_B), `command for PATH_B must contain PATH_B — got: ${cmdB}`);
});

// ── no per-session fields: object must be constant given emitterPath ──────────
//
// The settings object is injected once at spawn time and shared across restarts
// of the same slot. It must contain NO runtime state (no sessionId, no cwd,
// no timestamp) — the session_id reaches the emitter via hook stdin only.

test('0210: returned object contains no sessionId field at any level', () => {
  const result = buildHookSettings({ emitterPath: EMITTER_PATH });
  const serialized = JSON.stringify(result);
  // sessionId should not appear embedded as a value anywhere in the object.
  // (We can only assert the fixture path does not look like a UUID pattern;
  //  a real UUID in the command would indicate per-session injection.)
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.ok(
    !uuidPattern.test(serialized),
    `settings object must not contain a sessionId UUID — found one in: ${serialized}`,
  );
});

test('0210: returned object does not contain a sessionId property at the top level', () => {
  const result = buildHookSettings({ emitterPath: EMITTER_PATH });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result, 'sessionId'),
    'top-level result must not have a sessionId property',
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result, 'session_id'),
    'top-level result must not have a session_id property',
  );
});
