// tests/statusHookTailer.integration.test.mjs
//
// Paired tests for task 0221 — pin the end-to-end contract of
// startStatusHookTailer (impl tasks 0263 watch-lifecycle + 0222 assemble).
//
// Public API being tested (server/statusHookTailer.mjs, not yet exported):
//
//   startStatusHookTailer({ agent })
//     — derives the file path via statusFilePath({ sessionId: agent.sessionId })
//     — watches it with fs.watch + a stat-poll backstop
//     — on each appended event calls mapEventToStatus and sets agent.hookStatus
//       to the mapped value (null-mapping events are ignored / do not change hookStatus)
//     — returns { stop() } handle
//
// Fake agent shape:
//   { sessionId: <uuid>, hookStatus: undefined }   (plain object is sufficient)
//   An EventEmitter is NOT required — but the impl may emit 'change'; if it
//   does this test still passes because we poll hookStatus directly.
//
// These tests MUST fail until 0263 + 0222 ship (startStatusHookTailer is not
// exported yet).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// This import WILL fail with SyntaxError or TypeError until 0263/0222 ship.
import { startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal fake agent. hookStatus starts undefined so we can detect the first
 * assignment clearly.  The impl may optionally emit('change') — EventEmitter
 * is not needed here because we poll hookStatus directly.
 */
function makeAgent() {
  const sessionId = randomUUID();
  return { sessionId, hookStatus: undefined };
}

/**
 * Resolve and ensure the parent directory of the status file exists.
 * Returns the absolute path.
 */
function ensureStatusFile(agent) {
  const filePath = statusFilePath({ sessionId: agent.sessionId });
  mkdirSync(dirname(filePath), { recursive: true });
  // Create the file so the tailer can attach fs.watch immediately.
  writeFileSync(filePath, '');
  return filePath;
}

/**
 * Append one NDJSON event to the status file exactly as emit-status.mjs does.
 * Shape: { ts, session_id, event, notification_type? }
 */
function appendEvent(filePath, { event, notification_type, sessionId }) {
  const record = { ts: Date.now(), session_id: sessionId, event };
  if (notification_type !== undefined) record.notification_type = notification_type;
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Poll agent.hookStatus every 50 ms until it equals `expected` or `timeoutMs`
 * elapses. Returns the final value so callers can assert it themselves.
 */
async function pollUntil(agent, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agent.hookStatus === expected) return agent.hookStatus;
    await new Promise(r => setTimeout(r, 50));
  }
  return agent.hookStatus; // caller asserts; don't throw here
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('0221: startStatusHookTailer — NDJSON append → agent.hookStatus', () => {

  // ── AC1: PreToolUse → 'working' ────────────────────────────────────────────

  test('AC1: appending PreToolUse sets hookStatus to "working"', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      // Give the watcher a tick to attach before writing.
      await new Promise(r => setTimeout(r, 100));

      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });

      const final = await pollUntil(agent, 'working');
      assert.equal(final, 'working',
        `expected hookStatus="working" after PreToolUse; got ${JSON.stringify(final)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch { /* best-effort */ }
    }
  });

  // ── AC2: Notification:permission_prompt → 'waiting' ────────────────────────

  test('AC2: appending Notification:permission_prompt sets hookStatus to "waiting"', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      appendEvent(filePath, {
        event: 'Notification',
        notification_type: 'permission_prompt',
        sessionId: agent.sessionId,
      });

      const final = await pollUntil(agent, 'waiting');
      assert.equal(final, 'waiting',
        `expected hookStatus="waiting" after permission_prompt; got ${JSON.stringify(final)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC3: Stop → 'idle' ─────────────────────────────────────────────────────

  test('AC3: appending Stop sets hookStatus to "idle"', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });

      const final = await pollUntil(agent, 'idle');
      assert.equal(final, 'idle',
        `expected hookStatus="idle" after Stop; got ${JSON.stringify(final)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC4: last-event-wins ordering (PreToolUse then Stop) ───────────────────

  test('AC4: last-event-wins — PreToolUse then Stop leaves hookStatus at "idle"', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollUntil(agent, 'working', 1500);
      assert.equal(agent.hookStatus, 'working', 'hookStatus should be working after PreToolUse');

      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });
      const final = await pollUntil(agent, 'idle', 1500);
      assert.equal(final, 'idle',
        `expected hookStatus="idle" after Stop; got ${JSON.stringify(final)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC5: malformed line is skipped — no crash, no hookStatus change ─────────

  test('AC5: malformed (non-JSON) line does not crash tailer and does not change hookStatus', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // Append a garbage line
      appendFileSync(filePath, 'THIS IS NOT JSON\n', 'utf8');

      // Wait long enough for both fs.watch and the stat-poll backstop to fire.
      await new Promise(r => setTimeout(r, 800));

      // hookStatus must remain undefined — no valid event was written
      assert.equal(agent.hookStatus, undefined,
        `expected hookStatus=undefined after malformed line; got ${JSON.stringify(agent.hookStatus)}`);

      // Now append a valid event to prove the tailer is still alive.
      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });
      const final = await pollUntil(agent, 'idle', 1500);
      assert.equal(final, 'idle',
        `tailer must still work after skipping malformed line; got ${JSON.stringify(final)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC6: null-mapping events do NOT update hookStatus ───────────────────────

  test('AC6: an unknown event (maps to null) does not overwrite a prior hookStatus', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // Establish a known status
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollUntil(agent, 'working', 1500);
      assert.equal(agent.hookStatus, 'working');

      // Append a known-null-mapping event (PostToolUse is not mapped)
      appendEvent(filePath, { event: 'PostToolUse', sessionId: agent.sessionId });

      // Give the tailer time to process it
      await new Promise(r => setTimeout(r, 600));

      // hookStatus must not have changed
      assert.equal(agent.hookStatus, 'working',
        `hookStatus must remain "working" after null-mapping event; got ${JSON.stringify(agent.hookStatus)}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC7: stop() halts watching — further appends do not change hookStatus ───

  test('AC7: stop() ends watching — appends after stop() do not change hookStatus', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // First event — should land
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollUntil(agent, 'working', 1500);
      assert.equal(agent.hookStatus, 'working', 'pre-stop event must land');

      // Stop the tailer
      handle.stop();

      // Append another event that would change status if the tailer were alive
      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });

      // Wait long enough for fs.watch and the backstop poll to fire (if still alive)
      await new Promise(r => setTimeout(r, 1200));

      // hookStatus must remain at the last value seen before stop()
      assert.equal(agent.hookStatus, 'working',
        `hookStatus must not change after stop(); got ${JSON.stringify(agent.hookStatus)}`);
    } finally {
      // handle already stopped — call again for safety (must be idempotent)
      try { handle.stop(); } catch {}
      try { rmSync(filePath); } catch {}
    }
  });
});
