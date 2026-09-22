// tests/cursorTranscriptTailer.test.mjs — thin Cursor JSONL → agent state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startCursorTranscriptTailer } from '../server/providers/cursor/transcriptTailer.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor');
const CHAT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeAgent(home, cwd = '/tmp/mc-cursor-spike') {
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd,
    sessionId: CHAT_ID,
    status: 'idle',
    activity: '',
    tail: [],
    todos: [],
    pendingSubagents: new Map(),
    turnCount: 0,
    messageCount: 0,
    lastEventTs: 0,
    lastConnectorTs: 0,
    sessionStartedAt: null,
    appendTail(ln) {
      this.tail.push({ ...ln, ts: Date.now() });
    },
  });
  return agent;
}

function seedTranscript(home, { cwd = '/tmp/mc-cursor-spike', transcriptSrc = 'session.transcript.jsonl' } = {}) {
  const enc = 'tmp-mc-cursor-spike'; // arbitrary — tailer globs by chatId
  const tdir = join(home, '.cursor', 'projects', enc, 'agent-transcripts', CHAT_ID);
  mkdirSync(tdir, { recursive: true });
  copyFileSync(join(FIX, transcriptSrc), join(tdir, `${CHAT_ID}.jsonl`));
  const md5 = createHash('md5').update(cwd).digest('hex');
  const mdir = join(home, '.cursor', 'chats', md5, CHAT_ID);
  mkdirSync(mdir, { recursive: true });
  copyFileSync(join(FIX, 'session.meta.json'), join(mdir, 'meta.json'));
  return { tdir, mdir };
}

test('tailer: finds transcript by chatId glob (not re-derived encoding)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cursor-tail-'));
  try {
    seedTranscript(home);
    const agent = makeAgent(home);
    const t = startCursorTranscriptTailer({ agent, homeDir: home, drive: 'external' });
    t.tick();
    assert.ok(agent.tail.some((e) => e.kind === 'user'), 'user lines mapped');
    assert.ok(agent.tail.some((e) => e.kind === 'asst'), 'assistant text mapped');
    assert.ok(agent.tail.some((e) => e.kind === 'tool'), 'tool_use → tool rows');
    assert.ok(agent.sessionStartedAt != null, 'meta createdAtMs → sessionStartedAt');
    assert.equal(agent.sessionStartedAt, 1790112511825);
    t.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tailer: TodoWrite-like CallDynamicTool updates agent.todos', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cursor-todo-'));
  try {
    seedTranscript(home);
    const agent = makeAgent(home);
    const t = startCursorTranscriptTailer({ agent, homeDir: home, drive: 'external' });
    t.tick();
    assert.ok(Array.isArray(agent.todos) && agent.todos.length >= 1, 'todos populated');
    assert.ok(agent.todos.some((x) => /subagent|ls|done/i.test(x.content)));
    t.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tailer: Task-like tool_use adds pendingSubagents', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cursor-sub-'));
  try {
    seedTranscript(home);
    const agent = makeAgent(home);
    const t = startCursorTranscriptTailer({ agent, homeDir: home, drive: 'external' });
    t.tick();
    assert.ok(agent.pendingSubagents.size >= 1, `expected pending subagent, got ${agent.pendingSubagents.size}`);
    t.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tailer: missing transcript is a no-op (poll for creation)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cursor-miss-'));
  try {
    const agent = makeAgent(home);
    const t = startCursorTranscriptTailer({ agent, homeDir: home, drive: 'external' });
    t.tick();
    assert.equal(agent.tail.length, 0);
    t.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tailer: incremental append on tick after growth', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cursor-inc-'));
  try {
    const { tdir } = seedTranscript(home, { transcriptSrc: 'session.subagent.transcript.jsonl' });
    const agent = makeAgent(home);
    const t = startCursorTranscriptTailer({ agent, homeDir: home, drive: 'external' });
    t.tick();
    const n = agent.tail.length;
    const prev = readFileSync(join(FIX, 'session.subagent.transcript.jsonl'), 'utf8').trimEnd();
    writeFileSync(
      join(tdir, `${CHAT_ID}.jsonl`),
      `${prev}\n{"role":"user","message":{"content":[{"type":"text","text":"ping"}]}}\n`,
    );
    t.tick();
    assert.ok(agent.tail.length > n);
    assert.ok(agent.tail.some((e) => e.kind === 'user' && /ping/.test(e.text)));
    t.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
