// tests/statusHookTailer.map.test.mjs
//
// Paired tests for tasks 0217, 0218, 0219 — pin mapEventToStatus (pure fn).
//
// Event shape (from emitter server/hooks/emit-status.mjs line 46-47):
//   { ts: <number>, session_id: <string>, event: <hook_event_name>, notification_type?: <string> }
//
// mapEventToStatus receives that record (or any superset); it must be a
// pure function with NO I/O or timers.  Impl will live in
// server/statusHookTailer.mjs (task 0220).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// This import MUST fail until task 0220 ships — that is expected.
import { mapEventToStatus } from '../server/statusHookTailer.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

// Minimal record shape the emitter produces for a PreToolUse line.
function preToolUseEvent(overrides = {}) {
  return {
    ts: Date.now(),
    session_id: 'c0ffee00-0217-0217-0217-c0ffee000217',
    event: 'PreToolUse',
    ...overrides,
  };
}

// Minimal record shape the emitter produces for a Notification line.
function notificationEvent(notification_type, overrides = {}) {
  return {
    ts: Date.now(),
    session_id: 'c0ffee00-0218-0218-0218-c0ffee000218',
    event: 'Notification',
    notification_type,
    ...overrides,
  };
}

// Minimal record shape the emitter produces for a Stop line.
function stopEvent(overrides = {}) {
  return {
    ts: Date.now(),
    session_id: 'c0ffee00-0219-0219-0219-c0ffee000219',
    event: 'Stop',
    ...overrides,
  };
}

// Minimal record shape the emitter produces for a UserPromptSubmit line.
function userPromptSubmitEvent(overrides = {}) {
  return {
    ts: Date.now(),
    session_id: 'c0ffee00-0217-0217-0217-c0ffee00u5ub',
    event: 'UserPromptSubmit',
    ...overrides,
  };
}

// ── UserPromptSubmit → 'working' (bridges the thinking/text-only turn start) ──

describe('UserPromptSubmit → working', () => {
  test('mapEventToStatus({event:"UserPromptSubmit"}) returns "working"', () => {
    assert.equal(mapEventToStatus(userPromptSubmitEvent()), 'working');
  });

  test('extra fields on UserPromptSubmit record do not break the mapping', () => {
    const result = mapEventToStatus(userPromptSubmitEvent({ prompt: 'do the thing', cwd: '/tmp' }));
    assert.equal(result, 'working');
  });
});

// ── 0217: PreToolUse → 'working' ─────────────────────────────────────────────

describe('0217: PreToolUse → working', () => {
  test('mapEventToStatus({event:"PreToolUse"}) returns "working"', () => {
    const result = mapEventToStatus(preToolUseEvent());
    assert.equal(result, 'working');
  });

  test('extra fields on PreToolUse record do not break the mapping', () => {
    // The real record includes tool_name, tool_input, tool_use_id, etc.
    const result = mapEventToStatus(preToolUseEvent({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.txt', content: 'hi' },
      tool_use_id: 'toolu_abc123',
      permission_mode: 'default',
      effort: { level: 'high' },
    }));
    assert.equal(result, 'working');
  });
});

// ── 0218: Notification:permission_prompt → 'waiting' ─────────────────────────

describe('0218: Notification:permission_prompt → waiting', () => {
  test('mapEventToStatus({event:"Notification", notification_type:"permission_prompt"}) returns "waiting"', () => {
    const result = mapEventToStatus(notificationEvent('permission_prompt'));
    assert.equal(result, 'waiting');
  });

  test('Notification with unknown notification_type does NOT return "waiting"', () => {
    const result = mapEventToStatus(notificationEvent('some_future_type'));
    assert.notEqual(result, 'waiting',
      'an unrecognised notification_type must not map to "waiting"');
  });

  test('Notification with absent notification_type does NOT return "waiting"', () => {
    const record = {
      ts: Date.now(),
      session_id: 'c0ffee00-0218-0218-0218-c0ffee000218',
      event: 'Notification',
      // notification_type deliberately omitted
    };
    const result = mapEventToStatus(record);
    assert.notEqual(result, 'waiting',
      'missing notification_type must not map to "waiting"');
  });
});

// ── 0219: Stop → 'idle' and Notification:idle_prompt → 'idle' ─────────────

describe('0219: Stop and idle_prompt → idle, unknown event → null/undefined', () => {
  test('mapEventToStatus({event:"Stop"}) returns "idle"', () => {
    const result = mapEventToStatus(stopEvent());
    assert.equal(result, 'idle');
  });

  test('Stop record with extra fields still returns "idle"', () => {
    const result = mapEventToStatus(stopEvent({
      last_assistant_message: 'Done.',
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }));
    assert.equal(result, 'idle');
  });

  test('mapEventToStatus({event:"Notification", notification_type:"idle_prompt"}) returns "idle"', () => {
    const result = mapEventToStatus(notificationEvent('idle_prompt'));
    assert.equal(result, 'idle');
  });

  test('an unrecognised event returns null or undefined (no status change)', () => {
    const result = mapEventToStatus({
      ts: Date.now(),
      session_id: 'c0ffee00-0219-0219-0219-c0ffee000219',
      event: 'StopFailure',   // task 0245 — not mapped yet
    });
    assert.ok(
      result == null,
      `expected null/undefined for unknown event, got: ${JSON.stringify(result)}`,
    );
  });

  test('a completely unknown event string returns null or undefined', () => {
    const result = mapEventToStatus({
      ts: Date.now(),
      session_id: 'c0ffee00-0219-0219-0219-c0ffee000219',
      event: 'WeirdFutureEvent',
    });
    assert.ok(
      result == null,
      `expected null/undefined, got: ${JSON.stringify(result)}`,
    );
  });
});
