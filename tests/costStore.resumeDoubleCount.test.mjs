// tests/costStore.resumeDoubleCount.test.mjs — 0408/F2 regression.
//
// `lastSeen` used to be keyed by AGENT id, which the fleet re-mints on every
// launch (`s<slot>-<Date.now()>`), while `:resume-all` restores the saved
// costSession total onto the new agent. Every resume therefore counted the
// whole restored total as brand-new spend: $4.20 → resume → $8.40 → resume →
// $12.60 with zero real spend (repro-cost-double.mjs), and dailyBudgetUSD
// could trip on boot.
//
// Fix contract, pinned here:
//   1. lastSeen is keyed by SESSION id — stable across resumes.
//   2. The FIRST sight of a session key is a baseline, never a delta — so a
//      restored total is absorbed even when the entry was gc'd between runs.
//   3. Real new spend after a resume still accrues.
//   4. Legacy agent-id-shaped lastSeen keys are dropped at load (migration).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-cost-resume-'));
process.env.MC_CONFIG_DIR = sandbox;

const { CostStore } = await import('../tui/lib/costStore.js');

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agent = (id, cost, sessionId) => ({ id, sessionId, status: 'idle', costSession: cost });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

test('a restored costSession is not re-counted across resumes (repro-cost-double)', () => {
  // Run 1: the session spends $4.20 over the day.
  const run1 = new CostStore();
  run1.update([agent('s1-run1x', 0, SID_A)]);      // launch: first sight at $0
  const r1 = run1.update([agent('s1-run1x', 4.20, SID_A)]);
  near(r1.weekCost, 4.20, 'run 1 spend counts');

  // Run 2: mc restarts, :resume-all mints a NEW agent id and restores the
  // $4.20 total. Zero new spend → the week must stay at $4.20.
  const run2 = new CostStore();
  const r2 = run2.update([agent('s1-run2x', 4.20, SID_A)]);
  near(r2.weekCost, 4.20, 'first resume adds nothing');

  // Run 3: resumed again the same day.
  const run3 = new CostStore();
  const r3 = run3.update([agent('s1-run3x', 4.20, SID_A)]);
  near(r3.weekCost, 4.20, 'second resume adds nothing');

  // New spend on the resumed session still counts.
  const r4 = run3.update([agent('s1-run3x', 5.00, SID_A)]);
  near(r4.weekCost, 5.00, 'post-resume spend accrues from the restored anchor');
});

test('a gc-dropped lastSeen entry cannot resurrect the restored total (first-sight baseline)', () => {
  const cs = new CostStore();
  const before = cs.weekCost();
  cs.update([agent('x1', 0, SID_B)]);
  cs.update([agent('x1', 3.00, SID_B)]);         // +$3 real spend
  cs.gc([]);                                     // session exited → entry dropped
  assert.ok(!(SID_B in cs.store.lastSeen), 'gc dropped the exited session');

  const resumed = new CostStore();               // next boot, entry gone from disk
  const r = resumed.update([agent('x2', 3.00, SID_B)]);
  near(r.weekCost, before + 3.00, 'restored total absorbed as baseline, not delta');
});

test('lastSeen persists keyed by sessionId, and legacy agent-id keys are dropped at load', () => {
  // SID_B is the most recent live session persisted above (test 2's gc
  // dropped older entries — that's its job).
  const onDisk = JSON.parse(readFileSync(join(sandbox, 'costs-week.json'), 'utf8'));
  assert.ok(SID_B in onDisk.lastSeen, 'session key persisted');

  // Legacy shape: agent-id keys from the pre-fix era.
  onDisk.lastSeen['s1-lkj4x2'] = 1.0;
  onDisk.lastSeen['slot-3'] = 2.0;
  writeFileSync(join(sandbox, 'costs-week.json'), JSON.stringify(onDisk));
  const cs = new CostStore();
  assert.ok(!('s1-lkj4x2' in cs.store.lastSeen), 'legacy s<slot>-<ts> key dropped');
  assert.ok(!('slot-3' in cs.store.lastSeen), 'legacy slot-<n> key dropped');
  assert.ok(SID_B in cs.store.lastSeen, 'session keys survive the migration');
});
