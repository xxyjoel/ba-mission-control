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

test('settle: an idle, fully-read file drops out of the poll (late appends ignored)', async () => {
  const { agent, cwd, subDir } = setup();
  // settleIdleMs tiny so the file settles within the test window.
  const tailer = startSubagentUsageTailer({ agent, statPollMs: 20, settleIdleMs: 60 });
  try {
    await sleep(40);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-done.jsonl'), usageLine({ input_tokens: 10, output_tokens: 5 }));
    await sleep(60);
    assert.equal(agent.tokensIn, 10, 'completed sub-agent usage folded');
    // Stay idle past settleIdleMs so the file settles, then append.
    await sleep(140);
    appendFileSync(join(subDir, 'agent-done.jsonl'), usageLine({ input_tokens: 999, output_tokens: 999 }));
    await sleep(80);
    assert.equal(agent.tokensIn, 10, 'settled file is skipped — late append not folded (energy: no re-stat)');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('settle: an actively-growing file is NOT wrongly settled', async () => {
  const { agent, cwd, subDir } = setup();
  const tailer = startSubagentUsageTailer({ agent, statPollMs: 20, settleIdleMs: 60 });
  try {
    await sleep(40);
    mkdirSync(subDir, { recursive: true });
    const f = join(subDir, 'agent-live.jsonl');
    writeFileSync(f, usageLine({ input_tokens: 1, output_tokens: 1 }));
    // Append every ~30ms for a while — keeps it active past settleIdleMs windows.
    for (let i = 0; i < 8; i++) { await sleep(30); appendFileSync(f, usageLine({ input_tokens: 1, output_tokens: 0 })); }
    await sleep(60);
    assert.equal(agent.tokensIn, 9, 'all appends to an active file counted (not settled mid-stream)');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── rotation reset + dir-absent backoff (leak/battery fixes) ───────────────────
// Driven deterministically via the `scan` seam (autoStart:false) — no timing.

test('rotation: sessionId change re-primes the new subagents dir at EOF and drops old-session state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-subusage-rot-'));
  const sid1 = '0a1b2c3d-4e5f-6789-abcd-000000000001';
  const sid2 = '0a1b2c3d-4e5f-6789-abcd-000000000002';
  const dir1 = join(claudeProjectDir(cwd), sid1, 'subagents');
  const dir2 = join(claudeProjectDir(cwd), sid2, 'subagents');
  const agent = Object.assign(new EventEmitter(), makeAgent(), { cwd, sessionId: sid1, spark: [] });
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    mkdirSync(dir1, { recursive: true });
    await tailer.scan(); // prime sid1 (empty)
    writeFileSync(join(dir1, 'agent-s1.jsonl'), usageLine({ input_tokens: 100, output_tokens: 0 }));
    await tailer.scan();
    assert.equal(agent.tokensIn, 100, 'sid1 fan-out counted');

    // Resume/rotate: sid2's dir already holds a HISTORICAL file whose spend is
    // already in the persisted totals — it must be primed at EOF, not re-counted.
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'agent-s2old.jsonl'), usageLine({ input_tokens: 5000, output_tokens: 5000 }));
    agent.sessionId = sid2;
    await tailer.scan();
    assert.equal(agent.tokensIn, 100, 'rotation re-primes sid2 at EOF — historical file not re-counted');

    // New appends under sid2 ARE counted.
    appendFileSync(join(dir2, 'agent-s2old.jsonl'), usageLine({ input_tokens: 7, output_tokens: 0 }));
    await tailer.scan();
    assert.equal(agent.tokensIn, 107, 'post-rotation appends counted');

    // The old session's dir is no longer scanned — appends there are ignored, and
    // its filenames no longer linger in `settled`/`offsets` (the leak).
    appendFileSync(join(dir1, 'agent-s1.jsonl'), usageLine({ input_tokens: 999, output_tokens: 0 }));
    await tailer.scan();
    assert.equal(agent.tokensIn, 107, 'old-session dir not scanned after rotation');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('backoff: a subagents dir that appears after a long absence is still detected (never permanently skipped)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-subusage-bk-'));
  const sid = '0a1b2c3d-4e5f-6789-abcd-0000000000bb';
  const dir = join(claudeProjectDir(cwd), sid, 'subagents');
  const agent = Object.assign(new EventEmitter(), makeAgent(), { cwd, sessionId: sid, spark: [] });
  const tailer = startSubagentUsageTailer({ agent, autoStart: false });
  try {
    // Long absence — well past the grace window, into the backed-off regime.
    for (let i = 0; i < 40; i++) await tailer.scan();
    assert.equal(agent.tokensIn, 0, 'nothing counted while the dir is absent');
    // Dir finally appears with a fresh fan-out file (counted from byte 0).
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-new.jsonl'), usageLine({ input_tokens: 42, output_tokens: 0 }));
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) { await tailer.scan(); seen = agent.tokensIn === 42; }
    assert.equal(agent.tokensIn, 42, 'backoff re-checks and folds the newly-created dir (fresh fan-out from 0)');
  } finally {
    tailer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
