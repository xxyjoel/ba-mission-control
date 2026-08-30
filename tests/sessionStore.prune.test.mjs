// tests/sessionStore.prune.test.mjs — 0365: boot-time store hygiene +
// single-writer guard. The slot-identity-crossover substrate was a drifted
// sessions.json (15 slots on a 10-slot fleet, same repo under two slot
// numbers) produced by two mc instances sharing one config dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-prune-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { pruneSessions, loadSessions, setStoreReadOnly, syncFromSnapshot } =
  await import('../tui/lib/sessionStore.js');
const { acquireInstanceLock, releaseInstanceLock, LOCK_FILE } =
  await import('../tui/lib/instanceLock.js');

const UU = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const rec = (cwd, sid, extra = {}) => ({
  cwd, sessionId: sid, branch: 'main', model: 'opus-4.8', name: cwd.split('/').at(-1),
  permissionMode: 'auto', lastSeen: 1000, ...extra,
});

function seed(bySlot) {
  writeFileSync(join(sandbox, 'sessions.json'),
    JSON.stringify({ version: 2, savedAt: 2000, bySlot, history: [] }));
}

test('prune: drops out-of-range slots and dedupes same-repo records', () => {
  seed({
    2:  rec('/repo/forge', UU(1), { live: false, lastSeen: 500 }),   // stale forge dupe
    10: rec('/repo/forge', UU(2), { live: true, lastSeen: 900 }),    // live forge — wins
    13: rec('/repo/central', UU(3), { live: true }),                 // slot > fleet size
    4:  rec('/repo/caliper', UU(4), { live: true }),
  });
  const { dropped, deduped } = pruneSessions({ maxSlots: 10 });
  assert.equal(dropped, 1, 'slot 13 dropped (exceeds fleet size)');
  assert.equal(deduped, 1, 'one forge dupe removed');
  const store = loadSessions();
  assert.equal(store.bySlot[2], undefined, 'stale forge dupe gone');
  assert.ok(store.bySlot[10], 'live forge kept');
  assert.equal(store.bySlot[13], undefined);
  assert.ok(store.bySlot[4], 'unrelated record untouched');
});

test('prune: two LIVE records on the same repo are a dual-session — both kept', () => {
  seed({
    1: rec('/repo/mc', UU(5), { live: true }),
    2: rec('/repo/mc', UU(6), { live: true }),
  });
  const { deduped } = pruneSessions({ maxSlots: 10 });
  assert.equal(deduped, 0);
  const store = loadSessions();
  assert.ok(store.bySlot[1] && store.bySlot[2], 'both live same-repo sessions survive');
});

test('instance lock: second live holder → not ok; stale/dead holder → acquired', () => {
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid + 1e6, startedAt: 1 })); // dead pid
  assert.equal(acquireInstanceLock().ok, true, 'dead holder is stale — lock claimed');
  assert.equal(JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid, process.pid);

  // A LIVE foreign holder (use our own pid under a different identity guard:
  // simulate by writing pid 1 — launchd — which is always alive and never us).
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: 1, startedAt: 1 }));
  const res = acquireInstanceLock();
  assert.equal(res.ok, false, 'live foreign holder blocks');
  assert.equal(res.holderPid, 1);
  releaseInstanceLock(); // not ours — must NOT delete
  assert.equal(JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid, 1, 'foreign lock untouched');
});

test('read-only store: persist is a no-op while another instance owns the dir', () => {
  seed({ 1: rec('/repo/x', UU(7), { live: true }) });
  const before = readFileSync(join(sandbox, 'sessions.json'), 'utf8');
  setStoreReadOnly(true);
  try {
    syncFromSnapshot([{ slot: 2, status: 'idle', id: 's2', sessionId: UU(8), cwd: '/repo/y',
      branch: 'main', model: 'opus-4.8', name: 'y', permissionMode: 'auto' }]);
    assert.equal(readFileSync(join(sandbox, 'sessions.json'), 'utf8'), before,
      'sessions.json byte-identical — read-only instance never writes');
  } finally {
    setStoreReadOnly(false);
  }
});
