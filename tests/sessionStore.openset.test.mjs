// tests/sessionStore.openset.test.mjs — `:resume-all` must restart ONLY the
// sessions that were open when mc closed, not every slot that ever held a
// session. Liveness is a per-record `live` flag (co-located on bySlot, so it
// can't desync from a parallel index) plus a recency window: a record is "open"
// when live !== false AND it synced within RESUME_RECENCY_MS of the last close.
// Killed slots (live=false) and stale leftovers stay in bySlot for manual
// :resume but drop out of the open set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-openset-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { syncFromSnapshot, listResumeRecords, listOpenResumeRecords, clearResumeRecord, loadSessions } =
  await import('../tui/lib/sessionStore.js');

// Real UUIDs — the store drops non-UUID sessionIds at load.
const UU = (n) => `0000000${n}-0000-4000-8000-000000000000`;
function agent(slot, sessionId, status = 'idle') {
  return { slot, status, id: `s${slot}`, sessionId, cwd: `/repo/${slot}`,
    branch: 'main', model: 'claude-sonnet-4-6', name: `repo-${slot}`, permissionMode: 'acceptEdits' };
}

test('openSlots: resume-all set = the slots live at the last sync', () => {
  // Two sessions open.
  syncFromSnapshot([agent(1, UU(1)), agent(2, UU(2))]);
  const open = listOpenResumeRecords().map(r => r.slot).sort();
  assert.deepEqual(open, [1, 2]);
});

test('openSlots: a killed slot leaves the open set but stays in bySlot', () => {
  // Slot 2 closed (now empty); only slot 1 remains live. The snapshot still
  // carries slot 2 as an empty placeholder, as the real fleet snapshot does.
  syncFromSnapshot([agent(1, UU(1)), { slot: 2, status: 'empty' }]);

  // resume-all set is now just slot 1 — slot 2 was not open at this sync.
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot), [1]);
  // …but slot 2's record is preserved for a manual `:resume 2`.
  assert.deepEqual(listResumeRecords().map(r => r.slot).sort(), [1, 2]);
});

test('openSlots: an all-empty snapshot PRESERVES the open set (boot / close)', () => {
  // Establish an open set of 1 + 2…
  syncFromSnapshot([agent(1, UU(1)), agent(2, UU(2))]);
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot).sort(), [1, 2]);
  // …then everything goes empty (terminal closed → children died, or fresh
  // boot before resume). This must NOT wipe the open set, or :resume-all on
  // boot would have nothing to restore.
  syncFromSnapshot([{ slot: 1, status: 'empty' }, { slot: 2, status: 'empty' }]);
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot).sort(), [1, 2]);
  assert.equal(listResumeRecords().length, 2);
});

test('openSlots: :forget drops the slot from both bySlot and the open set', () => {
  syncFromSnapshot([agent(1, UU(1)), agent(2, UU(2))]);
  clearResumeRecord(1);
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot), [2]);
  assert.deepEqual(listResumeRecords().map(r => r.slot), [2]);
  assert.ok(!loadSessions().bySlot[1]);
});

// ── Recency backstop ─────────────────────────────────────────
// These write the store file directly to control lastSeen deterministically.
const STORE = join(sandbox, 'sessions.json');
const rec = (slot, lastSeen, extra = {}) => ({
  sessionId: UU(slot), cwd: `/r/${slot}`, branch: 'main', model: 'claude-sonnet-4-6',
  name: `r${slot}`, permissionMode: 'acceptEdits', lastSeen, ...extra,
});

test('recency: a stale slot ages out of resume-all but stays in bySlot', () => {
  const REF = 1_700_000_000_000;
  // Slot 1 has no `live` field (legacy record) — must still count as open.
  // Slot 2 last synced 10 min before the last close — well outside the window.
  writeFileSync(STORE, JSON.stringify({
    version: 2, savedAt: REF, history: [], openSlots: [],
    bySlot: { 1: rec(1, REF), 2: rec(2, REF - 600_000) },
  }));
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot), [1]);
  assert.deepEqual(listResumeRecords().map(r => r.slot).sort(), [1, 2]);
});

test('recency: an explicitly-closed slot is excluded even when fresh', () => {
  const REF = 1_700_000_000_000;
  writeFileSync(STORE, JSON.stringify({
    version: 2, savedAt: REF, history: [], openSlots: [],
    bySlot: { 1: rec(1, REF, { live: true }), 2: rec(2, REF, { live: false }) },
  }));
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot), [1]);
});

test('live flag overrides recency: a stale live=true slot is still resumed', () => {
  // Guards the partial-resume case: after resuming one slot the timeline jumps
  // forward (here slot 1 is fresh, slot 2 lagging 10 min), but a slot explicitly
  // marked live must NOT be aged out — only legacy (no-flag) records expire.
  const REF = 1_700_000_000_000;
  writeFileSync(STORE, JSON.stringify({
    version: 2, savedAt: REF, history: [], openSlots: [],
    bySlot: { 1: rec(1, REF, { live: true }), 2: rec(2, REF - 600_000, { live: true }) },
  }));
  assert.deepEqual(listOpenResumeRecords().map(r => r.slot).sort(), [1, 2]);
});
