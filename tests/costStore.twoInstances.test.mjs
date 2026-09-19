// tests/costStore.twoInstances.test.mjs — 0408/F4 regression (cost side).
//
// Two mc processes on one config dir: persist() used to blind-overwrite
// costs-week.json with the writer's whole in-memory store, so the last
// writer erased the other's spend (repro-cost-two-instances.mjs: disk said
// $5 where $15 was spent). persist() now folds only the deltas accrued
// since its last successful write onto the CURRENT on-disk buckets — and a
// read-only instance (instanceLock lost) never writes at all, keeping its
// deltas pending in case the mode is ever lifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-cost-two-'));
process.env.MC_CONFIG_DIR = sandbox;

const { CostStore } = await import('../tui/lib/costStore.js');
const { setReadOnlyMode, isReadOnlyMode } = await import('../tui/lib/instanceLock.js');

const SID = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const agent = (id, cost, sid) => ({ id, sessionId: sid, status: 'idle', costSession: cost });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

test('two instances merge deltas — no last-writer-wins (repro-cost-two-instances)', () => {
  const A = new CostStore();
  const B = new CostStore();
  // Both observe their sessions at $0 first (the launch snapshot), then spend.
  A.update([agent('a1', 0, SID('a'))]);
  B.update([agent('b1', 0, SID('b'))]);
  A.update([agent('a1', 10, SID('a'))]);   // A writes $10
  B.update([agent('b1', 5, SID('b'))]);    // B writes $5 — must MERGE, not clobber
  near(new CostStore().weekCost(), 15, 'disk carries BOTH instances’ spend');

  A.update([agent('a1', 11, SID('a'))]);   // A spends $1 more
  near(new CostStore().weekCost(), 16, 'later delta lands on the merged base');
  near(A.weekCost(), 16, 'A adopted the merged view (sees B’s spend too)');
});

test('read-only mode blocks every cost write; deltas stay pending', (t) => {
  t.after(() => setReadOnlyMode(false));
  const before = new CostStore().weekCost();

  setReadOnlyMode(true);
  assert.equal(isReadOnlyMode(), true);
  const C = new CostStore();
  C.update([agent('c1', 0, SID('c'))]);
  C.update([agent('c1', 2, SID('c'))]);          // $2 in-memory only
  near(C.weekCost(), before + 2, 'read-only instance still tracks its own view');
  near(new CostStore().weekCost(), before, 'disk untouched while read-only');

  // Mode lifted (e.g. tests / MC_ALLOW_MULTI flows): the pending deltas from
  // the blocked writes land with the next update's persist.
  setReadOnlyMode(false);
  C.update([agent('c1', 2.5, SID('c'))]);        // +$0.50 → persists $2.50 total
  near(new CostStore().weekCost(), before + 2.5, 'pending deltas were not lost');
});

test('a read-only instance never creates the store file either', (t) => {
  t.after(() => setReadOnlyMode(false));
  // Fresh dir cannot be simulated (CONFIG_DIR is bound at import) — assert on
  // the .tmp artifact instead: no write path may run at all in read-only mode.
  setReadOnlyMode(true);
  const D = new CostStore();
  D.update([agent('d1', 0, SID('d'))]);
  D.update([agent('d1', 1, SID('d'))]);
  assert.ok(!existsSync(join(sandbox, 'costs-week.json.tmp')), 'no stray .tmp from a blocked write');
});
