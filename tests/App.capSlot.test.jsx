// tests/App.capSlot.test.jsx — 0448: `:cap <slot> <usd>` accepts any slot up
// to settings.maxSlots. Before the fix the range was hard-coded 1–10, so
// `:cap 11 5` at maxSlots 64 was rejected with the usage toast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0448-cap');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

function setMaxSlots(n) {
  writeFileSync(join(CFG, 'settings.json'), JSON.stringify({ maxSlots: n }));
}

test('0448 :cap 11 <usd> at maxSlots 64 reaches fleet.setSlotCostCap', async () => {
  setMaxSlots(64);
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { fleet, auth: AUTH }));
  await tick(); await tick();
  await type(stdin, 'cap 11 5');
  const caps = fleet.calls.filter(c => c[0] === 'slotCap');
  assert.deepEqual(caps, [['slotCap', 11, 5]], `toasts: ${JSON.stringify(toasts(lastFrame()))}`);
  unmount();
});

test('0448 :cap above maxSlots is still refused with the usage toast', async () => {
  setMaxSlots(12);
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { fleet, auth: AUTH }));
  await tick(); await tick();
  await type(stdin, 'cap 13 5');
  assert.deepEqual(fleet.calls.filter(c => c[0] === 'slotCap'), []);
  assert.ok(toasts(lastFrame()).some(t => /usage: :cap <slot 1-12>/.test(t)), JSON.stringify(toasts(lastFrame())));
  unmount();
});

// Review of 0448: when maxSlots is lowered below an occupied slot the fleet
// keeps its larger count (setSlots clamps). The capped agent tells the user to
// run `:cap <its slot> <usd>`, so that slot must stay in range.
test('0448 :cap reaches a live slot above a lowered maxSlots (fleet clamped)', async () => {
  setMaxSlots(10);
  const fleet = new FakeFleet([1]);
  fleet.slotFloor = 12; // a session lives in slot 12, so the fleet keeps 12 slots
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { fleet, auth: AUTH }));
  await tick(); await tick(); await tick();
  await type(stdin, 'cap 12 20');
  const caps = fleet.calls.filter(c => c[0] === 'slotCap');
  assert.deepEqual(caps, [['slotCap', 12, 20]], `toasts: ${JSON.stringify(toasts(lastFrame()))}`);
  unmount();
});
