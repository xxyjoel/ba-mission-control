// tests/statusHookTailer.agentNeedsInput.test.mjs
//
// Task 0451 — Notification{agent_needs_input}. The task assumed claude sends it
// when the session's main thread is blocked on the user. Real hook logs
// (~/.local/state/claude-mc/status/*.ndjson, 24 events in 7 sessions) do not
// show that: it arrives after Stop + idle_prompt on idle sessions, paired at
// the same millisecond with agent_completed, in two sessions within 40 ms of
// each other, and right before a main-thread PreToolUse. Mapping it to
// 'waiting' turned idle cards WAITING with no expiry. So it stays unmapped
// until spike 0363 settles what it means. These pins use the real log shapes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { mapEventToStatus, startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

function appendEvent(filePath, record) {
  appendFileSync(filePath, JSON.stringify({ ts: Date.now(), ...record }) + '\n', 'utf8');
}

async function pollUntil(agent, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agent.hookStatus === expected) return agent.hookStatus;
    await new Promise(r => setTimeout(r, 50));
  }
  return agent.hookStatus;
}

// Settle window: long enough for the tailer to read lines appended after it
// reached 'idle', so a wrong flip to 'waiting' would be seen.
const settle = () => new Promise(r => setTimeout(r, 400));

async function withTailer(fn) {
  const sessionId = randomUUID();
  const agent = { sessionId, hookStatus: undefined };
  const filePath = statusFilePath({ sessionId });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
  const handle = startStatusHookTailer({ agent });
  try {
    await new Promise(r => setTimeout(r, 100));
    await fn({ sessionId, agent, filePath });
  } finally {
    handle.stop();
    try { rmSync(filePath); } catch { /* best-effort */ }
  }
}

describe('0451: Notification:agent_needs_input stays unmapped (pending 0363)', () => {
  test('mapEventToStatus returns null for agent_needs_input (also keeps the bg chip unchanged)', () => {
    const result = mapEventToStatus({
      ts: Date.now(),
      session_id: 'c0ffee00-0451-0451-0451-c0ffee000451',
      event: 'Notification',
      notification_type: 'agent_needs_input',
    });
    assert.equal(result, null);
  });

  test('idle session: Stop, idle_prompt, agent_needs_input stays idle', async () => {
    await withTailer(async ({ sessionId, agent, filePath }) => {
      appendEvent(filePath, { session_id: sessionId, event: 'PreToolUse', tool_name: 'Bash' });
      appendEvent(filePath, { session_id: sessionId, event: 'Stop' });
      appendEvent(filePath, { session_id: sessionId, event: 'Notification', notification_type: 'idle_prompt' });
      assert.equal(await pollUntil(agent, 'idle'), 'idle');

      appendEvent(filePath, { session_id: sessionId, event: 'Notification', notification_type: 'agent_needs_input' });
      await settle();
      assert.equal(agent.hookStatus, 'idle',
        `idle session flipped to ${JSON.stringify(agent.hookStatus)} on agent_needs_input`);
    });
  });

  test('idle session: same-ms agent_needs_input + agent_completed pair stays idle', async () => {
    await withTailer(async ({ sessionId, agent, filePath }) => {
      appendEvent(filePath, { session_id: sessionId, event: 'Stop' });
      appendEvent(filePath, { session_id: sessionId, event: 'Notification', notification_type: 'idle_prompt' });
      assert.equal(await pollUntil(agent, 'idle'), 'idle');

      const ts = Date.now();
      appendEvent(filePath, { ts, session_id: sessionId, event: 'Notification', notification_type: 'agent_needs_input' });
      appendEvent(filePath, { ts, session_id: sessionId, event: 'Notification', notification_type: 'agent_completed' });
      await settle();
      assert.equal(agent.hookStatus, 'idle',
        `idle session flipped to ${JSON.stringify(agent.hookStatus)} on the agent_needs_input/agent_completed pair`);
    });
  });
});
