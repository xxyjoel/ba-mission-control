// tests/costStore.gc.test.mjs — verifies gc() bounds the weeks/days buckets.
//
// costStore accrues one `weeks` key per ISO-week and one `days` key per UTC-day
// for the whole install lifetime. gc() historically pruned only `lastSeen`, so
// the two bucket maps grew unbounded and were re-serialized on every persist()
// (task 0354). gc() must now also prune old buckets to a rolling window while
// always keeping the current week/day and the most-recent N.
//
// MC_CONFIG_DIR is redirected to a throwaway temp dir BEFORE importing the module
// (CONFIG_DIR is resolved at import time), so persist() never touches real config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mc-coststore-'));
const { CostStore, WEEKS_KEEP, DAYS_KEEP, isoWeek, isoDay } =
  await import('../tui/lib/costStore.js');

// Distinct, chronologically-sortable synthetic keys (same lexical order the real
// ISO week/day keys have), oldest first.
function synthWeeks(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const yr = 2000 + Math.floor(i / 52);
    const wk = (i % 52) + 1;
    out.push(`${yr}-W${String(wk).padStart(2, '0')}`);
  }
  return out;
}
function synthDays(n) {
  const out = [];
  let d = Date.UTC(2000, 0, 1);
  for (let i = 0; i < n; i++) { out.push(isoDay(new Date(d))); d += 86400000; }
  return out;
}

test('costStore.gc: prunes weeks/days to the rolling window, keeps current + recent', () => {
  const cs = new CostStore();

  const weekKeys = synthWeeks(WEEKS_KEEP + 120);
  const dayKeys = synthDays(DAYS_KEEP + 120);
  for (const k of weekKeys) cs.store.weeks[k] = 1;
  for (const k of dayKeys) cs.store.days[k] = 1;
  // Ensure the CURRENT buckets exist and are the largest (real dates > synthetic 2000s).
  const curWeek = isoWeek(), curDay = isoDay();
  cs.store.weeks[curWeek] = 42;
  cs.store.days[curDay] = 42;

  cs.gc([]); // no live agents; exercises pruning

  const weeks = Object.keys(cs.store.weeks);
  const days = Object.keys(cs.store.days);

  assert.ok(weeks.length <= WEEKS_KEEP, `weeks bounded: ${weeks.length} <= ${WEEKS_KEEP}`);
  assert.ok(days.length <= DAYS_KEEP, `days bounded: ${days.length} <= ${DAYS_KEEP}`);

  // Current buckets must survive (they are the most recent).
  assert.equal(cs.store.weeks[curWeek], 42, 'current week bucket retained');
  assert.equal(cs.store.days[curDay], 42, 'current day bucket retained');

  // The kept keys are the most-recent ones (largest lexically), not the oldest.
  assert.ok(weeks.includes(weekKeys[weekKeys.length - 1]), 'most-recent seeded week kept');
  assert.ok(!weeks.includes(weekKeys[0]), 'oldest seeded week dropped');
  assert.ok(days.includes(dayKeys[dayKeys.length - 1]), 'most-recent seeded day kept');
  assert.ok(!days.includes(dayKeys[0]), 'oldest seeded day dropped');
});

test('costStore.gc: no-op when buckets already within the window', () => {
  const cs = new CostStore();
  cs.store.weeks = { [isoWeek()]: 3 };
  cs.store.days = { [isoDay()]: 3 };
  cs.gc([]);
  assert.equal(Object.keys(cs.store.weeks).length, 1);
  assert.equal(Object.keys(cs.store.days).length, 1);
});
