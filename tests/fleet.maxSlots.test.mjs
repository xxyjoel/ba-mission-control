// tests/fleet.maxSlots.test.mjs — verify the configurable-slots
// constructor (#11). Default stays at 10; explicit value resizes the
// array; out-of-band values clamp to the [1, 64] safety band.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../server/fleet.mjs';

test('Fleet: defaults to 10 slots', () => {
  const f = new Fleet();
  assert.equal(f.slots, 10);
  assert.equal(f.agents.length, 10);
  assert.equal(f.snapshot().slots, 10);
});

test('Fleet: honours { slots } in constructor', () => {
  const f = new Fleet({ slots: 20 });
  assert.equal(f.slots, 20);
  assert.equal(f.agents.length, 20);
  assert.equal(f.snapshot().slots, 20);
});

test('Fleet: clamps slots into the [1, 64] safety band', () => {
  assert.equal(new Fleet({ slots: 0 }).slots, 10, '0 → default');
  assert.equal(new Fleet({ slots: -5 }).slots, 1, 'negative → 1');
  assert.equal(new Fleet({ slots: 200 }).slots, 64, 'too-large → 64');
  assert.equal(new Fleet({ slots: 'banana' }).slots, 10, 'garbage → default');
});

test('Fleet: launch refuses slots above configured cap', () => {
  const f = new Fleet({ slots: 12 });
  assert.throws(() => f.launch({ slot: 13, cwd: '/tmp', branch: 'main', model: 'sonnet-4.6', name: 'oob' }), /bad slot 13/);
  assert.throws(() => f.launch({ slot: 0,  cwd: '/tmp', branch: 'main', model: 'sonnet-4.6', name: 'oob' }), /bad slot 0/);
});

test('Fleet: empty-slot placeholders span the full slot range', () => {
  const f = new Fleet({ slots: 15 });
  const snap = f.snapshot();
  assert.equal(snap.agents.length, 15);
  assert.deepEqual(snap.agents.map(a => a.slot), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  for (const a of snap.agents) assert.equal(a.status, 'empty');
});

// ── setSlots(): live resize without a restart (the "maxSlots doesn't take
//    when updated" fix). Grow freely; shrink only above the highest occupied
//    slot; clamp to the [1,64] band; emit 'change'. ──────────────────────────

const fakeAgent = (slot, id) => ({ slot, id, status: 'idle', toJSON: () => ({ slot, id, status: 'idle' }) });

test('setSlots: grows the live fleet and appends empty slots', () => {
  const f = new Fleet({ slots: 10 });
  const got = f.setSlots(15);
  assert.equal(got, 15, 'returns the new count');
  assert.equal(f.slots, 15);
  assert.equal(f.agents.length, 15);
  assert.equal(f.snapshot().slots, 15);
  assert.equal(f.snapshot().agents.at(-1).status, 'empty', 'new slots are empty');
});

test('setSlots: shrinks when the removed slots are empty', () => {
  const f = new Fleet({ slots: 12 });
  assert.equal(f.setSlots(6), 6);
  assert.equal(f.agents.length, 6);
  assert.equal(f.snapshot().slots, 6);
});

test('setSlots: refuses to shrink below the highest occupied slot', () => {
  const f = new Fleet({ slots: 12 });
  f.agents[7] = fakeAgent(8, 'live-8'); // slot 8 occupied
  const got = f.setSlots(4);
  assert.equal(got, 8, 'clamped to the highest occupied slot');
  assert.equal(f.slots, 8);
  assert.ok(f.agentBySlot(8), 'the live agent in slot 8 survived');
});

test('setSlots: clamps to the [1,64] band and emits change', () => {
  const f = new Fleet({ slots: 10 });
  let fired = 0;
  f.on('change', () => { fired++; });
  assert.equal(f.setSlots(999), 64, 'too-large → 64');
  assert.equal(f.setSlots(0), 10, 'falsy → default');
  assert.equal(f.setSlots(-3), 1, 'negative → 1');
  assert.ok(fired >= 3, 'each resize emits a change');
});

test('setSlots: no-op when target equals current (no spurious change)', () => {
  const f = new Fleet({ slots: 10 });
  let fired = 0;
  f.on('change', () => { fired++; });
  assert.equal(f.setSlots(10), 10);
  assert.equal(fired, 0, 'unchanged count does not emit');
});
