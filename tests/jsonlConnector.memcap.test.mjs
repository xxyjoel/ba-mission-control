// tests/jsonlConnector.memcap.test.mjs — memory-hygiene caps (task 0340, #18).
// parseEvent mutates a plain-object agent, so we drive it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../server/jsonlConnector.mjs';

const USAGE_BY_MSG_MAX = 512;      // must match jsonlConnector.mjs
const PENDING_SUBAGENT_MAX = 256;

function assistantWithUsage(id) {
  return { type: 'assistant', message: { id, model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } };
}
function subagentStart(toolId) {
  return { type: 'assistant', message: { id: 'm-' + toolId, model: 'x', content: [{ type: 'tool_use', id: toolId, name: 'Task', input: { subagent_type: 'general-purpose' } }], usage: { input_tokens: 1, output_tokens: 1 } } };
}

test('_usageByMsg stops growing past the cap and keeps the newest ids', () => {
  const agent = {};
  for (let i = 0; i < USAGE_BY_MSG_MAX + 500; i++) parseEvent(assistantWithUsage('msg-' + i), agent);
  assert.equal(agent._usageByMsg.size, USAGE_BY_MSG_MAX, 'capped at the max');
  // Newest id retained, an early (evicted) id dropped.
  assert.ok(agent._usageByMsg.has('msg-' + (USAGE_BY_MSG_MAX + 499)), 'newest kept');
  assert.ok(!agent._usageByMsg.has('msg-0'), 'oldest evicted');
});

test('re-setting the same message.id does not inflate size (dedup intact)', () => {
  const agent = {};
  for (let k = 0; k < 5; k++) parseEvent(assistantWithUsage('same-id'), agent);
  assert.equal(agent._usageByMsg.size, 1);
});

test('pendingSubagents drops a stale entry on the next start; fresh survives', () => {
  const agent = {};
  parseEvent(subagentStart('toolu-old'), agent);
  // Age the existing entry past the 30-min staleness window.
  agent.pendingSubagents.get('toolu-old').startTs = Date.now() - 31 * 60 * 1000;
  parseEvent(subagentStart('toolu-new'), agent);
  assert.ok(!agent.pendingSubagents.has('toolu-old'), 'stale swept');
  assert.ok(agent.pendingSubagents.has('toolu-new'), 'fresh kept');
});

test('pendingSubagents enforces a hard ceiling under a flood of unpaired starts', () => {
  const agent = {};
  for (let i = 0; i < PENDING_SUBAGENT_MAX + 100; i++) parseEvent(subagentStart('toolu-' + i), agent);
  assert.equal(agent.pendingSubagents.size, PENDING_SUBAGENT_MAX, 'capped at the ceiling');
  assert.ok(agent.pendingSubagents.has('toolu-' + (PENDING_SUBAGENT_MAX + 99)), 'newest kept');
});
