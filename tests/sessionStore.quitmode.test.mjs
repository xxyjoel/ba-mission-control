// tests/sessionStore.quitmode.test.mjs — "save is opt-in; everything else is a
// clear." A proper quit+save (setQuitMode('save'), the default during a running
// session) persists the FULL resumable record: sessionId + in/out/cost totals.
// Any non-save exit (setQuitMode('clear')) persists only the LOCATION, so
// `:resume-all` reopens the repo as a FRESH session (no sessionId, no totals).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-quitmode-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { syncFromSnapshot, setQuitMode, getResumeRecord, listOpenResumeRecords, loadSessions } =
  await import('../tui/lib/sessionStore.js');

const UU = (n) => `0000000${n}-0000-4000-8000-000000000000`;
function agent(slot, sessionId, extra = {}) {
  return {
    slot, status: 'idle', id: `s${slot}`, sessionId,
    cwd: `/repo/${slot}`, branch: 'main', model: 'claude-sonnet-4-6',
    name: `repo-${slot}`, permissionMode: 'acceptEdits',
    tokensIn: 200000, tokensOut: 50000, costSession: 1.23, ...extra,
  };
}

test('save mode: full record with sessionId + in/out/cost totals', () => {
  setQuitMode('save');
  syncFromSnapshot([agent(1, UU(1))]);
  const rec = getResumeRecord(1);
  assert.equal(rec.sessionId, UU(1));
  assert.equal(rec.fresh, false);
  assert.equal(rec.tokensIn, 200000);
  assert.equal(rec.tokensOut, 50000);
  assert.equal(rec.costSession, 1.23);
  assert.equal(rec.live, true);
});

test('clear mode: location-only record — no sessionId, no totals, fresh:true', () => {
  setQuitMode('clear');
  syncFromSnapshot([agent(1, UU(1))]);
  const rec = getResumeRecord(1);
  assert.equal(rec.fresh, true);
  assert.equal(rec.sessionId, undefined, 'clear must drop the sessionId');
  assert.equal(rec.tokensIn, undefined, 'clear must drop token totals');
  assert.equal(rec.costSession, undefined, 'clear must drop cost');
  assert.equal(rec.cwd, '/repo/1', 'but the location is kept');
  assert.equal(rec.live, true, 'still open at close → resume-all reopens it (fresh)');
});

test('clear-mode (location-only) record survives load — not purged for missing sessionId', () => {
  setQuitMode('clear');
  syncFromSnapshot([agent(2, UU(2))]);
  // loadSessions() purges records with an invalid sessionId, EXCEPT fresh ones.
  const store = loadSessions();
  assert.ok(store.bySlot[2], 'fresh record must not be purged');
  assert.equal(store.bySlot[2].fresh, true);
  // …and it's still in the open set so :resume-all picks it up.
  assert.ok(listOpenResumeRecords().some(r => r.slot === 2));
});

test('save → clear downgrades the same slot to location-only', () => {
  setQuitMode('save');
  syncFromSnapshot([agent(3, UU(3))]);
  assert.equal(getResumeRecord(3).sessionId, UU(3));
  // A later non-save exit overwrites the full record with a location-only one.
  setQuitMode('clear');
  syncFromSnapshot([agent(3, UU(3))]);
  const rec = getResumeRecord(3);
  assert.equal(rec.fresh, true);
  assert.equal(rec.sessionId, undefined);
});

// Restore the default so other suites importing the module aren't affected.
test('teardown: restore default quit mode', () => { setQuitMode('save'); });
