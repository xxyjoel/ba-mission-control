// tests/jsonlConnector.bgAgents.test.mjs — 0486: background agents are opened
// by their launch receipt and closed by their finish notice, and stay counted
// while they are quiet.
//
// mc used to count a background agent only while its file grew in the last
// 60 s. Measured over 3,233 sub-agent files (2026-10-17 to 2026-11-17), 51%
// went quiet longer than that while still running.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEvent } from '../server/jsonlConnector.mjs';
import { deriveStatus, BG_ABANDON_MS } from '../server/deriveStatus.mjs';
import { agentIdFromLaunch, liveOpenAgents } from '../server/bgShellJobs.mjs';

const makeAgent = () => ({
  status: 'idle', activity: '', tail: [], todos: [], tokensIn: 0, tokensOut: 0,
  tokensCacheRead: 0, context: 0, costSession: 0, lastEventTs: 0, lastConnectorTs: 0,
});
const ts = () => new Date().toISOString();
const agentUse = (useId, input) => ({
  type: 'assistant', timestamp: ts(),
  message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: useId, name: 'Agent', input }] },
});
const toolResult = (useId, text) => ({
  type: 'user', timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: [{ type: 'text', text }] }] },
});
// The receipt's shape in claude 2.1.322 (prompt text elided).
const launch = (agentId) => 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n'
  + `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)`;
const notice = (taskId, status = 'completed') => ({
  type: 'user', timestamp: ts(),
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent "Survey the repos" ${status}</summary>\n</task-notification>` },
});

function launchAgent(a, useId, agentId, description = 'Survey the repos') {
  parseEvent(agentUse(useId, { description, prompt: '…', subagent_type: 'general-purpose', run_in_background: true }), a);
  parseEvent(toolResult(useId, launch(agentId)), a);
}

test('the launch receipt opens the agent with its description', () => {
  const a = makeAgent();
  launchAgent(a, 'toolu_g1', 'a1d1d422c288355d7');
  assert.equal(agentIdFromLaunch(launch('a1d1d422c288355d7')), 'a1d1d422c288355d7');
  assert.equal(a.bgAgents.get('a1d1d422c288355d7').label, 'Survey the repos');
  assert.equal(a.pendingSubagents.size, 0, 'the foreground pairing closes on the receipt, as before');
});

test('its finish notice closes it and notes it in the fleet log; a repeat is harmless', () => {
  const a = makeAgent();
  launchAgent(a, 'toolu_g1', 'a1d1d422c288355d7');
  launchAgent(a, 'toolu_g2', 'acac346b5b2af05cb', 'Diagnose slow page loads');
  parseEvent(notice('acac346b5b2af05cb'), a);
  assert.deepEqual([...a.bgAgents.keys()], ['a1d1d422c288355d7']);
  assert.ok(a.tail.some((e) => e.text === 'background agent completed: Diagnose slow page loads'));
  const agentLines = () => a.tail.filter((e) => /^background agent /.test(e.text || '')).length;
  const n = agentLines();
  parseEvent(notice('acac346b5b2af05cb'), a);
  assert.equal(agentLines(), n, 'a resumed agent may notify again; no second fleet-log line');
  parseEvent(notice('a1d1d422c288355d7', 'killed'), a);
  assert.equal(a.bgAgents.size, 0);
});

test('a quoted receipt, or one for a call that was not an agent, opens nothing', () => {
  const a = makeAgent();
  parseEvent(agentUse('toolu_g1', { description: 'x' }), a);
  parseEvent(toolResult('toolu_g1', `Found in the log:\n${launch('a0000000000000001')}`), a);
  parseEvent(toolResult('toolu_never_seen', launch('a0000000000000002')), a);
  assert.equal(a.bgAgents?.size ?? 0, 0);
});

test('TaskStop on an agent id closes it', () => {
  const a = makeAgent();
  launchAgent(a, 'toolu_g1', 'a1d1d422c288355d7');
  parseEvent({ type: 'assistant', timestamp: ts(), message: { model: 'claude-opus-5-5', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_s', name: 'TaskStop', input: { task_id: 'a1d1d422c288355d7' } }] } }, a);
  assert.equal(a.bgAgents.size, 0);
});

const NOW = 1_900_000_000_000;
const MIN = 60_000;

test('an open agent stays counted while it is quiet, up to the quiet cap', () => {
  const open = (startAgo) => new Map([['a1', { label: 'Survey the repos', type: 'general-purpose', startTs: NOW - startAgo }]]);
  const run = (bgAgents, grewAgo) => deriveStatus({
    hookStatus: 'idle', hookStatusTs: NOW - 1000, bgAgents,
    agentLastGrowth: () => (grewAgo == null ? 0 : NOW - grewAgo),
    liveSubAgents: () => [],   // quiet: no file grew in the last 60 s
  }, NOW);
  const r = run(open(10 * MIN), 4 * MIN);
  assert.equal(r.status, 'idle');
  assert.equal(r.bgCount, 1, 'quiet for 4 minutes: still running');
  assert.equal(r.bgStatus, 'working');
  assert.deepEqual(r.activeSubagents, [{ label: 'Survey the repos', type: 'general-purpose', elapsedMs: 10 * MIN }]);
  assert.equal(run(open(3 * 60 * MIN), 20 * MIN).bgCount, 1, 'a 3-hour agent that wrote 20 minutes ago counts');
  assert.equal(run(open(3 * 60 * MIN), BG_ABANDON_MS + 1).bgCount, 0, 'no growth past the cap: a stop with no notice');
  assert.equal(run(open(5 * MIN), null).bgCount, 1, 'no file seen yet: its start time counts');
});

test('open agents and live files: the larger count wins, never the sum', () => {
  const bgAgents = new Map([['a1', { label: 'one', type: 'agent', startTs: NOW - MIN }]]);
  const r = deriveStatus({
    hookStatus: 'idle', hookStatusTs: NOW - 1000, bgAgents, agentLastGrowth: () => NOW - 1000,
    liveSubAgents: () => [{ id: 'a1', lastGrowTs: NOW - 1000 }, { id: 'b2', lastGrowTs: NOW - 2000 }],
  }, NOW);
  assert.equal(r.bgCount, 2, 'a1 is both open and live; b2 started before mc did');
  assert.deepEqual(r.activeSubagents.map((s) => s.label), ['one', 'agent b2']);
});

test('liveOpenAgents survives a throwing growth lookup', () => {
  const m = new Map([['a1', { label: 'x', type: 'agent', startTs: NOW - MIN }]]);
  assert.equal(liveOpenAgents(m, () => { throw new Error('gone'); }, NOW, BG_ABANDON_MS).length, 1);
});

test('a finish notice behind the system-notification header closes the agent', () => {
  const a = makeAgent();
  launchAgent(a, 'toolu_g1', 'a5c6a8b7444eb9e6a', 'Start a background sleep job');
  const wrapped = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n'
    + '<task-notification>\n<task-id>a5c6a8b7444eb9e6a</task-id>\n<status>completed</status>\n</task-notification>';
  parseEvent({ type: 'user', timestamp: ts(), message: { role: 'user', content: wrapped } }, a);
  assert.equal(a.bgAgents.size, 0, 'without this the agent stayed counted for up to 30 minutes after it finished');
});
