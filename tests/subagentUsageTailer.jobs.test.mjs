// tests/subagentUsageTailer.jobs.test.mjs — 0488: a background job a
// sub-agent starts is named on the parent slot.
//
// Slot 3, 2026-11-17: a sub-agent started two wait loops and finished without
// stopping them. The process check counts them (0484) but cannot name them;
// the sub-agent's own file can.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';
import { claudeProjectDir } from '../server/sessionFileTailer.mjs';

const line = (o) => JSON.stringify(o) + '\n';
const bashUse = (id, ts, input) => line({ isSidechain: true, type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
const result = (id, ts, text) => line({ isSidechain: true, type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

test('a sub-agent\'s background Bash job is tracked on the parent slot with its name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-subjobs-'));
  const cwd = join(root, 'repo');
  const sessionId = '0d4e5f60-7182-4a9b-8bcd-000000000488';
  const dir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const agent = Object.assign(new EventEmitter(), {
    cwd, sessionId, bgJobs: new Map(), tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0, spark: [],
  });
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    await tailer.scan(); // prime: empty dir
    const f = join(dir, 'agent-acac346b5b2af05cb.jsonl');
    writeFileSync(f, bashUse('toolu_s1', '2026-11-15T00:45:47.037Z',
      { command: 'until grep -q stream run.log; do sleep 10; done', description: 'Wait until the probe run reports back', run_in_background: true }));
    appendFileSync(f, result('toolu_s1', '2026-11-15T00:45:47.174Z',
      'Command running in background with ID: bepkse8ao. Output is being written to: /tmp/x/bepkse8ao.output'));
    // A foreground call whose output quotes a receipt starts nothing.
    appendFileSync(f, bashUse('toolu_s2', '2026-11-15T00:46:10.194Z', { command: 'cat notes.txt' }));
    appendFileSync(f, result('toolu_s2', '2026-11-15T00:46:10.300Z', 'notes:\nCommand running in background with ID: bnope0001.'));
    await tailer.scan();
    assert.deepEqual([...agent.bgJobs.keys()], ['bepkse8ao']);
    const j = agent.bgJobs.get('bepkse8ao');
    assert.equal(j.label, 'Wait until the probe run reports back');
    assert.equal(j.startTs, Date.parse('2026-11-15T00:45:47.037Z'), 'timed from the call, for the process match');
    // 0486: the quiet cap reads when each agent's file last grew, by agent id.
    assert.ok(tailer.lastGrowthOf('acac346b5b2af05cb') > 0);
    assert.equal(tailer.lastGrowthOf('a-never-seen'), 0);
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an agent with no job map (legacy or Cursor slot) is left alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-subjobs-'));
  const cwd = join(root, 'repo');
  const sessionId = '0d4e5f60-7182-4a9b-8bcd-000000000489';
  const dir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const agent = Object.assign(new EventEmitter(), { cwd, sessionId, tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0, spark: [] });
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    await tailer.scan();
    const f = join(dir, 'agent-a0000000000000001.jsonl');
    writeFileSync(f, bashUse('toolu_s1', '2026-11-15T00:45:47.037Z', { command: 'sleep 600', run_in_background: true }));
    appendFileSync(f, result('toolu_s1', '2026-11-15T00:45:47.174Z', 'Command running in background with ID: bjob00001.'));
    await tailer.scan();
    assert.equal(agent.bgJobs, undefined);
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
