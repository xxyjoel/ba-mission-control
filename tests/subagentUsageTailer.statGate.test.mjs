// tests/subagentUsageTailer.statGate.test.mjs — 0350: the dir-mtime gate and
// the bounded per-file state.
//
// Before 0350, every scan stat'd every file the subagents dir had ever held,
// settled or not. Measured 2026-10-08: 64 sessions x 137 files = 2,989 stat/s,
// 5.94% of a core. The gate skips settled files while the dir mtime is
// unchanged. On macOS APFS an append does NOT move the dir mtime (checked
// 2026-10-08), so a slow fallback re-stat (settledRecheckMs) still catches a
// resumed sub-agent (0408-F6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  promises as fsp, mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync,
  utimesSync, statSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';
import { claudeProjectDir } from '../server/sessionFileTailer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usageLine = (input_tokens, output_tokens) =>
  JSON.stringify({ isSidechain: true, type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens, output_tokens } } }) + '\n';

let seq = 0;
function setup(root) {
  const cwd = join(root, `slot-${seq}`);
  const sessionId = `0d4e5f60-7182-4a9b-8bcd-${(seq++).toString(16).padStart(12, '0')}`;
  const subDir = join(claudeProjectDir(cwd), sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const agent = Object.assign(new EventEmitter(), {
    cwd, sessionId, tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, context: 0, spark: [],
  });
  return { agent, cwd, subDir };
}

// Write `n` historical files and age them an hour, so prime + one scan settles
// them all with no sleeps (lastGrowTs is seeded from the file mtime — 0411).
function writeOld(subDir, n) {
  const old = (Date.now() - 3600_000) / 1000;
  for (let i = 0; i < n; i++) {
    const f = join(subDir, `agent-${i}.jsonl`);
    writeFileSync(f, usageLine(1, 1));
    utimesSync(f, old, old);
  }
}

// Count fs.promises.stat calls — the tailer imports the same object.
function countStats() {
  const orig = fsp.stat;
  const box = { n: 0, restore() { fsp.stat = orig; } };
  fsp.stat = function (...a) { box.n++; return orig.apply(this, a); };
  return box;
}

function countReaddirs() {
  const orig = fsp.readdir;
  const box = { n: 0, restore() { fsp.readdir = orig; } };
  fsp.readdir = function (...a) { box.n++; return orig.apply(this, a); };
  return box;
}

// A hand-driven clock for the timing tests. It starts at the real time (file
// mtimes seed lastGrowTs) and only moves forward.
function fakeClock() {
  let t = Date.now();
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  return clock;
}

test('0350 cost: 64 slots x 137 settled files — steady-state scans do not stat settled files', async () => {
  const SLOTS = 64, FILES = 137;
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const tailers = [];
  try {
    for (let s = 0; s < SLOTS; s++) {
      const { agent, subDir } = setup(root);
      writeOld(subDir, FILES);
      tailers.push(startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 50 }));
    }
    for (const t of tailers) await t.scan(); // prime (files start at EOF)
    for (const t of tailers) await t.scan(); // idle for an hour → settle
    for (const t of tailers) assert.equal(t.settledCount(), FILES, 'all files settled');

    const c = countStats();
    const r = countReaddirs();
    try {
      for (const t of tailers) await t.scan(); // one steady-state tick, all slots
    } finally { c.restore(); r.restore(); }
    // The listing is NOT gated (a new workflows/<runId>/ file does not move the
    // top dir mtime), so the readdir count is reported, not reduced.
    console.log(`0350 per steady tick (${SLOTS} slots x ${FILES} settled files): ${c.n} stat calls, ${r.n} readdir calls`);
    // Before: one stat per file per slot = 8,768. After: one dir stat per slot.
    assert.ok(c.n <= SLOTS * 2, `expected <= ${SLOTS * 2} stat calls per tick, got ${c.n}`);
  } finally {
    for (const t of tailers) t.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0350 correctness: an append to a settled file is folded within the fallback window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const { agent, subDir } = setup(root);
  // Fake clock, so a stalled machine cannot push the "inside the window" scan
  // past the fallback (the old version slept 350 ms against a 300 ms window).
  const clock = fakeClock();
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 40, settledRecheckMs: 300, clock });
  try {
    await tailer.scan(); // prime: empty dir
    const f = join(subDir, 'agent-resume.jsonl');
    writeFileSync(f, usageLine(100, 10));
    await tailer.scan();
    assert.equal(agent.tokensIn, 100);
    clock.advance(80); await tailer.scan();
    assert.equal(tailer.settledCount(), 1, 'file settled');

    const dirMtime = statSync(subDir).mtimeMs;
    appendFileSync(f, usageLine(5000, 500)); // the parent resumes the sub-agent
    assert.equal(statSync(subDir).mtimeMs, dirMtime, 'an append does not move the dir mtime');
    clock.advance(100); await tailer.scan();
    assert.equal(agent.tokensIn, 100, 'inside the fallback window the gate skips the settled file');

    clock.advance(300); await tailer.scan(); // fallback window elapsed → re-stat settled files
    assert.equal(agent.tokensIn, 5100, 'resumed usage folded once the fallback re-stat runs');
    assert.equal(agent.tokensOut, 510);
    await tailer.scan();
    assert.equal(agent.tokensIn, 5100, 'no double count');
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0350 correctness: a dir mtime change re-stats settled files on the next scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const { agent, subDir } = setup(root);
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 40, settledRecheckMs: 3600_000 });
  try {
    await tailer.scan();
    const f = join(subDir, 'agent-a.jsonl');
    writeFileSync(f, usageLine(100, 10));
    await tailer.scan();
    await sleep(80); await tailer.scan();
    assert.equal(tailer.settledCount(), 1);

    appendFileSync(f, usageLine(5000, 500));
    await tailer.scan();
    assert.equal(agent.tokensIn, 100, 'gated: the append alone is not seen');
    await sleep(20); // let the clock tick so the new entry's dir mtime differs
    writeFileSync(join(subDir, 'agent-b.jsonl'), usageLine(1, 1)); // new entry → dir mtime moves
    await tailer.scan();
    assert.equal(agent.tokensIn, 5101, 'settled file re-stat\'d (5000) and the new file read (1)');
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0350 bounded: per-file state for deleted sub-agent files is dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const { agent, subDir } = setup(root);
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 50 });
  try {
    writeOld(subDir, 500);
    await tailer.scan(); await tailer.scan();
    assert.equal(tailer.settledCount(), 500);
    await tailer.scan();
    assert.equal(tailer.settledCount(), 500, 'settling is idempotent');
    assert.equal(agent.tokensIn, 0, 'pre-existing files start at EOF — nothing re-read');

    for (let i = 0; i < 490; i++) unlinkSync(join(subDir, `agent-${i}.jsonl`));
    await tailer.scan();
    assert.equal(tailer.settledCount(), 10, 'settled shrinks to the files still on disk');
    assert.equal(tailer.trackedCount(), 10, 'offsets/lastSize shrink too');
    assert.equal(agent.tokensIn, 0, 'no re-read of the survivors');
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0350 gate: a file with an unfinished last line does not switch the gate off', async () => {
  // Review probe A: one sub-agent file ending mid-line (a crash mid-write)
  // never reached EOF, so it never settled, and `offsets.size > settled.size`
  // forced a sweep of every settled file on every scan — 695 stats over 5
  // quiet scans with 137 settled files.
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const { agent, subDir } = setup(root);
  const clock = fakeClock();
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 50, settledRecheckMs: 3600_000, clock });
  try {
    writeOld(subDir, 137);
    await tailer.scan(); await tailer.scan();
    assert.equal(tailer.settledCount(), 137);
    const p = join(subDir, 'agent-crashed.jsonl');
    writeFileSync(p, usageLine(7, 3) + '{"partial'); // no trailing newline
    await tailer.scan();
    assert.equal(agent.tokensIn, 7, 'the complete line is folded');
    clock.advance(80); await tailer.scan(); await tailer.scan();

    const c = countStats();
    try {
      for (let i = 0; i < 5; i++) await tailer.scan();
    } finally { c.restore(); }
    assert.ok(c.n <= 5 * 2, `expected <= 10 stats over 5 quiet scans, got ${c.n}`);

    // Finishing the line later still folds it once, from the kept offset.
    appendFileSync(p, '"}\n' + usageLine(20, 2)); // {"partial"} is not valid JSON
    clock.advance(3600_000); await tailer.scan();
    assert.equal(agent.tokensIn, 27, 'finished line skipped as bad JSON, the next one folded once');
    await tailer.scan();
    assert.equal(agent.tokensIn, 27, 'no double count');
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0350 gate: a busy parent sweeps every scan, so a resumed sub-agent shows at once', async () => {
  // Review defect 2: liveAgents() reads lastGrowTs, which only a stat
  // refreshes. With the gate, a resumed sub-agent in a quiet dir stayed off
  // the card's bg count for up to settledRecheckMs. A resume is driven by the
  // parent (SendMessage), so a parent active in the last settleIdleMs forces
  // the sweep.
  const root = mkdtempSync(join(tmpdir(), 'mc-subgate-'));
  const { agent, subDir } = setup(root);
  const clock = fakeClock();
  const tailer = startSubagentUsageTailer({ agent, autoStart: false, settleIdleMs: 40, settledRecheckMs: 3600_000, clock });
  try {
    await tailer.scan();
    const f = join(subDir, 'agent-r.jsonl');
    writeFileSync(f, usageLine(100, 10));
    await tailer.scan();
    clock.advance(80); await tailer.scan();
    assert.equal(tailer.settledCount(), 1);

    agent.lastSubHookTs = clock(); // a SUB hook event: the resumed agent is working
    appendFileSync(f, usageLine(10, 1));
    await tailer.scan();
    assert.equal(agent.tokensIn, 110, 'resumed usage folded on the next scan');
    assert.equal(tailer.liveAgents({ withinMs: 60_000, now: clock() }).length, 1, 'counted as live');

    // Main-thread transcript activity works the same way.
    clock.advance(80); await tailer.scan();
    assert.equal(tailer.settledCount(), 1, 'settled again once idle');
    agent.lastEventTs = clock();
    appendFileSync(f, usageLine(10, 1));
    await tailer.scan();
    assert.equal(agent.tokensIn, 120);
  } finally {
    tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
