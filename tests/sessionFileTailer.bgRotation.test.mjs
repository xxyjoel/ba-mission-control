// tests/sessionFileTailer.bgRotation.test.mjs — 0408-F1: the rotation hunt
// must never adopt a BACKGROUND FORK's transcript. claude forks a conversation
// into the background under a NEW sid in the SAME project dir; before this fix
// findRotatedSession took "newest uuid .jsonl" with no check of what it was,
// wrote the fork's sid into agent.sessionId, the store persisted it, and
// --resume resumed a conversation the user never opened.
//
// The FAIL-OPEN rule (bgSessions.mjs) is also pinned here: a NORMAL rotation
// (/clear, or a zoomSession-minted sid — any transcript without a
// sessionKind:'bg' record) must still be followed exactly as before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startSessionTailer, claudeProjectDir, findRotatedSession,
} from '../server/sessionFileTailer.mjs';
import { _resetKindCache } from '../server/bgSessions.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const mkSid = () => `0b2c3d4e-5f60-7189-abcd-${String(++n).padStart(12, '0')}`;

const userEvent = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
// The measured fork shape: inherited non-bg prefix, then a bg-tagged record.
const bgFork = (text) =>
  userEvent(text) +
  JSON.stringify({ type: 'attachment', sessionKind: 'bg', uuid: 'x' }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm1', content: [{ type: 'text', text: 'fork working' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: null } }) + '\n';

function setup() {
  _resetKindCache();
  const cwd = mkdtempSync(join(tmpdir(), 'mc-bgrot-'));
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId: mkSid(), status: 'idle', activity: '', tail: [], todos: [],
    tokensIn: 0, tokensOut: 0, context: 0, costSession: 0, resolvedModel: null,
    lastEventTs: 0, spawnedAt: Date.now() - 5000,
    appendTail(e) { this.tail.push(e); },
  });
  return { agent, cwd };
}
const fileFor = (cwd, sid) => join(claudeProjectDir(cwd), `${sid}.jsonl`);

test('findRotatedSession returns null when the only candidate is a bg fork', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('parent'));
  const fork = mkSid();
  writeFileSync(fileFor(cwd, fork), bgFork('parent'));
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt), null,
    '0408-F1: a background fork must never be adopted as the rotation target');
  rmSync(cwd, { recursive: true, force: true });
});

test('findRotatedSession skips a newer bg fork and returns the older NORMAL rotation', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('parent'));
  const clearRotation = mkSid();
  writeFileSync(fileFor(cwd, clearRotation), userEvent('post-clear conversation'));
  await sleep(5); // fork strictly newer by mtime
  const fork = mkSid();
  writeFileSync(fileFor(cwd, fork), bgFork('parent'));
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt), clearRotation,
    'the newest NON-bg candidate wins, not the newest file');
  rmSync(cwd, { recursive: true, force: true });
});

test('FAIL-OPEN: a normal rotation (no bg record anywhere) is still followed', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('A'));
  const sidB = mkSid();
  writeFileSync(fileFor(cwd, sidB), userEvent('B'));
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt), sidB,
    '/clear rotations and minted sids must rotate exactly as before (0187)');
  rmSync(cwd, { recursive: true, force: true });
});

test('tailer never re-points onto a bg fork (repro-rotation-bg shape) but still follows a real rotation', async () => {
  const { agent, cwd } = setup();
  const parent = agent.sessionId;
  writeFileSync(fileFor(cwd, parent), userEvent('parent-content'));

  const tailer = startSessionTailer({ agent, statPollMs: 25, rotateAfterFrozenPolls: 2, repointBackoff: 1 });
  await sleep(120);
  assert.equal(agent.sessionId, parent);

  // A background fork appears — newest file in the dir, bg-tagged.
  const fork = mkSid();
  writeFileSync(fileFor(cwd, fork), bgFork('parent-content'));
  await sleep(400);
  assert.equal(agent.sessionId, parent,
    '0408-F1: the slot must stay on the parent while the fork is the newest file');
  assert.ok(!agent.tail.some((e) => /session rotated/.test(e.text || '')),
    'no rotation breadcrumb for the refused fork');

  // A genuine rotation lands (newer than the fork) — the tailer follows it.
  await sleep(5);
  const rotated = mkSid();
  writeFileSync(fileFor(cwd, rotated), userEvent('ROTATED'));
  await sleep(400);
  assert.equal(agent.sessionId, rotated, 'a normal rotation is still adopted with a fork present');

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });
});
