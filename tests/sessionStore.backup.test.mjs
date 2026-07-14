// tests/sessionStore.backup.test.mjs — pin the fix for audit #160.
//
// Failure modes we now guard against:
//   A. Existing sessions.json is corrupted (truncated, bad JSON, etc.)
//      → loadSessions() should recover from sessions.json.bak instead
//      of silently returning emptyStore(), which used to wipe every
//      resume record.
//   B. Write interrupted mid-flight (power loss, OOM, ctrl+c) → atomic
//      .tmp+rename means the main file is either the old content or
//      the new content, never half-written.
//
// We test against a real temp dir via MC_CONFIG_DIR so the store
// thinks it's writing to ~/.config/claude-mc but actually writes
// somewhere we can inspect and clean up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Inject MC_CONFIG_DIR BEFORE importing the store so its module-time
// resolution picks up the override.
const sandbox = mkdtempSync(join(tmpdir(), 'mc-sstore-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { loadSessions, syncFromSnapshot, listResumeRecords } = await import('../tui/lib/sessionStore.js');
const STORE_PATH  = join(sandbox, 'sessions.json');
const BAK_PATH    = join(sandbox, 'sessions.json.bak');
const TMP_PATH    = join(sandbox, 'sessions.json.tmp');

function makeAgent(slot, sessionId) {
  return {
    slot, status: 'idle',
    id: `s${slot}-test`,
    sessionId,
    cwd: '/tmp', branch: 'main', model: 'claude-sonnet-4-6',
    name: `repo-${slot}`, permissionMode: 'acceptEdits',
  };
}

test('sessionStore: corrupted main file falls back to .bak', async (t) => {
  t.after(() => {
    try { rmSync(STORE_PATH, { force: true }); } catch {}
    try { rmSync(BAK_PATH, { force: true }); } catch {}
  });
  // First write — establishes a known-good main file
  syncFromSnapshot([makeAgent(1, '11111111-1111-4111-8111-111111111111')]);
  assert.ok(existsSync(STORE_PATH), 'main file must be created on first sync');

  // Second write — copies the prior main → .bak BEFORE the new write
  syncFromSnapshot([makeAgent(1, '11111111-1111-4111-8111-111111111111'), makeAgent(2, '22222222-2222-4222-8222-222222222222')]);
  assert.ok(existsSync(BAK_PATH), '.bak must exist after second write');

  // Corrupt the main file
  writeFileSync(STORE_PATH, 'not valid json {{{');

  // Load should fall back to .bak — recovering the prior state, not emptyStore
  const recovered = loadSessions();
  assert.ok(recovered.bySlot, 'recovered store must have bySlot');
  // The .bak captures the FIRST sync's state (before the second write
  // copied main → .bak). So we expect slot-1's record present.
  assert.ok(recovered.bySlot[1], 'slot 1 record must be recovered from .bak');
  assert.equal(recovered.bySlot[1].sessionId, '11111111-1111-4111-8111-111111111111');
});

test('sessionStore: corrupted main + no .bak returns empty (not crash)', async (t) => {
  t.after(() => {
    try { rmSync(STORE_PATH, { force: true }); } catch {}
    try { rmSync(BAK_PATH, { force: true }); } catch {}
  });
  // Corrupt main, no bak
  writeFileSync(STORE_PATH, 'garbage');
  const recovered = loadSessions();
  assert.deepEqual(recovered.bySlot, {}, 'empty bySlot when no recovery source');
  assert.deepEqual(recovered.history, []);
});

test('sessionStore: atomic write — no stale .tmp left behind on success', async (t) => {
  t.after(() => {
    try { rmSync(STORE_PATH, { force: true }); } catch {}
    try { rmSync(BAK_PATH, { force: true }); } catch {}
    try { rmSync(TMP_PATH, { force: true }); } catch {}
  });
  syncFromSnapshot([makeAgent(1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]);
  assert.ok(existsSync(STORE_PATH), 'main exists');
  assert.ok(!existsSync(TMP_PATH), 'no stale .tmp after successful write');
  // And the main file is valid JSON
  const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  assert.equal(parsed.bySlot['1'].sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('sessionStore: backup contains the PRIOR state, not the new one', async (t) => {
  t.after(() => {
    try { rmSync(STORE_PATH, { force: true }); } catch {}
    try { rmSync(BAK_PATH, { force: true }); } catch {}
  });
  const OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  syncFromSnapshot([makeAgent(1, OLD)]);
  syncFromSnapshot([makeAgent(1, NEW)]);
  // .bak should snapshot OLD (the previous main), main should be NEW
  const main = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  const bak  = JSON.parse(readFileSync(BAK_PATH, 'utf8'));
  assert.equal(main.bySlot['1'].sessionId, NEW);
  assert.equal(bak.bySlot['1'].sessionId, OLD);
});

// Cleanup the sandbox dir on suite teardown
test('cleanup: sandbox dir removed', async () => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});
