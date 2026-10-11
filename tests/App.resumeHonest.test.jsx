// tests/App.resumeHonest.test.jsx — 0454. launchFromRecord used to return
// 'resumed' and seed the saved token/cost totals whenever fleet.resume
// returned, even when the agent fell back to a fresh `--session-id` because
// the transcript was missing (agent.resuming === false). The toast said
// "resumed" over an empty conversation carrying old totals.
//
// Now: resuming === false → "no saved transcript — opened fresh" (warn, same
// wording on :resume, multi-restore and :resume-all), totals not seeded. And a fleet
// refusal (sid already live in another slot) surfaces as a toast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0454-resume-honest');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const SID = '11111111-2222-3333-4444-555555555555';
const mount = (fleet) => render(React.createElement(App, { fleet, auth: AUTH }));
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

function seedRecords(slots, extra = {}) {
  const bySlot = {};
  for (const slot of slots) {
    bySlot[slot] = {
      slot, name: `saved-${slot}`, cwd: '/tmp', branch: 'main',
      model: 'claude-sonnet-4-6', permissionMode: 'default',
      sessionId: SID.replace(/5$/, String(slot)),
      tokensIn: 9000, tokensOut: 4000, tokensCacheRead: 700, costSession: 3.21,
      lastSeen: Date.now(), live: false, ...extra,
    };
  }
  writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({
    version: 2, savedAt: Date.now(), openSlots: [], history: [], bySlot,
  }, null, 2));
}

test('0454: transcript missing (resuming=false) → "no saved transcript — opened fresh", old totals not seeded', async () => {
  seedRecords([3]);
  const fleet = new FakeFleet([1]);
  const made = [];
  fleet.resumeAgent = (cfg) => { const a = { slot: cfg.slot, sessionId: cfg.sessionId, resuming: false }; made.push(a); return a; };
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const ts = toasts(lastFrame());
  assert.equal(made.length, 1, 'fleet.resume was called once');
  assert.ok(ts.some(t => /slot 3: no saved transcript — opened fresh/.test(t)), `toast says why it opened fresh; got ${JSON.stringify(ts)}`);
  assert.ok(!ts.some(t => /resumed slot 3/.test(t)), `must not claim resumed; got ${JSON.stringify(ts)}`);
  assert.equal(made[0].tokensIn, undefined, 'tokensIn not seeded');
  assert.equal(made[0].tokensOut, undefined, 'tokensOut not seeded');
  assert.equal(made[0].tokensCacheRead, undefined, 'tokensCacheRead not seeded');
  assert.equal(made[0].costSession, undefined, 'costSession not seeded');
  unmount();
});

test('0454: real resume (resuming=true) still says "resumed" and seeds totals', async () => {
  seedRecords([3]);
  const fleet = new FakeFleet([1]);
  const made = [];
  fleet.resumeAgent = (cfg) => { const a = { slot: cfg.slot, sessionId: cfg.sessionId, resuming: true }; made.push(a); return a; };
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const ts = toasts(lastFrame());
  assert.ok(ts.some(t => /^resumed slot 3/.test(t)), `got ${JSON.stringify(ts)}`);
  assert.equal(made[0].tokensIn, 9000);
  assert.equal(made[0].costSession, 3.21);
  unmount();
});

test('0454: multi-restore does not count a transcript-missing fallback as resumed', async () => {
  seedRecords([3, 4]);
  const fleet = new FakeFleet([]);
  fleet.resumeAgent = (cfg) => ({ slot: cfg.slot, sessionId: cfg.sessionId, resuming: cfg.slot !== 4 });
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3 4');
  const ts = toasts(lastFrame());
  assert.ok(ts.some(t => /resumed 1\/2/.test(t) && /1 opened fresh \(no saved transcript\)/.test(t)), `got ${JSON.stringify(ts)}`);
  unmount();
});

test('0454: a fleet refusal (sid live in another slot) shows as an error toast', async () => {
  seedRecords([3]);
  const fleet = new FakeFleet([1]);
  fleet.resumeAgent = (cfg) => { throw new Error(`session ${cfg.sessionId.slice(0, 8)} is already live in slot 1`); };
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const ts = toasts(lastFrame());
  assert.ok(ts.some(t => /resume failed: session 11111111 is already live in slot 1/.test(t)), `got ${JSON.stringify(ts)}`);
  unmount();
});

test('0454: :resume-all warns per slot when a planned resume opens fresh', async () => {
  seedRecords([3, 4], { live: true });
  const fleet = new FakeFleet([]);
  fleet.resumeAgent = (cfg) => ({ slot: cfg.slot, sessionId: cfg.sessionId, resuming: cfg.slot !== 4 });
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume-all');
  await tick(400); // past the broadcastStaggerMs gap for the second launch
  const ts = toasts(lastFrame());
  assert.equal(fleet.calls.filter(c => c[0] === 'resumeFromRecord').length, 2);
  assert.ok(ts.some(t => /slot 4: no saved transcript — opened fresh/.test(t)), `got ${JSON.stringify(ts)}`);
  assert.ok(!ts.some(t => /slot 3: no saved transcript/.test(t)), `slot 3 really resumed; got ${JSON.stringify(ts)}`);
  unmount();
});
