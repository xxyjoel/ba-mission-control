// tests/subagentUsageTailer.workflows.test.mjs — WORKFLOW sub-agents live one
// level deeper than Task sub-agents:
//   subagents/agent-<id>.jsonl                      (Task)
//   subagents/workflows/<runId>/agent-<id>.jsonl    (Workflow)
// The tailer's flat readdir saw "workflows" as a plain name, failed the
// agent-*.jsonl filter and dropped every workflow agent. Measured on the stonks
// slot (add052b8) 2026-09-19 22:40: 20 files scanned, 60 skipped; inside the 60s
// liveAgents window 0 scanned vs 4 skipped, the newest written 1s earlier. So
// the card counted zero background agents while workflows ran and their tokens
// never reached the parent session.
//
// Scans are driven by hand through the `autoStart:false` seam — no sleeps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';
import { claudeProjectDir } from '../server/sessionFileTailer.mjs';

function setup(tag) {
  const cwd = mkdtempSync(join(tmpdir(), `mc-subwf-${tag}-`));
  const sessionId = '0a1b2c3d-4e5f-6789-abcd-00000000wf01';
  const subDir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  const agent = Object.assign(new EventEmitter(), {
    tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0,
    cwd, sessionId, spark: [],
  });
  return { agent, cwd, subDir };
}

function usageLine(usage, model = 'sonnet-4.6') {
  return JSON.stringify({ isSidechain: true, type: 'assistant', message: { model, usage } }) + '\n';
}

function writeAgentFile(dir, name, usage) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), usageLine(usage));
}

test('workflow: a nested agent file is folded into the parent alongside the flat one', async () => {
  const { agent, cwd, subDir } = setup('both');
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    mkdirSync(subDir, { recursive: true });
    await tailer.scan();                       // prime on an empty dir
    // Fresh fan-out in BOTH layouts.
    writeAgentFile(subDir, 'agent-task.jsonl', { input_tokens: 10, output_tokens: 1 });
    writeAgentFile(join(subDir, 'workflows', 'wf_run1'), 'agent-flow.jsonl',
      { input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 7 });
    await tailer.scan();
    // Pre-fix this read 10 / 0 / 1 — the workflow agent was never opened.
    assert.equal(agent.tokensIn, 510, 'flat + nested fresh input');
    assert.equal(agent.tokensCacheRead, 2000, 'nested cache reads folded');
    assert.equal(agent.tokensOut, 8, 'flat + nested output');
    assert.ok(agent.costSession > 0, 'nested spend carries cost');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow: the same basename in two run dirs is tracked per path, not per name', async () => {
  const { agent, cwd, subDir } = setup('dup');
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    mkdirSync(subDir, { recursive: true });
    await tailer.scan();
    // Two runs, identical file names. Keying state by bare filename counts one
    // of them and then reads the second as "already at EOF" — pre-fix 100.
    writeAgentFile(join(subDir, 'workflows', 'wf_a'), 'agent-dup.jsonl', { input_tokens: 100, output_tokens: 0 });
    writeAgentFile(join(subDir, 'workflows', 'wf_b'), 'agent-dup.jsonl', { input_tokens: 100, output_tokens: 0 });
    await tailer.scan();
    assert.equal(agent.tokensIn, 200, 'both run dirs counted');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow: a pre-existing nested file primes at EOF, later appends count', async () => {
  const { agent, cwd, subDir } = setup('prime');
  const runDir = join(subDir, 'workflows', 'wf_old');
  writeAgentFile(runDir, 'agent-hist.jsonl', { input_tokens: 9999, output_tokens: 9999 });
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    await tailer.scan();
    assert.equal(agent.tokensIn, 0, 'historical nested bytes skipped (primed at EOF)');
    appendFileSync(join(runDir, 'agent-hist.jsonl'), usageLine({ input_tokens: 7, output_tokens: 3 }));
    await tailer.scan();
    assert.equal(agent.tokensIn, 7, 'post-prime nested append counted');
    assert.equal(agent.tokensOut, 3);
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow: liveAgents reports a nested agent under its bare id', async () => {
  const { agent, cwd, subDir } = setup('live');
  // Default settleIdleMs — a settled file drops out of lastGrowTs, and this
  // asserts on the live window, not on settling.
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    mkdirSync(subDir, { recursive: true });
    await tailer.scan();
    writeAgentFile(join(subDir, 'workflows', 'wf_run9'), 'agent-nested9.jsonl', { input_tokens: 3, output_tokens: 1 });
    await tailer.scan();
    const live = tailer.liveAgents({ withinMs: 60_000 });
    // Pre-fix the nested file was never listed, so the card showed 0 bg agents
    // with four workflow agents writing.
    assert.equal(live.length, 1, 'the nested agent is live');
    assert.equal(live[0].id, 'nested9', 'id is the basename, without the run-dir path');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow: non-agent entries in the workflows tree are ignored', async () => {
  const { agent, cwd, subDir } = setup('noise');
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    mkdirSync(subDir, { recursive: true });
    await tailer.scan();
    const runDir = join(subDir, 'workflows', 'wf_noise');
    writeAgentFile(runDir, 'agent-real.jsonl', { input_tokens: 4, output_tokens: 0 });
    // Claude writes a sidecar per agent; it must not be read as a transcript.
    writeFileSync(join(runDir, 'agent-real.meta.json'), JSON.stringify({ message: { usage: { input_tokens: 111 } } }));
    writeFileSync(join(subDir, 'workflows', 'index.json'), '{}');
    await tailer.scan();
    assert.equal(agent.tokensIn, 4, 'only agent-*.jsonl is read');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
