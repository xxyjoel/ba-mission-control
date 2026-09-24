// tests/nullValues.downstream.test.jsx — 0420: every consumer of the
// meterable snapshot fields (costSession, tokensIn/Out/CacheRead, context,
// spark, lastTokRate) must survive an agent that reports them as null — a
// provider that cannot measure them yet (D1: unknown is never zero).
//
// Contract: aggregates sum only KNOWN values, so a Claude-only fleet and the
// same fleet plus a null-valued slot render the same totals; nothing becomes
// NaN; the cost store never baselines, resets or deltas off a null; budgets
// see a null as $0 spent; the session store keeps null as null so a resume
// does not fabricate a zero.

import './lib/force-color.js';
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-0420-null-'));
process.env.MC_CONFIG_DIR = sandbox;

const { default: Aggregate } = await import('../tui/Aggregate.jsx');
const { default: Header } = await import('../tui/Header.jsx');
const { default: Dashboard } = await import('../tui/modals/Dashboard.jsx');
const { CostStore } = await import('../tui/lib/costStore.js');
const { syncFromSnapshot, getResumeRecord } = await import('../tui/lib/sessionStore.js');
const { THEMES } = await import('../tui/lib/themes.js');
const { MODELS, registerProviderModels } = await import('../tui/lib/models.js');

const theme = THEMES['BlueArch'];
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID_N = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const claudeA = {
  id: 's1-a', slot: 1, status: 'working', name: 'alpha', model: 'sonnet-4.6', cwd: '/tmp/a', branch: 'main',
  sessionId: SID_A, context: 80_000, tokensIn: 38_400, tokensOut: 12_100, tokensCacheRead: 900_000,
  costSession: 0.42, spark: [1, 2, 3], lastTokRate: 3200, permissionMode: 'default', workingStartTs: 1000,
};
const claudeB = {
  id: 's2-b', slot: 2, status: 'idle', name: 'beta', model: 'opus-4.8', cwd: '/tmp/b', branch: 'dev',
  sessionId: SID_B, context: 180_000, tokensIn: 2_400, tokensOut: 999, tokensCacheRead: 0,
  costSession: 2.1, spark: [0, 0, 1], lastTokRate: 0, permissionMode: 'plan',
};
const nullAgent = {
  id: 's3-n', slot: 3, status: 'working', name: 'gamma', model: 'cursor:composer-2.5', provider: 'cursor',
  cwd: '/tmp/n', branch: 'main', sessionId: SID_N,
  context: null, tokensIn: null, tokensOut: null, tokensCacheRead: null,
  costSession: null, spark: null, lastTokRate: null, permissionMode: 'default',
};
const empty = (slot) => ({ id: `empty-${slot}`, slot, status: 'empty', name: null, model: null });

const claudeOnly = [claudeA, claudeB, empty(3), empty(4)];
const mixed = [claudeA, claudeB, nullAgent, empty(4)];

function frameOf(el) {
  const { lastFrame, unmount } = render(el);
  const f = lastFrame() || '';
  unmount();
  return f;
}

test('Aggregate: a null-valued slot adds nothing — frame identical to the Claude-only fleet', () => {
  const props = { fleetTpm: 3200, aggSpark: [1, 2, 3], theme, usage: null, fmtReset: () => '', weekCost: 4.2, background: [] };
  const a = frameOf(<Aggregate agents={claudeOnly} {...props} />);
  const b = frameOf(<Aggregate agents={mixed} {...props} />);
  assert.equal(b, a);
  assert.doesNotMatch(strip(b), /NaN/);
  assert.match(strip(b), /tok·in 40\.8k↓/);
  assert.match(strip(b), /cost·session \$2\.52/);
});

test('Aggregate: an all-null fleet renders zero totals, never NaN', () => {
  const f = strip(frameOf(<Aggregate agents={[nullAgent]} fleetTpm={0} aggSpark={[]} theme={theme} fmtReset={() => ''} />));
  assert.doesNotMatch(f, /NaN/);
  assert.match(f, /cost·session \$0\.00/);
});

test('Header: over-threshold count ignores a null context; only the session count moves', () => {
  const props = { threshold: 150_000, nowStr: '12:00:00', sessionStr: '00:01:00', theme, auth: null, version: 'v' };
  const a = strip(frameOf(<Box width={240}><Header agents={claudeOnly} {...props} /></Box>));
  const b = strip(frameOf(<Box width={240}><Header agents={mixed} {...props} /></Box>));
  assert.match(a, /ctx≥150\.0k 1\/2/);
  assert.match(b, /ctx≥150\.0k 1\/3/);
  assert.equal(b.replace('3 sessions', '2 sessions').replace('work 2', 'work 1').replace('1/3', '1/2'), a);
});

test('Dashboard: Claude rows unchanged by a null-valued slot; its row shows placeholders, no NaN', () => {
  registerProviderModels('cursor', [{ id: 'composer-2.5', label: 'Composer 2.5' }]);
  try {
    const props = { threshold: 150_000, theme, weekCost: 4.2, dayCost: 1, budget: 0, initialSlot: 1, width: 120 };
    const a = strip(frameOf(<Dashboard agents={claudeOnly} {...props} />)).split('\n');
    const b = strip(frameOf(<Dashboard agents={mixed} {...props} />)).split('\n');
    for (const name of ['alpha', 'beta']) {
      assert.equal(b.find(l => l.includes(name)), a.find(l => l.includes(name)), `${name} row unchanged`);
    }
    const row = b.find(l => l.includes('gamma'));
    assert.ok(row, 'null-valued slot has a row');
    assert.doesNotMatch(row, /NaN/);
    assert.match(row, /\[3\] gamma +—  +●WORK +- +- +\$-\.-- /, `row: ${JSON.stringify(row)}`);
  } finally {
    delete MODELS['cursor:composer-2.5'];
  }
});

test('Dashboard: sorting by ctx / tpm / cost with a null-valued slot keeps Claude order and puts null last', async () => {
  const props = { threshold: 150_000, theme, weekCost: 0, dayCost: 0, budget: 0, initialSlot: 1, width: 120 };
  const tick = () => new Promise(r => setTimeout(r, 30));
  const order = async (agents, key) => {
    const { lastFrame, stdin, unmount } = render(<Dashboard agents={agents} {...props} />);
    await tick();
    const presses = ['slot', 'status', 'ctx', 'tpm', 'cost'].indexOf(key);
    for (let i = 0; i < presses; i++) { stdin.write('s'); await tick(); }
    const f = strip(lastFrame());
    unmount();
    assert.match(f, new RegExp(`sort: ${key}`));
    return ['alpha', 'beta', 'gamma'].filter(n => f.includes(n)).sort((x, y) => f.indexOf(x) - f.indexOf(y));
  };
  for (const key of ['ctx', 'tpm', 'cost']) {
    const a = await order(claudeOnly, key);
    const b = await order(mixed, key);
    assert.deepEqual(b, [...a, 'gamma'], `sort ${key}: ${JSON.stringify(b)}`);
  }
});

test('CostStore: null costSession never baselines, resets or deltas; budgets see $0', () => {
  const store = new CostStore();
  // Launch: claude A first sight at 0, null agent present.
  store.update([{ ...claudeA, costSession: 0 }, nullAgent]);
  assert.ok(!(SID_N in store.store.lastSeen), 'null does not create a baseline');
  let r = store.update([{ ...claudeA, costSession: 1.0 }, nullAgent]);
  assert.equal(r.weekCost, 1.0);
  assert.equal(r.dayCost, 1.0);

  // A transient null on a slot that HAD a value must not re-anchor lastSeen to 0
  // (that would re-count the whole total when the value returns).
  r = store.update([{ ...claudeA, costSession: null }, nullAgent]);
  assert.equal(store.store.lastSeen[SID_A], 1.0, 'lastSeen untouched by null');
  assert.equal(r.weekCost, 1.0);
  r = store.update([{ ...claudeA, costSession: 1.5 }, nullAgent]);
  assert.equal(r.weekCost, 1.5, 'only the real 0.5 delta accrued');

  // The null provider's first real figure is a baseline (0408/F2 rule).
  r = store.update([{ ...claudeA, costSession: 1.5 }, { ...nullAgent, costSession: 0.3 }]);
  assert.equal(r.weekCost, 1.5);
  assert.equal(store.store.lastSeen[SID_N], 0.3);
  r = store.update([{ ...claudeA, costSession: 1.5 }, { ...nullAgent, costSession: 0.5 }]);
  assert.ok(Math.abs(r.weekCost - 1.7) < 1e-9, `later deltas accrue (got ${r.weekCost})`);

  assert.ok(Math.abs(store.dayCost() - 1.7) < 1e-9);
  const disk = JSON.parse(readFileSync(join(sandbox, 'costs-week.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(disk), /NaN|null/);
});

test('CostStore: gc keeps a live null-valued slot harmless', () => {
  const store = new CostStore();
  store.gc([nullAgent, claudeA]);
  assert.doesNotMatch(JSON.stringify(store.store), /NaN/);
});

test('sessionStore: a null-valued slot saves null totals (not 0); Claude totals unchanged', () => {
  syncFromSnapshot([claudeA, nullAgent]);
  const a = getResumeRecord(1);
  assert.equal(a.tokensIn, 38_400);
  assert.equal(a.tokensCacheRead, 900_000);
  assert.equal(a.tokensOut, 12_100);
  assert.equal(a.costSession, 0.42);
  const n = getResumeRecord(3);
  assert.equal(n.tokensIn, null);
  assert.equal(n.tokensCacheRead, null);
  assert.equal(n.tokensOut, null);
  assert.equal(n.costSession, null);
});

test('sessionStore: an undefined total still saves 0 (legacy/mock shape unchanged)', () => {
  const legacy = { ...claudeB, slot: 5, sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  delete legacy.costSession; delete legacy.tokensIn;
  syncFromSnapshot([legacy]);
  const r = getResumeRecord(5);
  assert.equal(r.costSession, 0);
  assert.equal(r.tokensIn, 0);
});
