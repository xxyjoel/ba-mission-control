// tests/statusHookTailer.freshness.test.mjs
//
// Paired tests for task 0224 — pin the freshness contract that task 0223 will
// implement inside startStatusHookTailer:
//
//   • agent.hookStatusTs is set (to a number) whenever hookStatus CHANGES value
//   • hookStatusTs does NOT change on a null-mapping event
//   • agent.emit('change') fires ONLY when hookStatus transitions to a NEW value
//     (same-status repeat is a no-op; null-mapping event is a no-op)
//
// The current impl (pre-0223) sets agent.hookStatus but does NOT set
// hookStatusTs nor call agent.emit('change').  Every assertion on those two
// things MUST fail until 0223 ships — that is the desired TDD outcome.
//
// Fake agent shape: node:events EventEmitter with sessionId + hookStatus props.
// Pattern mirrors tests/statusHookTailer.integration.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Fake agent: EventEmitter so the tailer can call agent.emit('change').
 * hookStatus starts undefined; hookStatusTs starts undefined.
 */
function makeAgent() {
  const agent = new EventEmitter();
  agent.sessionId = randomUUID();
  agent.hookStatus = undefined;
  agent.hookStatusTs = undefined;
  return agent;
}

/**
 * Resolve the status file path and ensure its parent directory exists.
 * Writes an empty file so fs.watch can attach immediately.
 */
function ensureStatusFile(agent) {
  const filePath = statusFilePath({ sessionId: agent.sessionId });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
  return filePath;
}

/**
 * Append one NDJSON hook event line — mirrors the shape from emit-status.mjs.
 * Shape: { ts, session_id, event, notification_type? }
 */
function appendEvent(filePath, { event, notification_type, sessionId }) {
  const record = { ts: Date.now(), session_id: sessionId, event };
  if (notification_type !== undefined) record.notification_type = notification_type;
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Poll agent.hookStatus every 50 ms until it equals `expected` or timeoutMs
 * elapses.  Returns the final value — callers assert themselves.
 */
async function pollStatus(agent, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agent.hookStatus === expected) return agent.hookStatus;
    await new Promise(r => setTimeout(r, 50));
  }
  return agent.hookStatus;
}

/**
 * Count how many 'change' events the agent has emitted by attaching a
 * listener before any writes and returning a getter closure.
 */
function trackChanges(agent) {
  let count = 0;
  agent.on('change', () => { count++; });
  return () => count;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('0224: startStatusHookTailer — hookStatusTs freshness + change emit discipline', () => {

  // ── AC1: two consecutive identical-status lines emit 'change' at most once ──
  //
  // Pre-0223 the tailer never calls emit('change') at all, so changeCount will
  // be 0 when we assert >= 1 (first write) → FAIL (correct TDD outcome).

  test('AC1: two consecutive PreToolUse lines emit change at most once (not twice)', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const getChanges = trackChanges(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      // Give the watcher a tick to attach.
      await new Promise(r => setTimeout(r, 100));

      // First PreToolUse — should set hookStatus to 'working' and emit 'change'.
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollStatus(agent, 'working', 2000);
      assert.equal(agent.hookStatus, 'working',
        'hookStatus must be "working" after first PreToolUse');

      // Wait briefly so the tailer has time to process and emit if it will.
      await new Promise(r => setTimeout(r, 300));
      const afterFirst = getChanges();

      // Assert the tailer DID emit 'change' for the first (real) transition.
      // PRE-0223: this WILL fail because emit('change') is not called yet.
      assert.ok(afterFirst >= 1,
        `expected at least 1 'change' emit after first PreToolUse; got ${afterFirst}`);

      // Second PreToolUse — same status, should NOT emit 'change' again.
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await new Promise(r => setTimeout(r, 600));
      const afterSecond = getChanges();

      // Total change count must still be exactly 1 (second was a no-op transition).
      assert.equal(afterSecond, 1,
        `expected exactly 1 'change' total after two identical-status PreToolUse lines; got ${afterSecond}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch { /* best-effort */ }
    }
  });

  // ── AC2: hookStatusTs is a number and advances on a real status transition ──
  //
  // Pre-0223 hookStatusTs is never set (stays undefined) → assert.ok(typeof ... === 'number')
  // FAILS with "expected a truthy value" (correct TDD outcome).

  test('AC2: hookStatusTs is set to a number on first change and advances on next real transition', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // Transition 1: undefined → working
      const before = Date.now();
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollStatus(agent, 'working', 2000);
      await new Promise(r => setTimeout(r, 200));

      // PRE-0223: hookStatusTs is undefined → typeof check FAILS here.
      assert.ok(typeof agent.hookStatusTs === 'number',
        `hookStatusTs must be a number after first transition; got ${JSON.stringify(agent.hookStatusTs)}`);
      assert.ok(agent.hookStatusTs >= before,
        `hookStatusTs (${agent.hookStatusTs}) must be >= timestamp before write (${before})`);

      const tsAfterFirst = agent.hookStatusTs;

      // Small gap so Date.now() can advance measurably.
      await new Promise(r => setTimeout(r, 20));

      // Transition 2: working → idle (Stop)
      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });
      await pollStatus(agent, 'idle', 2000);
      await new Promise(r => setTimeout(r, 200));

      assert.ok(typeof agent.hookStatusTs === 'number',
        `hookStatusTs must still be a number after second transition; got ${JSON.stringify(agent.hookStatusTs)}`);
      assert.ok(agent.hookStatusTs >= tsAfterFirst,
        `hookStatusTs must advance on second real transition; before=${tsAfterFirst} after=${agent.hookStatusTs}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC3: null-mapping line does NOT change hookStatus, hookStatusTs, or emit 'change' ──
  //
  // Pre-0223: the tailer already leaves hookStatus unchanged on null-mapping
  // events (this is implemented). But it doesn't set hookStatusTs so the ts
  // guard assertion below still fails — and the change-count assertion also
  // fails because emit('change') is never called on the first write either.

  test('AC3: PostToolUse (null-mapping) does not change hookStatus, hookStatusTs, or emit change', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const getChanges = trackChanges(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // Establish initial state: working.
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollStatus(agent, 'working', 2000);
      await new Promise(r => setTimeout(r, 200));

      assert.equal(agent.hookStatus, 'working',
        'hookStatus must be "working" after PreToolUse');

      // PRE-0223: this FAILS because hookStatusTs is still undefined.
      assert.ok(typeof agent.hookStatusTs === 'number',
        `hookStatusTs must be a number after first transition; got ${JSON.stringify(agent.hookStatusTs)}`);

      const tsSnapshot = agent.hookStatusTs;
      const changesSnapshot = getChanges();

      // Append a null-mapping event.
      appendEvent(filePath, { event: 'PostToolUse', sessionId: agent.sessionId });
      await new Promise(r => setTimeout(r, 600));

      // hookStatus must remain 'working'.
      assert.equal(agent.hookStatus, 'working',
        `hookStatus must remain "working" after null-mapping PostToolUse; got ${JSON.stringify(agent.hookStatus)}`);

      // hookStatusTs must NOT have advanced (no status change occurred).
      assert.equal(agent.hookStatusTs, tsSnapshot,
        `hookStatusTs must not advance on null-mapping event; was ${tsSnapshot} now ${agent.hookStatusTs}`);

      // 'change' must not have fired again.
      assert.equal(getChanges(), changesSnapshot,
        `'change' must not be emitted for null-mapping event; count before=${changesSnapshot} after=${getChanges()}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  // ── AC4: working → idle (Stop) transition DOES emit 'change' ────────────────
  //
  // Pre-0223: emit('change') is never called → second-change count stays at 0
  // when we assert it advanced to 2 → FAIL (correct TDD outcome).

  test('AC4: working→idle transition via Stop emits a second change event', async () => {
    const agent = makeAgent();
    const filePath = ensureStatusFile(agent);
    const getChanges = trackChanges(agent);
    const handle = startStatusHookTailer({ agent });
    try {
      await new Promise(r => setTimeout(r, 100));

      // Transition 1: undefined → working
      appendEvent(filePath, { event: 'PreToolUse', sessionId: agent.sessionId });
      await pollStatus(agent, 'working', 2000);
      await new Promise(r => setTimeout(r, 300));

      const afterWorking = getChanges();
      // PRE-0223 FAILS here: expected >= 1 but got 0.
      assert.ok(afterWorking >= 1,
        `expected >= 1 'change' emit after PreToolUse transition; got ${afterWorking}`);

      // Transition 2: working → idle
      appendEvent(filePath, { event: 'Stop', sessionId: agent.sessionId });
      await pollStatus(agent, 'idle', 2000);
      await new Promise(r => setTimeout(r, 300));

      assert.equal(agent.hookStatus, 'idle',
        `hookStatus must be "idle" after Stop; got ${JSON.stringify(agent.hookStatus)}`);

      const afterIdle = getChanges();
      // Must have emitted exactly one more 'change' for the working→idle transition.
      assert.equal(afterIdle, afterWorking + 1,
        `expected ${afterWorking + 1} 'change' emits total after working→idle; got ${afterIdle}`);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });
});
