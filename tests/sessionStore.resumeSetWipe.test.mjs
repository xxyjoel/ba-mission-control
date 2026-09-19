// tests/sessionStore.resumeSetWipe.test.mjs — 0408/F5 regression.
//
// syncFromSnapshot used to mark EVERY stored slot live:false the moment ONE
// slot in the snapshot was live. On a fresh boot (autoResumeOnStart off),
// launching a single new session before `:resume-all` therefore closed all
// of yesterday's dormant records — [1,2,3] → [4] — and there was nothing
// left to resume (repro-resume-set-wipe.mjs).
//
// Fix contract: a slot may only be marked closed by a process that has
// PREVIOUSLY OBSERVED it live (per-process seenLive set). A dormant record
// from a previous run is untouchable until this run resumes it.
//
// Each "mc process" here is a fresh module instance via a query-busted
// dynamic import (same pattern as templateStore.test.mjs) — module state
// (the seenLive set) resets, the on-disk store persists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-resume-wipe-'));
process.env.MC_CONFIG_DIR = sandbox;

const UU = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const live = (slot) => ({
  slot, status: 'idle', id: `sx${slot}`, sessionId: UU(slot), cwd: `/r/${slot}`,
  branch: 'main', model: 'opus-4.8', name: `r${slot}`, permissionMode: 'acceptEdits',
});
const empty = (slot) => ({ slot, status: 'empty' });

test('a new session in a fresh process does NOT wipe the dormant resume set', async () => {
  // Yesterday's mc: three sessions open at quit (save mode is the default).
  const run1 = await import('../tui/lib/sessionStore.js?f5=run1');
  run1.syncFromSnapshot([live(1), live(2), live(3)]);
  assert.deepEqual(run1.listOpenResumeRecords().map(r => r.slot).sort(), [1, 2, 3]);

  // Today's mc (NEW process): the user opens ONE new session in slot 4 first;
  // the app's sync tick runs. Slots 1-3 were never live in THIS process.
  const run2 = await import('../tui/lib/sessionStore.js?f5=run2');
  run2.syncFromSnapshot([empty(1), empty(2), empty(3), live(4)]);
  assert.deepEqual(
    run2.listOpenResumeRecords().map(r => r.slot).sort(),
    [1, 2, 3, 4],
    'yesterday’s sessions must remain resumable after launching one new session',
  );
});

test('a slot THIS process saw live is still closed when killed', async () => {
  const run2 = await import('../tui/lib/sessionStore.js?f5=run2'); // same "process"
  // Slot 4 (seen live above) is killed while a new slot 5 goes live.
  run2.syncFromSnapshot([empty(1), empty(2), empty(3), empty(4), live(5)]);
  assert.deepEqual(
    run2.listOpenResumeRecords().map(r => r.slot).sort(),
    [1, 2, 3, 5],
    'a deliberate kill still leaves the open set; dormant slots still protected',
  );
  const rec4 = run2.listResumeRecords().find(r => r.slot === 4);
  assert.equal(rec4.live, false, 'the killed slot is marked closed for manual :resume');
});

test('the resumed dormant slots close normally once this process resumes them', async () => {
  const run2 = await import('../tui/lib/sessionStore.js?f5=run2');
  // The user resumes slot 1 (it becomes live in this process), then kills it.
  run2.syncFromSnapshot([live(1), empty(2), empty(3), empty(4), live(5)]);
  run2.syncFromSnapshot([empty(1), empty(2), empty(3), empty(4), live(5)]);
  assert.deepEqual(
    run2.listOpenResumeRecords().map(r => r.slot).sort(),
    [2, 3, 5],
    'once observed live here, a slot participates in normal close-marking again',
  );
});
