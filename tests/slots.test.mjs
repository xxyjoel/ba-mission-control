// tests/slots.test.mjs — nextLaunchSlot append-to-bottom placement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextLaunchSlot } from '../tui/lib/slots.js';

// Build a snapshot-like agent list: occupied slots get status 'working',
// everything else up to `slots` is 'empty'.
function fleet(occupied, slots = 10) {
  const set = new Set(occupied);
  return Array.from({ length: slots }, (_, i) => ({
    slot: i + 1,
    status: set.has(i + 1) ? 'working' : 'empty',
  }));
}

test('slots: empty fleet → slot 1', () => {
  assert.equal(nextLaunchSlot(fleet([])), 1);
});

test('slots: contiguous active → appends below the last', () => {
  assert.equal(nextLaunchSlot(fleet([1, 2, 3, 4])), 5);
});

test('slots: a hole below the top does NOT get backfilled — append wins', () => {
  // 1,2,3,4 active, slot 2 killed → new session lands at 5, not 2.
  assert.equal(nextLaunchSlot(fleet([1, 3, 4])), 5);
});

test('slots: no room to append → falls back to the lowest hole', () => {
  // Top slot (10) still occupied, slot 5 is a hole → fill 5.
  assert.equal(nextLaunchSlot(fleet([1, 2, 3, 4, 6, 7, 8, 9, 10])), 5);
});

test('slots: full fleet → null', () => {
  assert.equal(nextLaunchSlot(fleet([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
});

test('slots: single active mid-grid → appends after it', () => {
  assert.equal(nextLaunchSlot(fleet([3])), 4);
});
