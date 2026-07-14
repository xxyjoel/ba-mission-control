// tests/fleet.lifecycle.test.mjs — Fleet lifecycle invariants:
//   0071 launch on an occupied slot throws, slot unchanged
//   0072 killAll() kills every live agent
//   0073 resume() without a sessionId throws
//   0079 launch+kill cycles don't leak 'change' listeners on the fleet

import { test } from 'node:test';
import assert from 'node:assert/strict';

// launch() must not spawn a real `claude`. MC_MOCK makes every launch a
// MockAgent (fixture replay). MOCK_FIXTURE is read at module-load time, so set
// it BEFORE importing fleet.mjs — hence the dynamic import.
process.env.MC_MOCK = 'approval-request';
const { Fleet } = await import('../server/fleet.mjs');

function spyAgent(id, status = 'idle') {
  return { id, status, killed: 0, kill() { this.killed++; }, send() {}, sessionId: `sid-${id}` };
}

test('launch on an occupied slot throws and leaves the slot unchanged (0071)', () => {
  const f = new Fleet({ slots: 3 });
  const existing = spyAgent('a');
  f.agents[0] = existing;
  assert.throws(
    () => f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'x' }),
    /occupied/i,
  );
  assert.equal(f.agents[0], existing, 'existing agent untouched');
  assert.equal(existing.killed, 0, 'existing agent not killed by the failed launch');
});

test('killAll() kills every live agent (0072)', () => {
  const f = new Fleet({ slots: 5 });
  for (let i = 0; i < 5; i++) f.agents[i] = spyAgent(`a${i}`);
  f.killAll();
  assert.ok(f.agents.every((a) => a.killed === 1), 'every agent killed exactly once');
});

test('killAll() is safe with empty slots interleaved', () => {
  const f = new Fleet({ slots: 4 });
  f.agents[1] = spyAgent('b');
  f.agents[3] = spyAgent('d');
  assert.doesNotThrow(() => f.killAll());
  assert.equal(f.agents[1].killed, 1);
  assert.equal(f.agents[3].killed, 1);
});

test('resume() without a sessionId throws (0073)', () => {
  const f = new Fleet({ slots: 3 });
  assert.throws(() => f.resume({ slot: 1 }), /no sessionId/i);
});

test('launch+kill cycles do not leak fleet change listeners (0079)', () => {
  const f = new Fleet({ slots: 1 });
  f.on('change', () => {});                       // the single App-style subscriber
  for (let i = 0; i < 10; i++) {
    const a = f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 't' });
    f.kill(a.id);
    assert.ok(f.listenerCount('change') <= 1, `cycle ${i}: fleet has ≤1 'change' listener`);
  }
  assert.equal(f.listenerCount('change'), 1, 'exactly the one subscriber remains');
});
