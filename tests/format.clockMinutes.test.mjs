// tests/format.clockMinutes.test.mjs — 0464: the header clock and session
// timer can drop seconds (App uses this while the fleet is idle). The default
// output is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtClock, fmtDuration } from '../tui/lib/format.js';

const T = Date.UTC(2026, 9, 8, 14, 5, 42);

test('0464 fmtClock: seconds by default, HH:MM with seconds:false', () => {
  assert.equal(fmtClock(T), '14:05:42');
  assert.equal(fmtClock(T, true, { seconds: false }), '14:05');
  assert.equal(fmtClock(T, false), '02:05:42 PM');
  assert.equal(fmtClock(T, false, { seconds: false }), '02:05 PM');
});

test('0464 fmtDuration: HH:MM:SS by default, HH:MM with seconds:false', () => {
  assert.equal(fmtDuration(3661 * 1000), '01:01:01');
  assert.equal(fmtDuration(3661 * 1000, { seconds: false }), '01:01');
});

// Review of 0464, finding 1: at boot an idle `now` is floored to the minute
// and can be earlier than Fleet.sessionStart, so the header showed "-1:-1".
test('0464 fmtDuration: a negative span reads as zero, not "-1:-1"', () => {
  assert.equal(fmtDuration(-30_000, { seconds: false }), '00:00');
  assert.equal(fmtDuration(-1, { seconds: false }), '00:00');
  assert.equal(fmtDuration(-30_000), '00:00:00');
});
