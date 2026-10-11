// tests/ptyAgent.childEnv.test.mjs — 0469: claude's per-session markers never
// reach the claude a slot spawns.
//
// When mc is started from inside a claude session, process.env carries that
// session's markers. A slot's claude that inherits CLAUDE_CODE_CHILD_SESSION
// says "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"
// and writes no transcript, so status, resume and :model have nothing to read.
// The marker list is claude's own (the env keys claude 2.1.x keeps out of the
// env it hands to child shells), plus the per-session IPC / entrypoint keys.
// User settings (CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_*, CLAUDE_CODE_MAX_OUTPUT_TOKENS)
// must still pass through.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

const MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: '11111111-2222-3333-4444-555555555555',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/fake/claude',
  CLAUDE_CODE_INVOKED_SKILLS: 'x',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/fake.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge',
  CLAUDE_PID: '4242',
  CLAUDE_EFFORT: 'high',
  AI_AGENT: 'claude-code_2-1-294_harness',
  TRACEPARENT: '00-abc-def-01',
};
const USER_SETTINGS = {
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
};

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete saved[k];
  }
});

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const pty = {
      pid: 9100 + spawned.length, _opts: opts,
      write() {}, kill() {}, resize() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function spawnEnv(extra = {}) {
  const fake = makeFakeSpawn();
  const a = new PtyAgent({
    slot: 4, cwd: '/tmp/safe-cwd', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000469',
    spawn: fake, signalGroup: () => {}, ...extra,
  });
  a.start();
  try {
    return fake.spawned[0]._opts.env;
  } finally {
    try { a.kill(); } catch {}
  }
}

test('0469: the default spawn env drops claude session markers, keeps user settings', () => {
  setEnv({ ...MARKERS, ...USER_SETTINGS });
  const env = spawnEnv();
  for (const k of Object.keys(MARKERS)) assert.ok(!(k in env), `${k} leaked into the claude child env`);
  for (const [k, v] of Object.entries(USER_SETTINGS)) assert.equal(env[k], v, `${k} must pass through`);
  assert.equal(env.TERM, 'xterm-256color');
});

test('0469: the env-overlay spawn path drops inherited markers too', () => {
  setEnv({ ...MARKERS, ...USER_SETTINGS });
  const env = spawnEnv({ env: { HOME: '/tmp/overlay-home' } });
  for (const k of Object.keys(MARKERS)) assert.ok(!(k in env), `${k} leaked into the claude child env`);
  for (const [k, v] of Object.entries(USER_SETTINGS)) assert.equal(env[k], v, `${k} must pass through`);
  assert.equal(env.HOME, '/tmp/overlay-home');
});
