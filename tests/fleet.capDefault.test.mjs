// tests/fleet.capDefault.test.mjs — 0448: `:cap default <usd>` (Fleet.setCostCap)
// must not wipe a per-slot override set with `:cap <slot> <usd>`
// (Fleet.setSlotCostCap). Before the fix setCostCap overwrote every live
// agent's cap, so a slot raised to $50 dropped back to the default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../server/fleet.mjs';

const fakeAgent = (slot) => ({ slot, id: `s${slot}`, status: 'idle', costCapUSD: 0,
  toJSON() { return { slot, id: `s${slot}`, status: 'idle' }; } });

test('0448 setCostCap keeps a per-slot override, updates the other slots', () => {
  const f = new Fleet({ slots: 10 });
  f.agents[0] = fakeAgent(1);
  f.agents[1] = fakeAgent(2);
  f.setCostCap(5);
  assert.ok(f.setSlotCostCap(2, 50));
  f.setCostCap(8);
  assert.equal(f.agents[0].costCapUSD, 8, 'slot without override follows the default');
  assert.equal(f.agents[1].costCapUSD, 50, 'per-slot override survives :cap default');
  assert.equal(f.defaultCostCapUSD, 8);
});

test('0448 a new agent in a slot does not inherit the old override', () => {
  const f = new Fleet({ slots: 10 });
  f.agents[1] = fakeAgent(2);
  f.setSlotCostCap(2, 50);
  f.agents[1] = fakeAgent(2); // relaunch: a fresh agent object
  f.setCostCap(3);
  assert.equal(f.agents[1].costCapUSD, 3);
});
