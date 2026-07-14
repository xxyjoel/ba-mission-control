// tests/subagentUsageTailer.test.mjs — sub-agent (sidechain) usage is folded
// into the PARENT session's tokens + cost + tok/min, and NOT into context.
//
// Two layers: the pure applySidechainUsage() accounting rules, and an
// integration pass that writes a real agent-*.jsonl under the parent's
// subagents/ dir and asserts the tailer picks it up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applySidechainUsage, startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';
import { claudeProjectDir } from '../server/sessionFileTailer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAgent(overrides = {}) {
  return { tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0, ...overrides };
}

// ── pure accounting ──────────────────────────────────────────────────────────

test('applySidechainUsage: folds fresh/cache/out into parent totals', () => {
  const a = makeAgent();
  const changed = applySidechainUsage(a, {
    input_tokens: 100, cache_creation_input_tokens: 200,
    cache_read_input_tokens: 1000, output_tokens: 50,
  }, 'sonnet-4.6');
  assert.equal(changed, true);
  assert.equal(a.tokensIn, 300, 'input + cache_creation');
  assert.equal(a.tokensCacheRead, 1000);
  assert.equal(a.tokensOut, 50);
  assert.ok(a.costSession > 0, 'cost attributed from usage + model');
});

test('applySidechainUsage: leaves parent context untouched (sidechain keeps own window)', () => {
  const a = makeAgent({ context: 150000 });
  applySidechainUsage(a, { input_tokens: 1, cache_read_input_tokens: 13000, output_tokens: 9 }, 'sonnet-4.6');
  assert.equal(a.context, 150000, 'context must not move for a sidechain');
});

test('applySidechainUsage: empty/zero usage is a no-op', () => {
  const a = makeAgent();
  assert.equal(applySidechainUsage(a, {}, 'sonnet-4.6'), false);
  assert.equal(applySidechainUsage(a, null, 'sonnet-4.6'), false);
  assert.equal(a.tokensIn, 0);
});

// ── integration ──────────────────────────────────────────────────────────────

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-subusage-'));
  const sessionId = `0a1b2c3d-4e5f-6789-abcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  const subDir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  const agent = Object.assign(new EventEmitter(), makeAgent(), { cwd, sessionId, spark: [] });
  return { agent, cwd, subDir };
}

function usageLine(usage, model = 'sonnet-4.6') {
  return JSON.stringify({ isSidechain: true, type: 'assistant', message: { model, usage } }) + '\n';
}

test('integration: a sub-agent file appearing after start folds its usage in', async () => {
  const { agent, cwd, subDir } = setup();
  const tailer = startSubagentUsageTailer({ agent, statPollMs: 30 });
  try {
    await sleep(50); // let it prime (dir absent → nothing)
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-aaa.jsonl'),
      usageLine({ input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 500, output_tokens: 40 }));
    await sleep(80);
    assert.equal(agent.tokensIn, 100, 'fresh input folded from the sub-agent');
    assert.equal(agent.tokensCacheRead, 500);
    assert.equal(agent.tokensOut, 40);
    // Append more — should accumulate, not double-count the first line.
    appendFileSync(join(subDir, 'agent-aaa.jsonl'), usageLine({ input_tokens: 5, output_tokens: 5 }));
    await sleep(80);
    assert.equal(agent.tokensIn, 105, 'second line added; first not re-counted');
    assert.equal(agent.tokensOut, 45);
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('integration: files present BEFORE start are primed at EOF (resume-safe)', async () => {
  const { agent, cwd, subDir } = setup();
  mkdirSync(subDir, { recursive: true });
  // Pre-existing historical usage — must NOT be re-counted on attach.
  writeFileSync(join(subDir, 'agent-old.jsonl'),
    usageLine({ input_tokens: 9999, output_tokens: 9999 }));
  const tailer = startSubagentUsageTailer({ agent, statPollMs: 30 });
  try {
    await sleep(80);
    assert.equal(agent.tokensIn, 0, 'historical sub-agent bytes skipped (primed at EOF)');
    // But NEW appends to that same file after prime ARE counted.
    appendFileSync(join(subDir, 'agent-old.jsonl'), usageLine({ input_tokens: 7, output_tokens: 3 }));
    await sleep(80);
    assert.equal(agent.tokensIn, 7, 'post-attach appends counted');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
