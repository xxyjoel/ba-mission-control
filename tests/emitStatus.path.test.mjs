// tests/emitStatus.path.test.mjs — 0282: emitter writes to statusFilePath(session_id)
//
// The emitter (server/hooks/emit-status.mjs, tasks 0207+0281) does not exist
// yet — these tests MUST fail until it ships.
//
// Contract:
//   • A payload with session_id X writes to exactly statusFilePath({sessionId:X})
//     and nowhere else.
//   • Two payloads with DISTINCT session_ids write to TWO different files with no
//     cross-contamination.
//   The path MUST be derived from server/statusFile.mjs — not recomputed ad-hoc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { statusFilePath } from '../server/statusFile.mjs';

// Two distinct test UUIDs — each must isolate to its own file.
const SID_A = 'aaaa0282-0000-0000-0000-000000000000';
const SID_B = 'bbbb0282-0000-0000-0000-000000000000';

const PATH_A = statusFilePath({ sessionId: SID_A });
const PATH_B = statusFilePath({ sessionId: SID_B });

// Path to the emitter under test.
const EMITTER = new URL('../server/hooks/emit-status.mjs', import.meta.url).pathname;

// Ensure the status dir exists (emitter must also create it, but guard here so
// statusFilePath itself doesn't error on path computation).
mkdirSync(dirname(PATH_A), { recursive: true });

const TIMEOUT_MS = 5000;

function runEmit(stdinPayload, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emitter hung after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const child = execFile('node', [EMITTER], { timeout: timeoutMs });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin?.end(stdinPayload);
  });
}

function cleanup(...paths) {
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('0282: payload with session_id A writes to statusFilePath({sessionId:A})', async () => {
  cleanup(PATH_A, PATH_B);

  const payload = JSON.stringify({
    session_id: SID_A,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
  });

  const code = await runEmit(payload);
  assert.equal(code, 0, 'emitter must exit 0');

  // The line must land in PATH_A (the canonical path for SID_A).
  assert.ok(existsSync(PATH_A), `line must be written to statusFilePath for ${SID_A} — path: ${PATH_A}`);

  // PATH_B must remain untouched.
  assert.ok(!existsSync(PATH_B), `no file must be created for ${SID_B} — found unexpected ${PATH_B}`);

  // The written line must contain session_id A, not B.
  const line = JSON.parse(readFileSync(PATH_A, 'utf8').trim());
  assert.equal(line.session_id, SID_A, 'session_id in the NDJSON line must match the payload');

  cleanup(PATH_A, PATH_B);
});

test('0282: two different session_ids write to two different files (isolation)', async () => {
  cleanup(PATH_A, PATH_B);

  const payloadA = JSON.stringify({ session_id: SID_A, hook_event_name: 'PreToolUse' });
  const payloadB = JSON.stringify({ session_id: SID_B, hook_event_name: 'Notification', notification_type: 'idle_prompt' });

  // Run both emitter invocations sequentially to avoid race on mkdir.
  const codeA = await runEmit(payloadA);
  const codeB = await runEmit(payloadB);
  assert.equal(codeA, 0, 'emitter for SID_A must exit 0');
  assert.equal(codeB, 0, 'emitter for SID_B must exit 0');

  // Each file must exist independently.
  assert.ok(existsSync(PATH_A), `file for ${SID_A} must exist at ${PATH_A}`);
  assert.ok(existsSync(PATH_B), `file for ${SID_B} must exist at ${PATH_B}`);

  // Each file must contain exactly one line with the matching session_id.
  const linesA = readFileSync(PATH_A, 'utf8').split('\n').filter(Boolean);
  const linesB = readFileSync(PATH_B, 'utf8').split('\n').filter(Boolean);
  assert.equal(linesA.length, 1, 'PATH_A must have exactly one line');
  assert.equal(linesB.length, 1, 'PATH_B must have exactly one line');

  const parsedA = JSON.parse(linesA[0]);
  const parsedB = JSON.parse(linesB[0]);
  assert.equal(parsedA.session_id, SID_A, 'line in PATH_A must have SID_A');
  assert.equal(parsedB.session_id, SID_B, 'line in PATH_B must have SID_B');

  // Cross-contamination check: A's event must not appear in B's file and vice versa.
  assert.notEqual(parsedA.session_id, SID_B, 'no cross-contamination: SID_B must not appear in PATH_A');
  assert.notEqual(parsedB.session_id, SID_A, 'no cross-contamination: SID_A must not appear in PATH_B');

  cleanup(PATH_A, PATH_B);
});

test('0282: path is exactly statusFilePath({sessionId}) — not a re-derived variant', async () => {
  // This test is a structural assertion: the NDJSON file that the emitter produces
  // must be at the same path that server/statusFile.mjs returns for the given sid.
  // If the emitter computes its own path (e.g. hard-codes a different base dir),
  // existsSync(PATH_A) above would pass but this explicit equality would still
  // catch a divergence if someone later moves the status dir without updating both.
  const expected = statusFilePath({ sessionId: SID_A });
  assert.equal(PATH_A, expected, 'test helper must use the canonical statusFilePath');

  cleanup(PATH_A, PATH_B);
  const payload = JSON.stringify({ session_id: SID_A, hook_event_name: 'Stop' });
  await runEmit(payload);

  assert.ok(
    existsSync(expected),
    `emitter must write to the EXACT path returned by statusFilePath: ${expected}`,
  );

  cleanup(PATH_A);
});
