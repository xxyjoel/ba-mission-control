// tests/approvalPrompt.test.mjs — 0180: claude's tool-permission prompt is
// PTY-only (never in the session JSONL), so PtyAgent derives 'waiting' by
// scanning the rendered terminal. These pin the human-approved triple-anchor
// heuristic (question + `1. Yes` + `No, and/keep`) and the toJSON overlay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent, detectApprovalPrompt } from '../server/ptyAgent.mjs';

// ── pure heuristic ─────────────────────────────────────────────
const PROMPT_ROWS = [
  '│ Bash command                          │',
  '│ npm test                              │',
  '│ Do you want to proceed?               │',
  '│ ❯ 1. Yes                              │',
  "│   2. Yes, and don't ask again         │",
  '│   3. No, and tell Claude what to do   │',
];

test('detects a full permission-prompt block (all three anchors)', () => {
  assert.equal(detectApprovalPrompt(PROMPT_ROWS), true);
});

test('detects the plan-exit variant (Would you like / No, keep planning)', () => {
  assert.equal(detectApprovalPrompt([
    'Would you like to proceed?',
    '❯ 1. Yes, and auto-accept edits',
    '  2. Yes, and manually approve edits',
    '  3. No, keep planning',
  ]), true);
});

test('detects the edit variant (Do you want to make this edit to … / No, and)', () => {
  assert.equal(detectApprovalPrompt([
    '│ Edit file                             │',
    '│ Do you want to make this edit to App.jsx? │',
    '│ ❯ 1. Yes                              │',
    '│   2. Yes, allow all edits this session │',
    '│   3. No, and tell Claude what to do   │',
  ]), true);
});

test('detects the write/run variant (Do you want to create … / No, and)', () => {
  assert.equal(detectApprovalPrompt([
    'Do you want to create tui/foo.jsx?',
    '❯ 1. Yes',
    '  3. No, and tell Claude what to do differently',
  ]), true);
});

test('no match when only the question is present (asst prose quoting it)', () => {
  // Acceptance #3: must not flip 'waiting' without the option block.
  assert.equal(detectApprovalPrompt([
    'I could do that, but do you want to proceed with the risky migration?',
    'Let me know and I will continue.',
  ]), false);
});

test('no match when only Yes/No options exist without the question', () => {
  assert.equal(detectApprovalPrompt([
    'Here are the choices:',
    '1. Yes please',
    '2. No, and never',   // "No, and" present, but no proceed/continue question
  ]), false);
});

test('no match on normal working output (spinner / tool stream)', () => {
  assert.equal(detectApprovalPrompt([
    '✻ Running… (esc to interrupt)',
    '· Reading server/ptyAgent.mjs',
    '· 1. first result  2. second result',
  ]), false);
});

test('empty / non-array input is safe', () => {
  assert.equal(detectApprovalPrompt([]), false);
  assert.equal(detectApprovalPrompt(null), false);
  assert.equal(detectApprovalPrompt(undefined), false);
});

// ── toJSON overlay (real xterm term via injected fake PTY) ──────
function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 4321 + spawned.length, _bin: bin, _args: args, _opts: opts,
      write() {}, kill() {}, resize() {},
      onData(fn) { handlers.data.push(fn); return { dispose() {} }; },
      onExit(fn) { handlers.exit.push(fn); return { dispose() {} }; },
      fireData(s) { for (const fn of handlers.data) fn(s); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function bootAgent() {
  const spawn = makeFakeSpawn();
  const agent = new PtyAgent({
    slot: 1, id: 's1', cwd: '/tmp/fake-cwd-0180', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn,
  });
  agent.start();
  return { agent, pty: spawn.spawned[0] };
}

// Push >24 lines so the buffer scrolls and `tail` lands in the bottom viewport.
// xterm-headless parses writes ASYNCHRONOUSLY, so flush the write queue (the
// empty-write callback fires once prior writes are parsed) before reading the
// buffer. In production toJSON runs on a later render tick, so the buffer is
// already parsed — this await only compensates for the synchronous test.
async function paint(agent, pty, tailLines) {
  let s = '';
  for (let i = 0; i < 20; i++) s += `filler line ${i}\r\n`;
  s += tailLines.join('\r\n') + '\r\n';
  pty.fireData(s);
  await new Promise((res) => agent.term.write('', res));
}

test('toJSON overlays working → waiting while a permission prompt is rendered', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'working';
  await paint(agent, pty, [
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No, and tell Claude what to do differently',
  ]);
  assert.equal(agent.toJSON().status, 'waiting', 'prompt up → card reads waiting');
  agent.kill?.();
});

test('toJSON reverts waiting → working once the prompt leaves the bottom', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'working';
  await paint(agent, pty, ['Do you want to proceed?', '❯ 1. Yes', '  3. No, and tell Claude what to do']);
  assert.equal(agent.toJSON().status, 'waiting');
  // claude proceeds: a fresh screenful of tool output pushes the prompt away.
  await paint(agent, pty, ['running tests…', 'PASS tests/foo', 'PASS tests/bar', 'done']);
  assert.equal(agent.toJSON().status, 'working', 'prompt gone → back to working');
  agent.kill?.();
});

test('toJSON does NOT accrue STUCK while parked on a permission prompt', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'working';
  await paint(agent, pty, [
    'Do you want to make this edit to App.jsx?',
    '❯ 1. Yes',
    '  3. No, and tell Claude what to do differently',
  ]);
  // Simulate the prompt having been on screen, silent, for >5 minutes.
  agent.lastEventTs = Date.now() - 6 * 60000;
  const json = agent.toJSON();
  assert.equal(json.status, 'waiting', 'edit-approval prompt → waiting (INPUT?)');
  assert.equal(json.stuckMin, 0, 'waiting on the user is not STUCK');
  agent.kill?.();
});

test('toJSON STILL marks STUCK when working and silent with no prompt up', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'working';
  await paint(agent, pty, ['running tests…', 'PASS tests/foo', 'PASS tests/bar']);
  agent.lastEventTs = Date.now() - 6 * 60000;
  const json = agent.toJSON();
  assert.equal(json.status, 'working');
  assert.ok(json.stuckMin >= 5, 'genuinely wedged working session still flags STUCK');
  agent.kill?.();
});

test('hooked+working: approval-SHAPED content does not false-flip while output flows', async () => {
  // 0256 repro: a genuinely-working session (hookStatus 'working' from a live
  // PreToolUse) that RENDERS approval-shaped text it doesn't own — its own test
  // fixtures, this detector's source, a web page. Fresh PTY output means the
  // session is streaming, so the anchors are content, not a live prompt.
  const { agent, pty } = bootAgent();
  agent.hookStatus = 'working';
  agent.hookStatusTs = Date.now();
  await paint(agent, pty, [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  3. No, and tell Claude what to do differently',
  ]);
  // paint() just wrote bytes → ptyFresh → still working, NOT INPUT?.
  assert.equal(agent.toJSON().status, 'working', 'fresh output → content, not a prompt');
  // Once output settles (a real prompt blocks the session, PTY goes quiet past
  // WORKING_FRESH_MS) the same buffer now reads as a genuine prompt.
  agent.lastPtyTs = Date.now() - 5000;
  assert.equal(agent.toJSON().status, 'waiting', 'settled PTY + anchors → real prompt');
  agent.kill?.();
});

test('toJSON does NOT overlay when status is idle (no false waiting)', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'idle';
  await paint(agent, pty, ['Do you want to proceed?', '❯ 1. Yes', '  3. No, and tell Claude']);
  // idle means the turn ended; we only overlay over 'working'.
  assert.equal(agent.toJSON().status, 'idle');
  agent.kill?.();
});
