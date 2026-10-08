// tests/permissionMode.followsClaude.test.mjs — 0439: mc's record of the
// permission mode follows a mode change made INSIDE claude (Shift+Tab in zoom).
//
// Before 0439 agent.permissionMode moved only when mc itself changed the mode.
// Claude reports the mode on two channels, and mc dropped both:
//   - hook payloads carry `permission_mode` (UserPromptSubmit, PreToolUse, …);
//     emit-status.mjs destructured the payload and left it out of the record,
//     and statusHookTailer never read a mode;
//   - transcript user lines carry `permissionMode`; handleUser ignored it, and
//     primeStatusFromDisk never copied a replayed mode back.
// A wrong value is saved by sessionStore and a resumed session restarts in it.
//
// Paired tests, one per path (fail before, pass after), plus guards:
//   - values come from untrusted files — only a known claude mode is applied;
//   - a record OLDER than the argv mc last spawned claude with is history and
//     must not undo that mode (changePermissionMode restarts claude with
//     `--resume --permission-mode NEW` and replays the old records).
//
// Every tailer stop()/cleanup lives in a `finally`; asserts run after it, so a
// failing assert can't leak a stat-poll interval and hang `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { statusFilePath } from '../server/statusFile.mjs';
import { startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { parseEvent } from '../server/jsonlConnector.mjs';
import { startSessionTailer, claudeProjectDir } from '../server/sessionFileTailer.mjs';

const EMITTER = new URL('../server/hooks/emit-status.mjs', import.meta.url).pathname;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runEmitter(payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`emitter hung after ${timeoutMs}ms`)), timeoutMs);
    const child = execFile('node', [EMITTER], { timeout: timeoutMs });
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin?.end(JSON.stringify(payload));
  });
}

function readRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── (1) emit-status keeps permission_mode ─────────────────────────────────────

test('0439/1: emit-status writes permission_mode from UserPromptSubmit and PreToolUse', async () => {
  const sid = randomUUID();
  const file = statusFilePath({ sessionId: sid });
  let recs;
  try {
    await runEmitter({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi', permission_mode: 'plan' });
    await runEmitter({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'acceptEdits' });
    // No mode on the payload → no key on the record (keep it small).
    await runEmitter({ session_id: sid, hook_event_name: 'Stop' });
    recs = readRecords(file);
  } finally { if (existsSync(file)) unlinkSync(file); }
  assert.equal(recs.length, 3);
  assert.equal(recs[0].permission_mode, 'plan');
  assert.equal(recs[1].permission_mode, 'acceptEdits');
  assert.equal('permission_mode' in recs[2], false, 'absent mode adds no key');
});

test('0439/1: emit-status drops a non-string permission_mode and caps a long one', async () => {
  const sid = randomUUID();
  const file = statusFilePath({ sessionId: sid });
  let recs;
  try {
    await runEmitter({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: { evil: 1 } });
    await runEmitter({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'x'.repeat(5000) });
    recs = readRecords(file);
  } finally { if (existsSync(file)) unlinkSync(file); }
  assert.equal(recs.length, 2);
  assert.equal('permission_mode' in recs[0], false, 'object value is not written');
  assert.ok(recs[1].permission_mode.length <= 32, 'long value is capped');
});

// ── (2) statusHookTailer applies it ───────────────────────────────────────────

function hookAgent(extra = {}) {
  const a = new EventEmitter();
  Object.assign(a, { sessionId: randomUUID(), hookStatus: undefined, permissionMode: 'acceptEdits', ...extra });
  return a;
}

function hookFile(agent) {
  const f = statusFilePath({ sessionId: agent.sessionId });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, '');
  return f;
}

function appendHook(f, rec) {
  appendFileSync(f, JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

test('0439/2: hook event with permission_mode plan moves an acceptEdits agent to plan', async () => {
  const agent = hookAgent();
  const f = hookFile(agent);
  let changes = 0;
  agent.on('change', () => { changes++; });
  const t = startStatusHookTailer({ agent });
  try {
    await sleep(50);
    appendHook(f, { session_id: agent.sessionId, event: 'UserPromptSubmit', permission_mode: 'plan' });
    await waitFor(() => agent.permissionMode === 'plan');
  } finally { t.stop(); rmSync(f, { force: true }); }
  assert.equal(agent.permissionMode, 'plan', 'mode follows the hook record');
  assert.ok(changes >= 1, 'a change is emitted');
});

test('0439/2: mode on a PostToolUse that resolves a stale waiting is still applied', async () => {
  // The 0408-P3 branch `continue`s — the mode must be read before it.
  const agent = hookAgent({ hookStatus: 'waiting' });
  const f = hookFile(agent);
  const t = startStatusHookTailer({ agent });
  try {
    await sleep(50);
    appendHook(f, { session_id: agent.sessionId, event: 'PostToolUse', tool_name: 'Bash', permission_mode: 'auto' });
    await waitFor(() => agent.permissionMode === 'auto');
  } finally { t.stop(); rmSync(f, { force: true }); }
  assert.equal(agent.permissionMode, 'auto');
  assert.equal(agent.hookStatus, 'working');
});

test('0439/2 guard: unknown mode strings and subagent records are ignored', async () => {
  const agent = hookAgent();
  const f = hookFile(agent);
  const t = startStatusHookTailer({ agent });
  try {
    await sleep(50);
    appendHook(f, { session_id: agent.sessionId, event: 'PreToolUse', tool_name: 'Bash', permission_mode: 'rm -rf /' });
    appendHook(f, { session_id: agent.sessionId, event: 'PreToolUse', tool_name: 'Bash', permission_mode: 'bypassPermissions', sub: true });
    appendHook(f, { session_id: agent.sessionId, event: 'Stop' });
    await waitFor(() => agent.hookStatus === 'idle');
  } finally { t.stop(); rmSync(f, { force: true }); }
  assert.equal(agent.hookStatus, 'idle', 'the feed was read');
  assert.equal(agent.permissionMode, 'acceptEdits', 'garbage and subagent modes never land');
});

test('0439/2 guard: a subagent Notification or Stop never sets the main mode', async () => {
  const agent = hookAgent();
  const f = hookFile(agent);
  const t = startStatusHookTailer({ agent });
  try {
    await sleep(50);
    appendHook(f, { session_id: agent.sessionId, event: 'Notification', notification_type: 'idle_prompt', permission_mode: 'bypassPermissions', sub: true });
    appendHook(f, { session_id: agent.sessionId, event: 'Stop', permission_mode: 'plan', sub: true });
    appendHook(f, { session_id: agent.sessionId, event: 'Stop' });
    await waitFor(() => agent.hookStatus === 'idle');
  } finally { t.stop(); rmSync(f, { force: true }); }
  assert.equal(agent.permissionMode, 'acceptEdits');
});

test('0439/2 guard: a hook record older than the last spawn argv does not undo it', async () => {
  // changePermissionMode → start() → a new hook tailer replays the file from
  // offset 0. The old 'auto' record is history; claude now runs in 'plan'.
  const agent = hookAgent({ permissionMode: 'plan' });
  const f = hookFile(agent);
  appendFileSync(f, JSON.stringify({ ts: Date.now() - 60_000, session_id: agent.sessionId, event: 'PreToolUse', tool_name: 'Bash', permission_mode: 'auto' }) + '\n');
  agent.permissionModeArgvTs = Date.now() - 1000;
  const t = startStatusHookTailer({ agent });
  try {
    await waitFor(() => agent.hookStatus === 'working');
  } finally { t.stop(); rmSync(f, { force: true }); }
  assert.equal(agent.hookStatus, 'working', 'the old record was read');
  assert.equal(agent.permissionMode, 'plan', 'history does not override the argv mode');
});

// ── (3) jsonlConnector.handleUser reads permissionMode ────────────────────────

function connAgent(extra = {}) {
  return {
    status: 'idle', activity: '', tail: [], todos: [], tokensIn: 0, tokensOut: 0,
    context: 0, costSession: 0, permissionMode: 'acceptEdits', ...extra,
  };
}

test('0439/3: a user prompt line carrying permissionMode updates the agent', () => {
  const a = connAgent();
  const changed = parseEvent({
    type: 'user', permissionMode: 'plan', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'do the thing' },
  }, a);
  assert.equal(changed, true);
  assert.equal(a.permissionMode, 'plan');
});

test('0439/3: a tool_result user line carrying permissionMode updates the agent', () => {
  const a = connAgent();
  parseEvent({
    type: 'user', permissionMode: 'auto',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }, a);
  assert.equal(a.permissionMode, 'auto');
});

test('0439/3 guard: unknown modes on user and permission-mode records are rejected', () => {
  const a = connAgent();
  parseEvent({ type: 'user', permissionMode: 'yolo', message: { role: 'user', content: 'x' } }, a);
  assert.equal(a.permissionMode, 'acceptEdits');
  const changed = parseEvent({ type: 'permission-mode', permissionMode: '<script>' }, a);
  assert.equal(changed, false);
  assert.equal(a.permissionMode, 'acceptEdits', 'the permission-mode record is validated too');
  assert.ok(!a.tail.some((e) => /<script>/.test(e.text || '')), 'nothing invalid reaches the tail');
});

// ── (4) primeStatusFromDisk copies permissionMode back ────────────────────────

function primeSetup(extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-0439-'));
  const sessionId = randomUUID();
  const dir = claudeProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId, status: 'idle', activity: '', tail: [], todos: [],
    tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, context: 0, costSession: 0,
    resolvedModel: null, spawnedAt: Date.now(), lastEventTs: 0, permissionMode: 'acceptEdits',
    appendTail(e) { this.tail.push({ ...e, ts: e.ts ?? Date.now() }); },
    ...extra,
  });
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { agent, filePath, cleanup };
}

function writeJsonl(filePath, records) {
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('0439/4: attaching to a transcript adopts the mode claude last reported', async () => {
  const { agent, filePath, cleanup } = primeSetup();
  const now = Date.now();
  writeJsonl(filePath, [
    { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: agent.sessionId },
    { type: 'user', permissionMode: 'acceptEdits', timestamp: new Date(now - 2000).toISOString(), message: { role: 'user', content: 'one' } },
    { type: 'user', permissionMode: 'plan', timestamp: new Date(now - 1000).toISOString(), message: { role: 'user', content: 'two' } },
    { type: 'permission-mode', permissionMode: 'plan', sessionId: agent.sessionId },
  ]);
  const t = startSessionTailer({ agent });
  try { await sleep(250); } finally { t.stop(); cleanup(); }
  assert.equal(agent.permissionMode, 'plan');
});

test('0439/4: a stamped agent adopts a mode reported after its spawn', async () => {
  const stamp = Date.now() - 5000;
  const { agent, filePath, cleanup } = primeSetup({ permissionMode: 'acceptEdits', permissionModeArgvTs: stamp });
  writeJsonl(filePath, [
    { type: 'user', permissionMode: 'acceptEdits', timestamp: new Date(stamp - 60_000).toISOString(), message: { role: 'user', content: 'old' } },
    { type: 'user', permissionMode: 'plan', timestamp: new Date(stamp + 1000).toISOString(), message: { role: 'user', content: 'new' } },
    { type: 'permission-mode', permissionMode: 'plan', sessionId: agent.sessionId },
  ]);
  const t = startSessionTailer({ agent });
  try { await sleep(250); } finally { t.stop(); cleanup(); }
  assert.equal(agent.permissionMode, 'plan');
});

test('0439/4 guard: pre-spawn history does not override the mode claude was spawned with', async () => {
  // mc restarted claude with `--permission-mode plan`; the transcript tail is
  // the previous process's history ending in 'auto'. The live claude runs in
  // plan — the chip (and the saved record) must say plan.
  const stamp = Date.now() - 1000;
  const { agent, filePath, cleanup } = primeSetup({ permissionMode: 'plan', permissionModeArgvTs: stamp });
  writeJsonl(filePath, [
    { type: 'user', permissionMode: 'auto', timestamp: new Date(stamp - 60_000).toISOString(), message: { role: 'user', content: 'old' } },
    { type: 'permission-mode', permissionMode: 'auto', sessionId: agent.sessionId },
  ]);
  const t = startSessionTailer({ agent });
  try { await sleep(250); } finally { t.stop(); cleanup(); }
  assert.ok(agent.tail.some((e) => e.text === 'old'), 'the history was primed');
  assert.equal(agent.permissionMode, 'plan');
  assert.ok(!agent.tail.some((e) => /^permission mode → /.test(e.text || '')),
    'the fleet log never shows a mode the agent did not take');
});

test('0439/4 guard: an unknown replayed mode is never copied back', async () => {
  const { agent, filePath, cleanup } = primeSetup();
  writeJsonl(filePath, [
    { type: 'user', permissionMode: 'nope', timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } },
    { type: 'permission-mode', permissionMode: 'also-nope' },
  ]);
  const t = startSessionTailer({ agent });
  try { await sleep(250); } finally { t.stop(); cleanup(); }
  assert.equal(agent.permissionMode, 'acceptEdits');
});
