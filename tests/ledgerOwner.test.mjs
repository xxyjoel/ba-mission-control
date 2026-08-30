// tests/ledgerOwner.test.mjs — 0396: early-exit refusal classification.
// The 2026-08-12 guard demanded a non-zero exit + one exact phrase; a refusal
// exiting 0 or with drifted wording fell through to the restart loop
// (slot-5 error-toast storm, 2026-08-27). classifyEarlyExit is the hardened,
// pure replacement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEarlyExit, findLedgerOwner } from '../server/ledgerOwner.mjs';

test('classifies the canonical refusal phrase, any exit code implied', () => {
  const buf = 'Error: This session is currently running as a background agent.\n';
  assert.equal(classifyEarlyExit(buf, 1200), 'held-by-agent');
});

test('tolerates wording drift (already running / held by / in use by)', () => {
  for (const s of [
    'session already running as a background agent',
    'this session is held by a background agent',
    'session is in use by another process',
  ]) assert.equal(classifyEarlyExit(s, 500), 'held-by-agent', s);
});

test('outside the early window → null (replayed prose cannot suppress restarts)', () => {
  const buf = 'we discussed the background agent yesterday... currently running as a background agent';
  assert.equal(classifyEarlyExit(buf, 60_000), null, 'late exit is a crash, not a refusal');
});

test('ordinary crash output → null', () => {
  assert.equal(classifyEarlyExit('TypeError: cannot read properties of undefined', 900), null);
  assert.equal(classifyEarlyExit('', 900), null);
  assert.equal(classifyEarlyExit(null, 900), null);
});

test('findLedgerOwner: bad/missing ids and absent entries → null, never throws', () => {
  assert.equal(findLedgerOwner('not-a-uuid'), null);
  assert.equal(findLedgerOwner(null), null);
  assert.equal(findLedgerOwner('ffffffff-0000-4000-8000-000000000000'), null);
});
