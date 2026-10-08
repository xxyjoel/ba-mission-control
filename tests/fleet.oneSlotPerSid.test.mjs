// tests/fleet.oneSlotPerSid.test.mjs — 0454. The same session id could be
// resumed into two slots: two claude pids on one transcript, two cards claiming
// one conversation (the identity shape behind 0365). launch()/resume() now
// refuse a sessionId that is live in another slot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// No real claude: MC_MOCK makes every launch a MockAgent. Read at module load.
process.env.MC_MOCK = 'approval-request';
const { Fleet } = await import('../server/fleet.mjs');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function liveAgent(id, sessionId) {
  return { id, status: 'idle', killed: 0, kill() { this.killed++; }, send() {}, sessionId };
}

test('resume() refuses a sessionId live in another slot; the target slot stays empty', () => {
  const f = new Fleet({ slots: 3 });
  f.agents[0] = liveAgent('a', SID);
  assert.throws(
    () => f.resume({ slot: 2, sessionId: SID, cwd: '/tmp', model: 'sonnet-4.6', name: 'dup' }),
    /aaaaaaaa.*already live in slot 1/,
  );
  assert.equal(f.agents[1], null, 'no second agent launched on the same sid');
  f.killAll();
});

test('launch() with an explicit sessionId live elsewhere is refused too', () => {
  const f = new Fleet({ slots: 3 });
  f.agents[2] = liveAgent('c', SID);
  assert.throws(
    () => f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'dup', sessionId: SID }),
    /already live in slot 3/,
  );
  assert.equal(f.agents[0], null);
  f.killAll();
});

test('resume() of a sid NOT live elsewhere still launches', () => {
  const f = new Fleet({ slots: 3 });
  f.agents[0] = liveAgent('a', 'ffffffff-0000-0000-0000-000000000000');
  const agent = f.resume({ slot: 2, sessionId: SID, cwd: '/tmp', model: 'sonnet-4.6', name: 'ok' });
  assert.ok(agent, 'agent returned');
  assert.equal(f.agents[1], agent);
  f.killAll();
});
