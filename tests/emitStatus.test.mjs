// tests/emitStatus.test.mjs — 0206: emit-status.mjs stdin hook JSON → one appended NDJSON line
//
// The emitter (server/hooks/emit-status.mjs, tasks 0207+0281) does not exist
// yet — these tests MUST fail until it ships.
//
// Contract:
//   A well-formed PreToolUse hook payload on stdin produces exactly ONE new
//   NDJSON line in statusFilePath({sessionId}) containing ts, session_id, event.
//   A Notification payload also includes notification_type.
//   Two sequential invocations append two lines (never truncate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { statusFilePath } from '../server/statusFile.mjs';

const execFileAsync = promisify(execFile);

// Canonical UUID used as the test session — avoids touching any real session file.
const TEST_SID = 'c0ffee00-0206-0206-0206-c0ffee000206';

// Path to the emitter script under test.
const EMITTER = new URL('../server/hooks/emit-status.mjs', import.meta.url).pathname;

// Pre-computed output path so cleanup is unconditional.
const STATUS_FILE = statusFilePath({ sessionId: TEST_SID });

// Real fixture shapes captured from spike-0260 (PreToolUse + Notification).
const PRE_TOOL_USE_PAYLOAD = JSON.stringify({
  session_id: TEST_SID,
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/tmp/probe.txt', content: 'hello' },
  tool_use_id: 'toolu_test0206',
});

const NOTIFICATION_PAYLOAD = JSON.stringify({
  session_id: TEST_SID,
  hook_event_name: 'Notification',
  message: 'Claude needs your permission',
  notification_type: 'permission_prompt',
});

// Spawn the emitter with a payload on stdin; resolves with { code }.
function runEmitter(stdinData, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emitter hung after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const child = execFile('node', [EMITTER], { timeout: timeoutMs });
    // Drain stdout/stderr so the child doesn't block on a full pipe buffer.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    if (stdinData !== null) child.stdin?.end(stdinData);
    else child.stdin?.end();
  });
}

// Ensure the status dir exists (emitter must create it if absent, but
// the test needs the DIR to already exist so statusFilePath is resolvable).
mkdirSync(dirname(STATUS_FILE), { recursive: true });

function cleanup() {
  if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
}

// ── before each test, remove any leftover file ────────────────────────────────

test('0206: PreToolUse payload → exactly one new NDJSON line appended', async () => {
  cleanup();
  const { code } = await runEmitter(PRE_TOOL_USE_PAYLOAD);
  assert.equal(code, 0, 'emitter must exit 0');

  assert.ok(existsSync(STATUS_FILE), `status file must exist at ${STATUS_FILE}`);
  const lines = readFileSync(STATUS_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one line appended for one event');

  const parsed = JSON.parse(lines[0]);
  assert.ok(typeof parsed.ts === 'number', 'ts must be a number (epoch ms)');
  assert.equal(parsed.session_id, TEST_SID, 'session_id echoed from payload');
  assert.equal(parsed.event, 'PreToolUse', 'event is hook_event_name');
  // notification_type is optional for PreToolUse — should be absent or undefined.
  assert.ok(
    !('notification_type' in parsed) || parsed.notification_type === undefined,
    'notification_type not present on non-Notification events',
  );

  cleanup();
});

test('0206: Notification payload includes notification_type in output line', async () => {
  cleanup();
  const { code } = await runEmitter(NOTIFICATION_PAYLOAD);
  assert.equal(code, 0, 'emitter must exit 0');

  assert.ok(existsSync(STATUS_FILE), 'status file must exist');
  const lines = readFileSync(STATUS_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one line for one Notification event');

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'Notification');
  assert.equal(parsed.notification_type, 'permission_prompt');

  cleanup();
});

test('0206: two sequential events produce two lines (append, never truncate)', async () => {
  cleanup();
  await runEmitter(PRE_TOOL_USE_PAYLOAD);
  await runEmitter(NOTIFICATION_PAYLOAD);

  assert.ok(existsSync(STATUS_FILE), 'status file must exist');
  const lines = readFileSync(STATUS_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'two events → two lines (append mode, not overwrite)');

  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.event, 'PreToolUse');
  assert.equal(second.event, 'Notification');
  assert.equal(second.notification_type, 'permission_prompt');

  cleanup();
});
