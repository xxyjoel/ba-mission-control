// tests/App.provider.test.jsx — 0420: App routes `provider` to the fleet and
// keeps Claude-only verbs off Cursor slots.
//
//   - launch paths (template launch → launchSession, :resume / :resume-all →
//     launchFromRecord, :clear relaunch) hand fleet.launch/resume the
//     provider; a Claude launch toast is byte-for-byte what it was.
//   - a Cursor launch toast names the provider and the catalog label.
//   - :compact / :compact-restart on a Cursor slot toast "not available for
//     Cursor slots" and never send; :update counts only Claude sessions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0420-app-provider');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');
const { MODELS, registerProviderModels } = await import('../tui/lib/models.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const mount = (fleet) => render(React.createElement(App, { fleet, auth: AUTH }));
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

// FakeFleet with the given slots turned into Cursor agents.
function fleetWith(liveSlots, cursorSlots = []) {
  const f = new FakeFleet(liveSlots);
  for (const s of cursorSlots) {
    const a = f._snap.agents[s - 1];
    Object.assign(a, {
      provider: 'cursor', model: 'cursor:composer-2.5',
      costSession: null, tokensIn: null, tokensOut: null, context: null, spark: null, lastTokRate: null,
    });
  }
  return f;
}

function seedSessions(bySlot) {
  writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({
    version: 2, savedAt: Date.now(), openSlots: [], history: [], bySlot,
  }, null, 2));
}
function clearStore() {
  for (const f of ['sessions.json', 'sessions.json.bak', 'templates.json']) {
    try { rmSync(join(CFG, f), { force: true }); } catch {}
  }
}
const rec = (over = {}) => ({
  name: 'saved-repo', cwd: '/tmp', branch: 'main', model: 'sonnet-4.6', permissionMode: 'default',
  sessionId: '11111111-2222-3333-4444-555555555555', lastSeen: Date.now(), live: true, ...over,
});

registerProviderModels('cursor', [{ id: 'composer-2.5', label: 'Composer 2.5' }, { id: 'auto', label: 'Auto (default)' }]);

test('template launch: claude session → provider claude, toast unchanged', async () => {
  clearStore();
  writeFileSync(join(CFG, 'templates.json'), JSON.stringify({
    one: { description: 'x', sessions: [{ model: 'sonnet-4.6', permissionMode: 'plan', prompt: null }] },
  }));
  const fleet = fleetWith([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'template one /tmp');
  const call = fleet.calls.find(c => c[0] === 'launch');
  assert.ok(call, JSON.stringify(fleet.calls));
  assert.equal(call[1].provider, 'claude');
  assert.equal(call[1].model, 'sonnet-4.6');
  assert.ok(toasts(lastFrame()).includes('launched slot 1 · sonnet-4.6 · plan'), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('template launch: cursor session → provider cursor, toast names Cursor + label + mode', async () => {
  clearStore();
  writeFileSync(join(CFG, 'templates.json'), JSON.stringify({
    cur: { description: 'x', sessions: [{ provider: 'cursor', model: 'cursor:composer-2.5', permissionMode: 'ask' }] },
  }));
  const fleet = fleetWith([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'template cur /tmp');
  const call = fleet.calls.find(c => c[0] === 'launch');
  assert.equal(call[1].provider, 'cursor');
  assert.equal(call[1].model, 'cursor:composer-2.5');
  assert.equal(call[1].permissionMode, 'ask');
  assert.ok(toasts(lastFrame()).includes('launched slot 1 · Cursor · Composer 2.5 · ask'), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test('template launch: cursor session with no mode maps the Claude default permission (D4)', async () => {
  clearStore();
  writeFileSync(join(CFG, 'templates.json'), JSON.stringify({
    cur: { description: 'x', sessions: [{ provider: 'cursor', model: 'cursor:auto' }] },
  }));
  const fleet = fleetWith([]);
  const { stdin, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'template cur /tmp');
  const call = fleet.calls.find(c => c[0] === 'launch');
  assert.equal(call[1].provider, 'cursor');
  // settings.defaultPermission is a Claude mode; cursorModeFor maps it.
  assert.ok(['default', 'plan', 'ask', 'auto-review', 'force'].includes(call[1].permissionMode), call[1].permissionMode);
  unmount();
});

test(':resume <slot> routes a cursor record to fleet.resume with provider cursor, no zero seeding', async () => {
  seedSessions({ 3: rec({ provider: 'cursor', model: 'cursor:auto', permissionMode: 'plan', costSession: null, tokensIn: null }) });
  const fleet = fleetWith([]);
  const seeded = { costSession: null, tokensIn: null };
  fleet.resume = (cfg) => { fleet.calls.push(['resumeFromRecord', cfg]); return seeded; };
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const call = fleet.calls.find(c => c[0] === 'resumeFromRecord');
  assert.ok(call, JSON.stringify(fleet.calls));
  assert.equal(call[1].provider, 'cursor');
  assert.equal(call[1].model, 'cursor:auto');
  assert.equal(seeded.costSession, null, 'a null saved total stays null');
  assert.equal(seeded.tokensIn, null);
  assert.ok(toasts(lastFrame()).some(t => /resumed slot 3/.test(t)));
  clearStore();
  unmount();
});

test(':resume <slot> on a pre-0420 record (no provider) resumes as claude', async () => {
  seedSessions({ 3: rec() });
  const fleet = fleetWith([]);
  const { stdin, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const call = fleet.calls.find(c => c[0] === 'resumeFromRecord');
  assert.equal(call[1].provider, 'claude');
  clearStore();
  unmount();
});

test(':resume-all launches a fresh cursor record through fleet.launch with provider cursor', async () => {
  seedSessions({
    2: rec({ fresh: true, sessionId: undefined, provider: 'cursor', model: 'cursor:auto', cwd: '/tmp/c' }),
    4: rec({ cwd: '/tmp/d', sessionId: '44444444-2222-3333-4444-555555555555' }),
  });
  const fleet = fleetWith([]);
  const { stdin, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume-all');
  const launch = fleet.calls.find(c => c[0] === 'launch');
  const resume = fleet.calls.find(c => c[0] === 'resumeFromRecord');
  assert.equal(launch[1].provider, 'cursor');
  assert.equal(launch[1].slot, 2);
  assert.equal(resume[1].provider, 'claude');
  assert.equal(resume[1].slot, 4);
  clearStore();
  unmount();
});

test(':compact on a cursor slot is refused without sending', async () => {
  clearStore();
  const fleet = fleetWith([1], [1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'compact');
  assert.ok(!fleet.calls.some(c => c[0] === 'send'), JSON.stringify(fleet.calls));
  assert.ok(toasts(lastFrame()).some(t => /not available for Cursor slots/.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test(':compact on a claude slot still sends the summary prompt', async () => {
  clearStore();
  const fleet = fleetWith([1]);
  const { stdin, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'compact');
  assert.ok(fleet.calls.some(c => c[0] === 'send' && c[1] === 1));
  unmount();
});

test(':compact-restart on a cursor slot is refused (when the plugin is on)', async () => {
  clearStore();
  writeFileSync(join(CFG, 'settings.json'), JSON.stringify({ plugin_compactRestart: true }));
  const fleet = fleetWith([1], [1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'compact-restart');
  assert.ok(!fleet.calls.some(c => c[0] === 'send'));
  assert.ok(toasts(lastFrame()).some(t => /not available for Cursor slots/.test(t)), JSON.stringify(toasts(lastFrame())));
  rmSync(join(CFG, 'settings.json'), { force: true });
  unmount();
});

test(':clear on a cursor slot relaunches it as cursor', async () => {
  clearStore();
  const fleet = fleetWith([1], [1]);
  const { stdin, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'clear');
  await tick(100);
  const call = fleet.calls.find(c => c[0] === 'launch');
  assert.ok(call, JSON.stringify(fleet.calls));
  assert.equal(call[1].provider, 'cursor');
  unmount();
});

test(':cost on a null-valued cursor slot shows the placeholder, not $0.00', async () => {
  clearStore();
  const fleet = fleetWith([1], [1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'cost');
  assert.ok(toasts(lastFrame()).some(t => /^cost · session \$-\.-- /.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

test(':model lists only Claude ids even with cursor models registered', async () => {
  clearStore();
  const fleet = fleetWith([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'model');
  const t = toasts(lastFrame()).find(x => /^available/.test(x)) || '';
  assert.ok(t, JSON.stringify(toasts(lastFrame())));
  assert.doesNotMatch(t, /cursor:/);
  unmount();
});

test.after(() => {
  for (const k of Object.keys(MODELS)) if (k.startsWith('cursor:')) delete MODELS[k];
});
