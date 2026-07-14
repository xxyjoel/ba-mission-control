// tests/emitStatus.resilience.test.mjs — 0208: emitter exits 0 under adversarial stdin
//
// The emitter (server/hooks/emit-status.mjs, tasks 0207+0281) does not exist
// yet — these tests MUST fail until it ships.
//
// Contract: a hook must NEVER block or throw. Any bad input → exit 0.
//   • empty stdin              → exit 0, nothing written (or a safe no-op)
//   • non-JSON stdin           → exit 0, no crash
//   • truncated JSON           → exit 0, no crash
//   • JSON missing session_id  → exit 0 (cannot derive path → writes nothing)
//   • non-UUID session_id      → exit 0 (UUID guard swallowed, not re-thrown)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Path to the emitter script under test.
const EMITTER = new URL('../server/hooks/emit-status.mjs', import.meta.url).pathname;

// Status dir — ensure it exists so a missing dir is not the failure mode
// for tests that care about something else.
const STATUS_DIR = join(homedir(), '.local', 'state', 'claude-mc', 'status');
mkdirSync(STATUS_DIR, { recursive: true });

const TIMEOUT_MS = 5000; // 5s hard ceiling — emitter must never hang

/**
 * Spawn the emitter with arbitrary stdin bytes; resolve with the exit code.
 * Rejects with Error if the process hangs past timeoutMs.
 *
 * @param {string|null} stdinPayload  — null means close stdin immediately (EOF)
 */
function runEmit(stdinPayload, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emitter hung after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const child = execFile('node', [EMITTER], { timeout: timeoutMs });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    if (stdinPayload === null || stdinPayload === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(stdinPayload);
    }
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('0208: empty string on stdin → emitter exits 0 (no hang, no throw)', async () => {
  const code = await runEmit('');
  assert.equal(code, 0, 'must exit 0 for empty stdin');
});

test('0208: EOF with no bytes at all (null) → emitter exits 0', async () => {
  const code = await runEmit(null);
  assert.equal(code, 0, 'must exit 0 when stdin closes immediately');
});

test('0208: non-JSON garbage on stdin → emitter exits 0', async () => {
  const code = await runEmit('this is not json at all @@@@\n');
  assert.equal(code, 0, 'must exit 0 for completely malformed input');
});

test('0208: truncated JSON on stdin → emitter exits 0', async () => {
  const code = await runEmit('{"session_id":"abc');
  assert.equal(code, 0, 'must exit 0 for truncated (unparseable) JSON');
});

test('0208: valid JSON but no session_id field → emitter exits 0 (writes nothing)', async () => {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
  const code = await runEmit(payload);
  assert.equal(code, 0, 'must exit 0 when session_id is absent from payload');
});

test('0208: non-UUID session_id (path-traversal attempt) → emitter exits 0', async () => {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: '../../etc/passwd',
  });
  const code = await runEmit(payload);
  assert.equal(code, 0, 'UUID guard must be swallowed internally, not re-thrown to shell');
});

test('0208: valid JSON followed by trailing garbage → emitter exits 0', async () => {
  // Simulates a double-write or concatenated streams — must be robust.
  const payload =
    JSON.stringify({
      session_id: 'deadbeef-0208-0208-0208-deadbeef0208',
      hook_event_name: 'Stop',
    }) + '\nthis-extra-line-is-garbage';
  const code = await runEmit(payload);
  assert.equal(code, 0, 'trailing garbage after valid JSON must not crash the emitter');
});
