// tests/sessionFileTailer.integration.test.mjs — end-to-end check
// that the tailer reads a real JSONL file from disk and drives
// agent state via jsonlConnector.parseEvent.
//
// Failure here would explain "zoom to summary connector still broken"
// — the file-watch + offset + parseEvent chain is the actual hot
// path for in-zoom updates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { startSessionTailer, claudeProjectDir } from '../server/sessionFileTailer.mjs';

// The tailer computes its watch path from
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// so we have to create the file at that exact location. For the test
// we use a unique cwd inside the system tmp dir so the encoded path
// is unique and we can clean up.

function setupAgent() {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-tailer-int-'));
  const sessionId = `0a1b2c3d-4e5f-6789-abcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  // Make sure claude's project dir exists; the tailer's stat will
  // fail otherwise and we'd be testing the file-doesn't-exist path
  // rather than the live-watch path.
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const filePath = join(claudeProjectDir(cwd), `${sessionId}.jsonl`);

  // Minimal agent shape — mirrors what Agent / PtyAgent will look
  // like for the connector. Must extend EventEmitter because the
  // tailer calls agent.emit('change').
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd,
    sessionId,
    status: 'idle',
    activity: '',
    tail: [],
    todos: [],
    tokensIn: 0,
    tokensOut: 0,
    context: 0,
    costSession: 0,
    resolvedModel: null,
    permissionMode: 'acceptEdits',
    lastEventTs: 0,
  });

  return { agent, filePath, cwd };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('integration: tailer picks up appended user event', async () => {
  const { agent, filePath, cwd } = setupAgent();
  let changeCount = 0;
  agent.on('change', () => { changeCount++; });

  const tailer = startSessionTailer({ agent });
  // give init() a tick to attach the watcher / poll loop
  await sleep(150);

  // Append a real user event — same shape as claude writes.
  const ev = {
    type: 'user',
    message: { role: 'user', content: 'integration test prompt' },
    sessionId: agent.sessionId,
  };
  appendFileSync(filePath, JSON.stringify(ev) + '\n');

  // Wait for fs.watch or the poll loop to pick it up. macOS append
  // events fire within ~100ms per R7 probe.
  await sleep(750);

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });

  assert.ok(changeCount >= 1, `expected at least one 'change' emit, got ${changeCount}`);
  assert.equal(agent.tail.length, 1, 'one user entry should be appended');
  assert.equal(agent.tail[0].kind, 'user');
  assert.match(agent.tail[0].text, /integration test prompt/);
  assert.equal(agent.status, 'working');
  assert.equal(agent.activity, 'integration test prompt');
});

test('integration: tailer accumulates tokens + cost from assistant event', async () => {
  const { agent, filePath, cwd } = setupAgent();
  const tailer = startSessionTailer({ agent });
  await sleep(150);

  // Real-shape assistant event with usage that matches a known
  // model. Numbers chosen so we can verify cost.
  const ev = {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 500,
      },
    },
    sessionId: agent.sessionId,
  };
  appendFileSync(filePath, JSON.stringify(ev) + '\n');
  await sleep(750);

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });

  assert.equal(agent.tokensIn, 1000);
  assert.equal(agent.tokensOut, 500);
  assert.equal(agent.context, 1000);
  // Opus 4.7: 1000*15 + 500*75 = 52500 / 1e6 = 0.0525
  assert.ok(Math.abs(agent.costSession - 0.0525) < 0.0001, `got ${agent.costSession}`);
  // end_turn → idle
  assert.equal(agent.status, 'idle');
  assert.equal(agent.resolvedModel, 'claude-opus-4-7');
});

test('integration: tailer picks up file created AFTER attach (poll path)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-tailer-int-late-'));
  const sessionId = `1a2b3c4d-5e6f-7890-abcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const filePath = join(claudeProjectDir(cwd), `${sessionId}.jsonl`);

  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId,
    status: 'idle', activity: '', tail: [], todos: [],
    tokensIn: 0, tokensOut: 0, context: 0, costSession: 0,
    resolvedModel: null, permissionMode: 'acceptEdits', lastEventTs: 0,
  });

  let changeCount = 0;
  agent.on('change', () => changeCount++);

  // File doesn't exist yet — tailer must poll
  const tailer = startSessionTailer({ agent });
  await sleep(200);

  // Now create the file with an event
  writeFileSync(filePath, JSON.stringify({
    type: 'user',
    message: { content: 'late-bound prompt' },
  }) + '\n');

  // Poll runs every 500ms; give it room
  await sleep(1500);

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });

  assert.ok(changeCount >= 1, `tailer never fired; changeCount=${changeCount}`);
  assert.equal(agent.tail.length, 1);
  assert.equal(agent.tail[0].text, 'late-bound prompt');
});

test('integration: malformed JSON line is skipped, valid lines still parse', async () => {
  const { agent, filePath, cwd } = setupAgent();
  const tailer = startSessionTailer({ agent });
  await sleep(150);

  // Append a garbage line followed by a valid one
  appendFileSync(filePath, 'this is not json\n');
  appendFileSync(filePath, JSON.stringify({
    type: 'user',
    message: { content: 'survives the garbage' },
  }) + '\n');
  await sleep(750);

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });

  assert.equal(agent.tail.length, 1);
  assert.equal(agent.tail[0].text, 'survives the garbage');
});

test('integration: status is derived from the tail on attach (0178)', async () => {
  const { agent, filePath, cwd } = setupAgent();
  // Events that existed on disk BEFORE mc attaches: a turn that ends blocked on
  // an AskUserQuestion → status must be 'waiting' the moment we attach, with no
  // new appends. The assistant event carries usage so we can prove the replay
  // does NOT pollute the agent's additive token counters (scratch-object guard).
  const lines = [
    { type: 'user', message: { role: 'user', content: 'do a thing' } },
    { type: 'assistant', message: {
      role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'tool_use', name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which?', multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }] }] } }],
    } },
  ];
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const tailer = startSessionTailer({ agent });   // attach AFTER the events exist
  await sleep(200);
  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });

  assert.equal(agent.status, 'waiting', 'status derived from pre-existing tail');
  assert.ok(agent.awaitingPrompt, 'awaitingPrompt primed on attach');
  assert.equal(agent.awaitingPrompt.tool, 'AskUserQuestion');
  // The bounded replay must not corrupt additive counters.
  assert.equal(agent.tokensIn, 0, 'token counters untouched by the prime replay');
  assert.equal(agent.tokensOut, 0);
});

test('integration: stop() halts further updates', async () => {
  const { agent, filePath, cwd } = setupAgent();
  const tailer = startSessionTailer({ agent });
  await sleep(150);

  // First event arrives — counted
  appendFileSync(filePath, JSON.stringify({
    type: 'user', message: { content: 'first' },
  }) + '\n');
  await sleep(400);
  assert.equal(agent.tail.length, 1);

  // Stop the tailer, append another, give it time, expect no growth
  tailer.stop();
  appendFileSync(filePath, JSON.stringify({
    type: 'user', message: { content: 'should not arrive' },
  }) + '\n');
  await sleep(400);

  rmSync(cwd, { recursive: true, force: true });
  assert.equal(agent.tail.length, 1, 'no events after stop()');
});
