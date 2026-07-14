// tests/MockAgent.replay.test.mjs — verifies each shipped fixture
// replays to the expected final snapshot shape. Replaces the inline
// smoke test that was hand-run in 6e702a7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent } from '../server/mockAgent.mjs';

// Helper: spin up a MockAgent on the named fixture, let the replay run
// to completion (or to a wait-user pause), and return the agent.
async function replay(fixture, settleMs = 2500) {
  const agent = new MockAgent({
    slot: 1, name: 'test', cwd: '/tmp', branch: 'main', model: 'sonnet-4.6',
    fixture,
  });
  let changes = 0;
  agent.on('change', () => changes++);
  agent.start();
  await new Promise((r) => setTimeout(r, settleMs));
  return { agent, changes, snapshot: agent.toJSON() };
}

test('quick-reply: ends idle with one assistant turn and a result cost', async () => {
  const { snapshot, changes } = await replay('quick-reply');
  assert.equal(snapshot.status, 'idle');
  assert.ok(snapshot.costSession > 0, 'cost should accumulate from the result directive');
  assert.ok(snapshot.tail.some(l => l.kind === 'asst'), 'must include an asst tail entry');
  assert.ok(changes > 0, 'must emit at least one change event');
});

test('tool-loop: includes a tool entry and a tool_result sys entry', async () => {
  const { snapshot } = await replay('tool-loop');
  assert.equal(snapshot.status, 'idle');
  assert.ok(snapshot.tail.some(l => l.kind === 'tool'), 'tool tail entry expected');
  assert.ok(snapshot.tail.some(l => l.kind === 'sys' && /tool_result/.test(l.text || '')),
    'tool_result sys entry expected');
});

test('long-thinking: includes a think entry distinct from asst', async () => {
  const { snapshot } = await replay('long-thinking');
  assert.equal(snapshot.status, 'idle');
  const thinks = snapshot.tail.filter(l => l.kind === 'think');
  assert.ok(thinks.length >= 1, 'at least one think tail entry expected');
  assert.ok(thinks[0].text && thinks[0].text.length > 0);
});

test('approval-request: pauses at waiting with kind=approval, resumes on send()', async () => {
  const agent = new MockAgent({
    slot: 1, name: 'test', cwd: '/tmp', branch: 'main', model: 'sonnet-4.6',
    fixture: 'approval-request',
  });
  agent.start();
  await new Promise((r) => setTimeout(r, 1500));
  // Should be paused at the wait-user directive after the approval entry.
  assert.equal(agent.status, 'waiting');
  const approval = [...agent.tail].reverse().find(l => l.awaitingPrompt?.kind === 'approval');
  assert.ok(approval, 'an approval-kind awaiting entry must be present');
  assert.equal(approval.awaitingPrompt.tool, 'Bash');

  // Replying drains the wait-user gate and replay continues to idle.
  agent.send('approve');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(agent.status, 'idle');
});

test('workingStartTs: status transitions anchor and clear correctly', async () => {
  const agent = new MockAgent({
    slot: 1, name: 'test', cwd: '/tmp', branch: 'main', model: 'sonnet-4.6',
    fixture: 'quick-reply',
  });
  assert.equal(agent.workingStartTs, null);
  agent.start();
  // Sleep a brief moment so the first status=working directive fires.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(agent.workingStartTs && typeof agent.workingStartTs === 'number',
    'workingStartTs should be set during the working phase');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(agent.workingStartTs, null, 'workingStartTs should clear on idle');
});
