// tests/sessionStore.provider.test.mjs — 0420: saved sessions remember which
// provider ran them, so `:resume-all` relaunches a Cursor slot as Cursor.
// Records written before 0420 carry no `provider` and read back as 'claude'
// (read-time migration, beside MODEL_ID_MIGRATIONS). Templates gain the same
// optional field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-0420-provider-store-'));
process.env.MC_CONFIG_DIR = sandbox;

const {
  syncFromSnapshot, getResumeRecord, listResumeRecords, listOpenResumeRecords, listHistory,
} = await import('../tui/lib/sessionStore.js');
const { getTemplate, loadTemplates, templateSessionProvider } = await import('../tui/lib/templateStore.js');

const SID1 = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const SID3 = '33333333-3333-4333-8333-333333333333';
const agent = (over = {}) => ({
  slot: 1, status: 'idle', id: 's1', sessionId: SID1, cwd: '/repo/a', branch: 'main',
  model: 'opus-4.8', name: 'a', permissionMode: 'acceptEdits', ...over,
});

test('syncFromSnapshot writes provider onto the bySlot record and the history entry', () => {
  syncFromSnapshot([
    agent({ provider: 'claude' }),
    agent({ slot: 2, id: 's2', sessionId: SID2, cwd: '/repo/b', provider: 'cursor', model: 'cursor:auto' }),
  ]);
  assert.equal(getResumeRecord(1).provider, 'claude');
  assert.equal(getResumeRecord(2).provider, 'cursor');
  const raw = JSON.parse(readFileSync(join(sandbox, 'sessions.json'), 'utf8'));
  assert.equal(raw.bySlot['2'].provider, 'cursor');
  assert.equal(raw.history.find(h => h.sessionId === SID2).provider, 'cursor');
  assert.equal(listHistory().find(h => h.sessionId === SID2).provider, 'cursor');
});

test('an agent snapshot without provider is saved as claude', () => {
  syncFromSnapshot([agent({ slot: 4, id: 's4', sessionId: SID3, cwd: '/repo/d' })]);
  assert.equal(getResumeRecord(4).provider, 'claude');
});

test('pre-0420 records (no provider field) read back as claude on every read path', () => {
  const now = Date.now();
  writeFileSync(join(sandbox, 'sessions.json'), JSON.stringify({
    version: 2, savedAt: now, openSlots: [],
    bySlot: {
      3: { sessionId: SID3, cwd: '/repo/c', branch: 'main', model: 'sonnet-4.5', name: 'c', permissionMode: 'plan', lastSeen: now, live: true },
      5: { sessionId: SID2, cwd: '/repo/e', branch: 'main', model: 'cursor:auto', name: 'e', permissionMode: 'default', provider: 'cursor', lastSeen: now, live: true },
    },
    history: [{ sessionId: SID3, cwd: '/repo/c', model: 'opus-4.1', name: 'c', lastSeen: now }],
  }));
  const r3 = getResumeRecord(3);
  assert.equal(r3.provider, 'claude');
  assert.equal(r3.model, 'sonnet-4.6', 'model migration still applies');
  assert.equal(getResumeRecord(5).provider, 'cursor');
  assert.equal(listResumeRecords().find(r => r.slot === 3).provider, 'claude');
  assert.equal(listOpenResumeRecords().find(r => r.slot === 5).provider, 'cursor');
  const h = listHistory().find(x => x.sessionId === SID3);
  assert.equal(h.provider, 'claude');
  assert.equal(h.model, 'opus-4.7');
});

test('templates: provider is optional and defaults to claude', () => {
  const all = loadTemplates();
  assert.ok(all.review, 'bundled defaults load');
  for (const s of getTemplate('review').sessions) assert.equal(templateSessionProvider(s), 'claude');
  assert.equal(templateSessionProvider({ model: 'cursor:auto', provider: 'cursor' }), 'cursor');
  assert.equal(templateSessionProvider({}), 'claude');
  assert.equal(templateSessionProvider(null), 'claude');
});
