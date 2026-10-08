// tests/sessionStore.persistOnChange.test.mjs — 0464: syncFromSnapshot writes
// sessions.json only on a real change.
//
// Before 0464, save mode (the default for a running session) marked the store
// dirty on EVERY sync, so an idle fleet rewrote sessions.json on every App
// re-render (11 rewrites in 30 s measured with a fake fleet). The record only
// needs a write when something in it changed, plus the existing >60 s
// lastSeen refresh that listOpenResumeRecords relies on.
//
// Uses snapshot-shaped agent records, not a real Fleet (see the 0464 Result).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-persist-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { syncFromSnapshot, setQuitMode, getResumeRecord } = await import('../tui/lib/sessionStore.js');

const UU = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const agent = (slot, extra = {}) => ({
  slot, status: 'idle', id: `s${slot}`, sessionId: UU(slot), provider: 'claude',
  cwd: `/repo/${slot}`, branch: 'main', model: 'claude-sonnet-4-6',
  name: `repo-${slot}`, permissionMode: 'acceptEdits',
  tokensIn: 200000, tokensOut: 50000, costSession: 1.23, ...extra,
});
const stamp = () => { const s = statSync(join(sandbox, 'sessions.json')); return `${s.ino}:${s.mtimeMs}`; };

for (const mode of ['save', 'clear']) {
  test(`0464 ${mode} mode: repeated syncs of an unchanged fleet do not rewrite sessions.json`, () => {
    setQuitMode(mode);
    assert.equal(syncFromSnapshot([agent(1), agent(2)]), true, 'first sync records the slots');
    // Settle the identity/live bookkeeping, then sample.
    syncFromSnapshot([agent(1), agent(2)]);
    const before = stamp();
    let writes = 0;
    for (let i = 0; i < 10; i++) if (syncFromSnapshot([agent(1), agent(2)])) writes++;
    assert.equal(writes, 0, `${writes} of 10 idle syncs reported a write`);
    assert.equal(stamp(), before, 'sessions.json was rewritten with nothing changed');
  });
}

test('0464 save mode: a real change (new totals) still persists', () => {
  setQuitMode('save');
  syncFromSnapshot([agent(3)]);
  syncFromSnapshot([agent(3)]);
  assert.equal(syncFromSnapshot([agent(3, { tokensOut: 60000, costSession: 1.5 })]), true);
  const rec = getResumeRecord(3);
  assert.equal(rec.tokensOut, 60000);
  assert.equal(rec.costSession, 1.5);
});
