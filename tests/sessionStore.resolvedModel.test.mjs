// tests/sessionStore.resolvedModel.test.mjs — 0408/M1 (persistence side).
//
// A `/model` switch typed inside claude lands only in agent.resolvedModel;
// the record used to persist just the LAUNCH model, so a resume relaunched
// on the old model and silently undid the switch. The record now carries
// `resolvedModel` — the raw CLI id claude actually resolved to — and the
// resume path prefers it over `model` when building the launch.
//
// Record-field contract pinned here:
//   - bySlot record + history entry carry `resolvedModel: <cli id string>`
//     whenever the live agent reports one.
//   - a sync where the agent has NOT resolved yet (null — e.g. the window
//     right after a respawn/resume, before the first init event) must NOT
//     clobber the last-known value on the record.
//   - a NEW resolution replaces the stored one; a new session identity
//     starts clean (no stale carry-over).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-resolvedmodel-'));
process.env.MC_CONFIG_DIR = sandbox;

const { syncFromSnapshot, getResumeRecord, listHistory } =
  await import('../tui/lib/sessionStore.js');

const SID1 = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const agent = (over = {}) => ({
  slot: 3, status: 'idle', id: 's3', sessionId: SID1, cwd: '/repo/x',
  branch: 'main', model: 'opus-4.8', name: 'x', permissionMode: 'acceptEdits',
  resolvedModel: null, ...over,
});

test('a mid-session /model switch is persisted on the record and in history', () => {
  syncFromSnapshot([agent({ resolvedModel: 'claude-fable-5-1' })]);
  const rec = getResumeRecord(3);
  assert.equal(rec.model, 'opus-4.8', 'launch label still recorded');
  assert.equal(rec.resolvedModel, 'claude-fable-5-1', 'resolved model persisted');
  const h = listHistory().find(x => x.sessionId === SID1);
  assert.equal(h.resolvedModel, 'claude-fable-5-1', 'history carries it too');
});

test('an unresolved sync (null) does not clobber the stored resolution', () => {
  // The respawn/resume window: resolvedModel is null until the first event.
  syncFromSnapshot([agent({ resolvedModel: null })]);
  assert.equal(getResumeRecord(3).resolvedModel, 'claude-fable-5-1',
    'null must not erase the last-known resolution — a crash in this window would lose the switch');
});

test('a new resolution replaces the stored one', () => {
  syncFromSnapshot([agent({ resolvedModel: 'claude-opus-4-8' })]);
  assert.equal(getResumeRecord(3).resolvedModel, 'claude-opus-4-8');
});

test('a new session identity starts without a stale resolvedModel', () => {
  syncFromSnapshot([agent({ sessionId: SID2, resolvedModel: null })]);
  const rec = getResumeRecord(3);
  assert.equal(rec.sessionId, SID2);
  assert.equal(rec.resolvedModel, undefined, 'no carry-over across session identities');
});
