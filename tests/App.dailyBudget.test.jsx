// tests/App.dailyBudget.test.jsx — 0447: the daily budget (settings.dailyBudgetUSD
// vs costStore.dayCost()) is checked on EVERY launch path, not just
// launchSession. Before the fix only launchSession checked; launchFromRecord
// (:resume, multi-restore, :resume-all, boot auto-resume), :clear/:restart and
// :cr called fleet.launch / fleet.resume directly and spent past the budget.
//
// Each test: today's spend $10, budget $5 → the path must not reach
// fleet.launch / fleet.resume and must toast the budget message. The
// resume-all and :cr tests also prove the check runs at the moment of the
// (delayed) launch, with the CURRENT budget, not only when it was scheduled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0447-budget');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');
const { isoDay, isoWeek } = await import('../tui/lib/costStore.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const mount = (fleet) => render(React.createElement(App, { fleet, auth: AUTH }));
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());
const BUDGET_RX = /daily budget reached/;
const launches = (fleet) => fleet.calls.filter(c => c[0] === 'launch' || c[0] === 'resumeFromRecord');

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

function reset({ budget = 5, spent = 10, settings = {}, sessions = null, templates = null } = {}) {
  for (const f of ['settings.json', 'settings.json.bak', 'costs-week.json', 'costs-week.json.bak',
    'sessions.json', 'sessions.json.bak', 'templates.json']) {
    try { rmSync(join(CFG, f), { force: true }); } catch {}
  }
  writeFileSync(join(CFG, 'settings.json'), JSON.stringify({
    dailyBudgetUSD: budget, broadcastStaggerMs: 150, plugin_compactRestart: true, ...settings,
  }));
  writeFileSync(join(CFG, 'costs-week.json'), JSON.stringify({
    currentWeek: isoWeek(), currentDay: isoDay(),
    weeks: { [isoWeek()]: spent }, days: { [isoDay()]: spent }, lastSeen: {},
  }));
  if (sessions) {
    writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({
      version: 2, savedAt: Date.now(), openSlots: [], history: [], bySlot: sessions,
    }));
  }
  if (templates) writeFileSync(join(CFG, 'templates.json'), JSON.stringify(templates));
}

const rec = (over = {}) => ({
  name: 'saved-repo', cwd: '/tmp', branch: 'main', model: 'sonnet-4.6', permissionMode: 'default',
  sessionId: '11111111-2222-3333-4444-555555555555', lastSeen: Date.now(), live: true, ...over,
});

test('0447 launchSession (:template): over budget → refused with the budget toast', async () => {
  reset({ templates: { one: { description: 'x', sessions: [{ model: 'sonnet-4.6', permissionMode: 'plan' }] } } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'template one /tmp');
  assert.deepEqual(launches(fleet), [], `no launch; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('0447 :resume <slot>: over budget → no fleet.resume, budget toast', async () => {
  reset({ sessions: { 3: rec() } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  assert.deepEqual(launches(fleet), [], `no resume; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  assert.ok(!toasts(lastFrame()).some(t => /resumed slot 3/.test(t)), 'no false "resumed" toast');
  unmount();
});

test('0447 :resume <a> <b> (multi-restore): over budget → nothing launched', async () => {
  reset({ sessions: { 3: rec(), 4: rec({ fresh: true, sessionId: undefined }) } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3 4');
  assert.deepEqual(launches(fleet), [], `no launch/resume; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('0447 :resume-all: over budget → no launch, including the staggered ones', async () => {
  reset({ sessions: { 2: rec({ fresh: true, sessionId: undefined }), 4: rec({ lastSeen: Date.now() - 1000 }) } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume-all');
  await tick(400); // past the broadcastStaggerMs gap
  assert.deepEqual(launches(fleet), [], `no launch/resume; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('0447 :resume-all: budget crossed DURING the stagger → the delayed launch is refused', async () => {
  // Budget disabled when scheduled: the first (immediate) launch goes through.
  // Then the budget is set below today's spend before the second, delayed
  // launch fires — the check must run inside that delayed launch, with the
  // current budget (not the one captured at schedule time).
  reset({ budget: 0, settings: { broadcastStaggerMs: 600 },
    sessions: { 2: rec({ fresh: true, sessionId: undefined }), 4: rec({ lastSeen: Date.now() - 1000 }) } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume-all');
  assert.equal(launches(fleet).length, 1, `first launch immediate; calls: ${JSON.stringify(fleet.calls)}`);
  await type(stdin, 'budget 5');
  await tick(800);
  assert.equal(launches(fleet).length, 1, `delayed launch refused; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('0447 boot auto-resume: over budget → nothing launched', async () => {
  reset({ settings: { autoResumeOnStart: true }, sessions: { 3: rec() } });
  const fleet = new FakeFleet([]);
  const { lastFrame, unmount } = mount(fleet);
  await tick(700); // boot hook fires at 500ms
  assert.deepEqual(launches(fleet), [], `no launch/resume; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  assert.ok(!toasts(lastFrame()).some(t => /auto-resuming/.test(t)), 'no false "auto-resuming N" toast');
  unmount();
});

for (const verb of ['clear', 'restart']) {
  test(`0447 :${verb}: over budget → the live session is NOT killed and nothing relaunches`, async () => {
    reset();
    const fleet = new FakeFleet([1]);
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, verb);
    await tick(150); // past the 50ms relaunch defer
    assert.deepEqual(launches(fleet), [], `no relaunch; calls: ${JSON.stringify(fleet.calls)}`);
    assert.ok(!fleet.calls.some(c => c[0] === 'kill'), 'a session we cannot replace is not killed');
    assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
    unmount();
  });
}

test('0447 :cr: over budget → no summary request, no kill, no relaunch', async () => {
  reset();
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'cr');
  assert.ok(!fleet.calls.some(c => c[0] === 'send'), `no summary prompt sent; calls: ${JSON.stringify(fleet.calls)}`);
  assert.ok(!fleet.calls.some(c => c[0] === 'kill'));
  assert.deepEqual(launches(fleet), []);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('0447 :cr: budget crossed while waiting for the summary → no kill, no relaunch', async () => {
  reset({ budget: 0 });
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'cr');
  assert.ok(fleet.calls.some(c => c[0] === 'send'), 'summary requested while under budget');
  await type(stdin, 'budget 5');
  fleet.agentBySlot(1).tail.push({ kind: 'asst', text: 'S'.repeat(80) });
  await tick(900); // poll interval is 600ms
  assert.ok(!fleet.calls.some(c => c[0] === 'kill'), `session kept; calls: ${JSON.stringify(fleet.calls)}`);
  assert.deepEqual(launches(fleet), []);
  assert.ok(toasts(lastFrame()).some(t => BUDGET_RX.test(t)), JSON.stringify(toasts(lastFrame())));
  assert.ok(toasts(lastFrame()).some(t => /compact-restart abandoned/.test(t)), 'says :cr was abandoned');
  unmount();
});

test('0447 under budget: :resume <slot> still resumes (no false refusal)', async () => {
  reset({ budget: 50, sessions: { 3: rec() } });
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  assert.equal(launches(fleet).length, 1);
  assert.ok(!toasts(lastFrame()).some(t => BUDGET_RX.test(t)));
  unmount();
});
