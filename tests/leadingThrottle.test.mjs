// tests/leadingThrottle.test.mjs — pure leading-edge + trailing throttle (0341).
import test from 'node:test';
import assert from 'node:assert/strict';
import { throttleDecision } from '../tui/lib/leadingThrottle.js';

const INT = 33;

test('leading edge: first change after an idle gap paints immediately', () => {
  const d = throttleDecision(1000, 1000 - 100, INT); // 100ms since last paint
  assert.deepEqual(d, { paintNow: true, scheduleIn: null });
});

test('leading edge: no prior paint (lastRenderTs=0) paints immediately', () => {
  assert.equal(throttleDecision(5000, 0, INT).paintNow, true);
});

test('trailing: a change mid-interval schedules the remaining time, does not paint now', () => {
  const d = throttleDecision(1010, 1000, INT); // 10ms since last paint
  assert.equal(d.paintNow, false);
  assert.equal(d.scheduleIn, INT - 10); // 23ms remaining
});

test('boundary: exactly `interval` since last paint counts as leading (paint now)', () => {
  assert.deepEqual(throttleDecision(1000 + INT, 1000, INT), { paintNow: true, scheduleIn: null });
});

test('just under the boundary still coalesces', () => {
  const d = throttleDecision(1000 + INT - 1, 1000, INT);
  assert.equal(d.paintNow, false);
  assert.equal(d.scheduleIn, 1);
});
