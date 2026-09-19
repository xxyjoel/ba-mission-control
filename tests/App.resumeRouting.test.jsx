// tests/App.resumeRouting.test.jsx — 0408/I3. runCommand carried TWO
// `case 'resume':` labels; the first (SIGCONT the focused session) always
// won, so the selective-restore block — advertised by the README and the
// Settings NOTES tab — was unreachable: `:resume 3` SIGCONTed the focused
// slot instead of restoring slot 3, and on an empty fleet it said "no live
// session focused". Evidence before the fix: scratchpad probeB.resume.test.jsx.
//
// Now: `:resume <slot ...>` ALWAYS routes to the restore block; bare
// `:resume` stays the SIGCONT pair to `:pause` (falling back to restoring
// the focused slot when nothing live is focused).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0408-resume');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const mount = (fleet) => render(React.createElement(App, { fleet, auth: AUTH }));
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

function seedRecord(slot) {
  writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({
    version: 2, savedAt: Date.now(), openSlots: [], history: [],
    bySlot: {
      [slot]: {
        slot, name: 'saved-repo', cwd: '/tmp', branch: 'main',
        model: 'claude-sonnet-4-6', permissionMode: 'default',
        sessionId: '11111111-2222-3333-4444-555555555555',
        lastSeen: Date.now(), live: false,
      },
    },
  }, null, 2));
}

function clearStore() {
  try { rmSync(join(CFG, 'sessions.json'), { force: true }); } catch {}
  try { rmSync(join(CFG, 'sessions.json.bak'), { force: true }); } catch {}
}

test('I3: ":resume 3" with a live focused slot 1 routes to the RESTORE branch, not SIGCONT', async () => {
  clearStore();
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  assert.ok(!fleet.calls.some(c => c[0] === 'resume(SIGCONT)'), 'must NOT SIGCONT the focused slot');
  assert.ok(toasts(lastFrame()).some(t => /no saved session for slot 3/.test(t)),
    `restore branch replies about slot 3; got ${JSON.stringify(toasts(lastFrame()))}`);
  unmount();
});

test('I3: ":resume 3" with a saved record actually restores slot 3', async () => {
  seedRecord(3);
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const call = fleet.calls.find(c => c[0] === 'resumeFromRecord');
  assert.ok(call, `fleet.resume was called; calls: ${JSON.stringify(fleet.calls)}`);
  assert.equal(call[1].slot, 3);
  assert.equal(call[1].sessionId, '11111111-2222-3333-4444-555555555555');
  assert.ok(toasts(lastFrame()).some(t => /resumed slot 3/.test(t)));
  clearStore();
  unmount();
});

test('I3: bare ":resume" still SIGCONTs the focused live session (the :pause pair)', async () => {
  clearStore();
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume');
  assert.ok(fleet.calls.some(c => c[0] === 'resume(SIGCONT)' && c[1] === 1), 'bare verb SIGCONTs');
  assert.ok(!fleet.calls.some(c => c[0] === 'resumeFromRecord' || c[0] === 'launch'));
  assert.ok(toasts(lastFrame()).some(t => /^resume slot 1$/.test(t)));
  unmount();
});

test('I3: ":resume 3" on an EMPTY fleet reaches the restore branch (no "no live session focused")', async () => {
  clearStore();
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3');
  const ts = toasts(lastFrame());
  assert.ok(!ts.some(t => /no live session focused/.test(t)), `got ${JSON.stringify(ts)}`);
  assert.ok(ts.some(t => /no saved session for slot 3/.test(t)));
  unmount();
});

test('I3: multi-restore ":resume 3 5" reports per-slot results', async () => {
  seedRecord(3);
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  await type(stdin, 'resume 3 5');
  const restored = fleet.calls.filter(c => c[0] === 'resumeFromRecord');
  assert.equal(restored.length, 1, 'only slot 3 has a record');
  assert.equal(restored[0][1].slot, 3);
  assert.ok(toasts(lastFrame()).some(t => /resumed 1\/2/.test(t) && /1 unknown/.test(t)),
    `summary toast; got ${JSON.stringify(toasts(lastFrame()))}`);
  clearStore();
  unmount();
});
