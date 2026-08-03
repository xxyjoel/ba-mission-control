// tests/killTarget.test.mjs — the `:kill` / `:kill!` target resolver.
// Pins release blockers B1 (out-of-range must not retarget focused) and M3
// (the `:kill!` verb form is a force-kill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKillTarget } from '../tui/lib/killTarget.js';

const ctx = { focusedSlot: 3, slots: 10 };

test(':kill (no arg) → focused session, armed (not forced)', () => {
  assert.deepEqual(resolveKillTarget('kill', '', ctx), { force: false, slot: 3, error: null });
});

test(':kill <n> valid → that slot, armed', () => {
  assert.deepEqual(resolveKillTarget('kill', '2', ctx), { force: false, slot: 2, error: null });
});

test('B1: :kill 99 (out of range) is REJECTED, not retargeted to focused', () => {
  const r = resolveKillTarget('kill', '99', ctx);
  assert.equal(r.slot, null, 'must not resolve to any slot');
  assert.ok(r.error, 'must return an error, never silently target the focused session');
});

test('B1: :kill !99 (force + out of range) is REJECTED — no silent focused kill', () => {
  const r = resolveKillTarget('kill', '!99', ctx);
  assert.equal(r.slot, null);
  assert.equal(r.force, true);
  assert.ok(r.error);
});

test(':kill !2 (bang on arg) → slot 2, forced', () => {
  assert.deepEqual(resolveKillTarget('kill', '!2', ctx), { force: true, slot: 2, error: null });
});

test('M3: :kill! 2 (bang on verb) → slot 2, forced', () => {
  assert.deepEqual(resolveKillTarget('kill!', '2', ctx), { force: true, slot: 2, error: null });
});

test('M3: :kill! (verb, no arg) → focused, forced', () => {
  assert.deepEqual(resolveKillTarget('kill!', '', ctx), { force: true, slot: 3, error: null });
});

test('non-numeric arg is rejected (no partial parse)', () => {
  for (const bad of ['abc', '2x', '!nope', '0', '11']) {
    const r = resolveKillTarget('kill', bad, ctx);
    assert.equal(r.slot, null, `"${bad}" must not resolve`);
    assert.ok(r.error, `"${bad}" must error`);
  }
});
