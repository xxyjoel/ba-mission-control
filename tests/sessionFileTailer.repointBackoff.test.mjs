// tests/sessionFileTailer.repointBackoff.test.mjs — the rotation-hunt backoff.
//
// Once a session's pinned file is dead, maybeRepoint() used to run the expensive
// findRotatedSession() (readdir + per-file stat over a possibly-1600+ file project
// dir) on EVERY 1.5s poll forever — the dominant idle CPU/disk drain (audit
// 2026-07-30, task 0356). shouldHuntRotation() gates that hunt to the backoff
// cadence: hunt on the first miss, then only every Nth poll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldHuntRotation } from '../server/sessionFileTailer.mjs';

test('shouldHuntRotation: hunts on miss 0, backs off, re-hunts every Nth poll', () => {
  const B = 8;
  assert.equal(shouldHuntRotation(0, B), true, 'first hunt runs');
  for (let i = 1; i < B; i++) {
    assert.equal(shouldHuntRotation(i, B), false, `poll ${i} skips the hunt`);
  }
  assert.equal(shouldHuntRotation(B, B), true, 're-hunts at the backoff boundary');
  assert.equal(shouldHuntRotation(2 * B, B), true, 're-hunts at 2×backoff');
  assert.equal(shouldHuntRotation(B + 1, B), false, 'skips again right after a re-hunt');
});

test('shouldHuntRotation: backoff <= 1 disables the backoff (always hunts)', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(shouldHuntRotation(i, 1), true, 'backoff=1 always hunts');
    assert.equal(shouldHuntRotation(i, 0), true, 'backoff=0 always hunts');
  }
});

test('shouldHuntRotation: only ~1-in-N polls hunt while frozen (drain bound)', () => {
  const B = 8;
  let hunts = 0;
  const POLLS = 800;
  for (let t = 0; t < POLLS; t++) if (shouldHuntRotation(t, B)) hunts++;
  // Without the backoff this would be 800; with it, ~POLLS/B.
  assert.equal(hunts, Math.ceil(POLLS / B), `${hunts} hunts over ${POLLS} polls`);
});
