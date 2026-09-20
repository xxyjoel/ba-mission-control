// tests/sessionFileTailer.tailPrime.test.mjs — 0416/1 + 0416/6.
//
// Two defects the 2026-09-19 audit proved by running the real module:
//
//   1. Attaching to an existing transcript replayed its history into a scratch
//      object and threw the history away, so the fleet log was EMPTY after
//      every resume and every Mission Control restart (measured on a real
//      24-record transcript: tail.length 0 after prime, 1 after one live
//      event). The fix merges the replayed tail — without duplicating it on
//      the re-attach paths (auto-restart / changeModel / changePermissionMode),
//      which run PtyAgent.start() again against a ring that already holds it.
//
//   2. Nothing knew a conversation's true age. primeStatusFromDisk reads
//      (size - 256 KiB) to EOF, so it has never seen record 0. The fix reads
//      the HEAD once on attach and sets agent.sessionStartedAt.
//
// These tests drive the REAL tailer against a real file on disk, at the path
// the tailer computes (~/.claude/projects/<encoded-cwd>/<sid>.jsonl).
//
// Every stop()/cleanup lives in a `finally` and every assert runs after it: an
// assert that throws while a tailer is live leaks its stat-poll interval and
// `node --test` then hangs instead of reporting the failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startSessionTailer, claudeProjectDir } from '../server/sessionFileTailer.mjs';

// Mirrors the prime's own window (sessionFileTailer REPLAY_BYTES) so the
// sessionStartedAt fixture can prove it reads the head, not the tail.
const REPLAY_BYTES = 256 * 1024;
// Mirrors HEAD_CHUNK, so the fixture can force the chunked head read to span
// more than one read() — a real transcript had a 65 KB first timestamped line.
const HEAD_CHUNK = 64 * 1024;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-tailprime-'));
  const sessionId = `0a1b2c3d-4e5f-6789-abcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  const dir = claudeProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId, status: 'idle', activity: '', tail: [], todos: [],
    tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, context: 0, costSession: 0,
    resolvedModel: null, spawnedAt: Date.now(), lastEventTs: 0,
    // Agent/PtyAgent.appendTail go through jsonlConnector.pushTail; this mock
    // pushes raw, which is the harsher case — the merge has to rebuild
    // _tailChars from an agent that was never keeping it.
    appendTail(e) { this.tail.push({ ...e, ts: e.ts ?? Date.now() }); },
  });
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { agent, filePath, cleanup };
}

function writeJsonl(filePath, records) {
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// A transcript that already existed when mc attached: 3 tail entries
// (user, tool, user) — confirmed against jsonlConnector.parseEvent.
const HISTORY = [
  { type: 'user', message: { role: 'user', content: 'first prompt' } },
  { type: 'assistant', message: {
    role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }],
  } },
  { type: 'user', message: { role: 'user', content: 'second prompt' } },
];

// PtyAgent.start() pushes this sys line at :447, BEFORE it builds the tailer at
// :543 — so the ring is never empty at attach and "tail is empty" can't stand
// in for "fresh attach". Every test here reproduces that shape.
function spawnLine(text) { return { kind: 'sys', text }; }

test('fresh attach merges the replayed transcript into the ring (0416/1)', async () => {
  const { agent, filePath, cleanup } = setup();
  writeJsonl(filePath, HISTORY);
  agent.appendTail(spawnLine('resume pid=4242 model=opus session=0a1b2c3d'));

  const tailer = startSessionTailer({ agent });
  try { await sleep(250); } finally { tailer.stop(); cleanup(); }

  // Before the fix this was 1 — the spawn line alone, with the whole replayed
  // window dropped on the floor.
  assert.equal(agent.tail.length, 4, 'three replayed entries + the spawn line');
  assert.deepEqual(agent.tail.map((e) => e.kind), ['user', 'tool', 'user', 'sys'],
    'replayed history is older than the spawn line, so it sits in front of it');
  assert.equal(agent.tail[0].text, 'first prompt');
  assert.equal(agent.tail[1].tool, 'Bash');
  assert.equal(agent.tail[3].text, 'resume pid=4242 model=opus session=0a1b2c3d');
  // pushTail's char budget must stay in step with the ring it just rebuilt.
  const chars = agent.tail.reduce((n, e) =>
    n + (e.text?.length || 0) + (e.preview?.length || 0) + (e.tool?.length || 0), 0);
  assert.equal(agent._tailChars, chars, '_tailChars accounting survives the merge');
});

test('re-attach over the same transcript does not duplicate the ring (0416/1)', async () => {
  // changeModel / changePermissionMode / auto-restart all tear the tailer down
  // and call PtyAgent.start() again on the SAME agent — the ring already holds
  // the primed window. Counterfactual, measured by making the edit: with the
  // content key dropped from mergeReplayedTail (a blind append) this ends at 9
  // entries with 'first prompt' present twice.
  const { agent, filePath, cleanup } = setup();
  writeJsonl(filePath, HISTORY);
  agent.appendTail(spawnLine('resume pid=4242 model=opus session=0a1b2c3d'));

  const first = startSessionTailer({ agent });
  let afterFirstAttach;
  let second;
  try {
    await sleep(250);
    first.stop();
    afterFirstAttach = agent.tail.length;
    // start() runs again: its own sys lines land, then a second tailer attaches.
    agent.appendTail(spawnLine('model: opus → sonnet'));
    agent.appendTail(spawnLine('resume pid=4343 model=sonnet session=0a1b2c3d'));
    second = startSessionTailer({ agent });
    await sleep(250);
  } finally { first.stop(); second?.stop(); cleanup(); }

  assert.equal(afterFirstAttach, 4, 'precondition: the first attach primed the ring');
  assert.equal(agent.tail.length, 6, 'only the two new sys lines were added');
  assert.equal(agent.tail.filter((e) => e.text === 'first prompt').length, 1,
    'the replayed user entry is not duplicated');
  assert.equal(agent.tail.filter((e) => e.tool === 'Bash').length, 1,
    'the replayed tool entry is not duplicated');
  assert.deepEqual(agent.tail.map((e) => e.kind),
    ['user', 'tool', 'user', 'sys', 'sys', 'sys']);
});

test('sessionStartedAt is record 0\'s timestamp, not the agent\'s lifetime (0416/6)', async () => {
  const { agent, filePath, cleanup } = setup();
  const START = '2026-08-30T09:15:00.000Z';
  const LATER = '2026-09-02T11:00:00.000Z';

  // Real transcripts open with metadata records that carry NO timestamp
  // (surveyed: 16 of 20 did), and the first timestamped record can be bigger
  // than one head chunk — both shapes are in this fixture.
  const firstRecord = {
    type: 'user', timestamp: START,
    message: { role: 'user', content: `opening prompt ${'x'.repeat(90 * 1024)}` },
  };
  const records = [
    { type: 'mode', mode: 'default' },
    { type: 'ai-title', title: 'a session' },
    firstRecord,
  ];
  // Filler so the file is comfortably bigger than the prime's 256 KiB window:
  // if record 0 fell inside that window the head read would be doing no work.
  for (let i = 0; i < 16; i++) {
    records.push({ type: 'user', timestamp: LATER,
      message: { role: 'user', content: `filler ${i} ${'y'.repeat(20 * 1024)}` } });
  }
  writeJsonl(filePath, records);

  const size = statSync(filePath).size;
  const headBytes = Buffer.byteLength(JSON.stringify(firstRecord)) + 200;
  assert.ok(Buffer.byteLength(JSON.stringify(firstRecord)) > HEAD_CHUNK,
    'fixture must force a multi-chunk head read');
  assert.ok(size - REPLAY_BYTES > headBytes,
    'fixture must put record 0 outside the prime window');

  const tailer = startSessionTailer({ agent });
  try { await sleep(400); } finally { tailer.stop(); cleanup(); }

  assert.equal(agent.sessionStartedAt, Date.parse(START),
    'the FIRST timestamped record, not the last and not the agent object');
  assert.notEqual(agent.sessionStartedAt, Date.parse(LATER));
  assert.ok(Date.parse(LATER) - agent.sessionStartedAt > 2 * 24 * 3600 * 1000,
    'first and last records are days apart — the age is the conversation, not the process');
  assert.ok(agent.sessionStartedAt < agent.spawnedAt - 24 * 3600 * 1000,
    'old behaviour was spawnedAt, which is minutes old');
});

test('sessionStartedAt is null when the transcript has no readable start (0416/6)', async () => {
  const { agent, cleanup } = setup();   // no file written
  const tailer = startSessionTailer({ agent });
  try { await sleep(150); } finally { tailer.stop(); cleanup(); }
  assert.equal(agent.sessionStartedAt, null,
    'the contract says null when unknown — never undefined, never a guess');
});

test('sessionStartedAt is filled once the transcript appears (creation poll)', async () => {
  // A launch with --session-id has no file at attach, so the head read returns
  // null. Without a re-read when the creation poll finds the file, the slot
  // would stay ageless for the whole session.
  const { agent, filePath, cleanup } = setup();
  const START = '2026-09-10T12:00:00.000Z';

  const tailer = startSessionTailer({ agent });
  let beforeFile;
  try {
    await sleep(120);
    beforeFile = agent.sessionStartedAt;
    writeJsonl(filePath, [
      { type: 'mode', mode: 'default' },
      { type: 'user', timestamp: START, message: { role: 'user', content: 'hello' } },
    ]);
    await sleep(900);   // first creation-poll attempt is 500ms
  } finally { tailer.stop(); cleanup(); }

  assert.equal(beforeFile, null, 'precondition: nothing to read yet');
  assert.equal(agent.sessionStartedAt, Date.parse(START));
});
