// tests/subagentUsageTailer.resume.test.mjs — 0408-F6: a SETTLED sub-agent
// file is not dead. The parent can resume that agent (Agent tool: SendMessage
// continues a spawned agent) and its new turns append to the SAME
// agent-<id>.jsonl. Before this fix, settling dropped the byte offset and
// skipped the file forever — every resumed sub-agent's tokens and cost simply
// vanished (repro: tokensIn stayed 100 where 5100 was spent).
//
// Contract pinned here: a settled file costs one cheap stat per scan; on
// growth it un-settles and resumes from its KEPT offset — nothing re-read,
// nothing double-counted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';
import { claudeProjectDir } from '../server/sessionFileTailer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const usageLine = (input_tokens, output_tokens) =>
  JSON.stringify({ isSidechain: true, type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens, output_tokens } } }) + '\n';

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-subresume-'));
  const sessionId = `0d4e5f60-7182-4a9b-8bcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  const subDir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const agent = Object.assign(new EventEmitter(), {
    cwd, sessionId, tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0, spark: [],
  });
  return { agent, cwd, subDir };
}

test('a resumed sub-agent\'s appends are folded after its file settled (no double count)', async () => {
  const { agent, cwd, subDir } = setup();
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 50 });
  try {
    await tailer.scan(); // prime: dir exists, empty
    const f = join(subDir, 'agent-abc.jsonl');
    writeFileSync(f, usageLine(100, 10));
    await tailer.scan();
    assert.equal(agent.tokensIn, 100, 'first sub-agent turn folded');
    const costAfterFirst = agent.costSession;

    await sleep(120); await tailer.scan(); // idle past settleIdleMs → settles
    assert.equal(tailer.settledCount(), 1, 'file settled');
    await tailer.scan(); // settled scans are stat-only and change nothing
    assert.equal(agent.tokensIn, 100);

    // The parent resumes the agent; new turns land in the same file.
    appendFileSync(f, usageLine(5000, 500));
    await tailer.scan();
    assert.equal(agent.tokensIn, 5100,
      '0408-F6: growth un-settles the file and folds ONLY the new bytes');
    assert.equal(agent.tokensOut, 510);
    assert.ok(agent.costSession > costAfterFirst, 'resumed spend priced');
    assert.equal(tailer.settledCount(), 0, 'un-settled while active again');

    // And it settles AGAIN after the resumed burst goes idle — still no re-read.
    await sleep(120); await tailer.scan();
    assert.equal(tailer.settledCount(), 1, 're-settles after the resume goes idle');
    await tailer.scan();
    assert.equal(agent.tokensIn, 5100, 'no double count across the settle cycles');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an untouched settled file stays settled — stat-only, totals frozen', async () => {
  const { agent, cwd, subDir } = setup();
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 40 });
  try {
    await tailer.scan();
    writeFileSync(join(subDir, 'agent-quiet.jsonl'), usageLine(7, 3));
    await tailer.scan();
    await sleep(100); await tailer.scan();
    assert.equal(tailer.settledCount(), 1);
    for (let i = 0; i < 5; i++) await tailer.scan();
    assert.equal(agent.tokensIn, 7, 'no growth → no reads, no changes');
    assert.equal(tailer.settledCount(), 1, 'stays settled');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
