// tests/fleet.broadcast.test.mjs — broadcast() must be able to STAGGER its
// per-session sends so mc doesn't open many streaming API connections in the
// same instant (a self-induced ECONNRESET/overload risk with several slots).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../server/fleet.mjs';

function fakeAgent(slot, id, sends, status = 'idle') {
  return { slot, id, status, send: (t) => { sends.push({ slot, t }); return true; } };
}

test('broadcast: staggerMs=0 → all sends fire synchronously (legacy)', () => {
  const f = new Fleet({ slots: 3 });
  const sends = [];
  f.agents[0] = fakeAgent(1, 'a', sends);
  f.agents[1] = fakeAgent(2, 'b', sends);
  const r = f.broadcast(['a', 'b'], 'hi', 0);
  assert.equal(r.sent, 2, 'returns sent count');
  assert.equal(r.skipped, 0, 'nothing skipped');
  assert.equal(sends.length, 2, 'both fire immediately when stagger=0');
});

test('broadcast: staggerMs>0 → first immediate, rest spaced across time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = new Fleet({ slots: 3 });
  const sends = [];
  f.agents[0] = fakeAgent(1, 'a', sends);
  f.agents[1] = fakeAgent(2, 'b', sends);
  f.agents[2] = fakeAgent(3, 'c', sends);
  const r = f.broadcast(['a', 'b', 'c'], 'hi', 200);
  assert.equal(r.sent, 3, 'returns sent count immediately');
  assert.equal(sends.length, 1, 'only the first fires synchronously');
  t.mock.timers.tick(200);
  assert.equal(sends.length, 2, 'second at 200ms');
  t.mock.timers.tick(200);
  assert.equal(sends.length, 3, 'third at 400ms');
});

test('broadcast: unknown ids are skipped and tallied (0070)', () => {
  const f = new Fleet({ slots: 3 });
  const sends = [];
  f.agents[0] = fakeAgent(1, 'a', sends);
  const r = f.broadcast(['a', 'does-not-exist'], 'hi', 0);
  assert.equal(r.sent, 1);
  assert.equal(r.skipped, 1, 'the unknown id is counted as skipped');
  assert.equal(sends.length, 1);
});

test('broadcast: paused agents are skipped, not sent to (0069/0070)', () => {
  const f = new Fleet({ slots: 3 });
  const sends = [];
  f.agents[0] = fakeAgent(1, 'a', sends, 'working');
  f.agents[1] = fakeAgent(2, 'b', sends, 'paused');   // SIGSTOPped — can't receive
  f.agents[2] = fakeAgent(3, 'c', sends, 'idle');
  const r = f.broadcast(['a', 'b', 'c'], 'hi', 0);
  assert.equal(r.sent, 2, 'two live slots received');
  assert.equal(r.skipped, 1, 'the paused slot was skipped');
  assert.equal(sends.length, 2, 'no send to the paused agent');
  assert.ok(!sends.some((s) => s.slot === 2), 'paused slot 2 got nothing');
});
