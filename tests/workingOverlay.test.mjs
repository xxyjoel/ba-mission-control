// tests/workingOverlay.test.mjs — 0198: the JSONL turn-boundary idle bug.
// claude emits end_turn / turn_duration mid-work and keeps streaming, so
// jsonlConnector reads 'idle' for several seconds while the session is plainly
// still active — the card flashed IDLE while WORKING. PtyAgent.toJSON now
// overlays idle → working when the rendered terminal still shows claude's
// "(esc to interrupt)" active-turn indicator. These pin the pure detector and
// the toJSON overlay, and guard that a genuine idle (hint gone) stays idle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent, detectWorking } from '../server/ptyAgent.mjs';

// ── pure detector ──────────────────────────────────────────────
test('detectWorking matches the interrupt hint claude shows mid-turn', () => {
  assert.equal(detectWorking(['✻ Running… (esc to interrupt)']), true);
  assert.equal(detectWorking(['* Thinking… (esc to interrupt · ctrl+t to hide todos)']), true);
  // Robust to wording without the leading paren (version drift).
  assert.equal(detectWorking(['Esc to interrupt']), true);
});

test('detectWorking is false for the idle composer (no interrupt hint)', () => {
  assert.equal(detectWorking([
    '╭──────────────────────────────────────╮',
    '│ >                                    │',
    '╰──────────────────────────────────────╯',
    '  ? for shortcuts',
  ]), false);
});

test('detectWorking is safe on empty / non-array input', () => {
  assert.equal(detectWorking([]), false);
  assert.equal(detectWorking(null), false);
  assert.equal(detectWorking(undefined), false);
});

// ── toJSON overlay (real xterm term via injected fake PTY) ──────
function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 7000 + spawned.length, _bin: bin, _args: args, _opts: opts,
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
    slot: 1, id: 's1', cwd: '/tmp/fake-cwd-0198', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn,
  });
  agent.start();
  return { agent, pty: spawn.spawned[0] };
}

// xterm-headless parses writes asynchronously; flush the queue before reading
// the buffer (mirrors approvalPrompt.test.mjs). Production toJSON runs a render
// tick later, so the buffer is already parsed there.
async function paint(agent, pty, tailLines) {
  let s = '';
  for (let i = 0; i < 20; i++) s += `filler line ${i}\r\n`;
  s += tailLines.join('\r\n') + '\r\n';
  pty.fireData(s);
  await new Promise((res) => agent.term.write('', res));
}

test('toJSON overlays idle → working while the interrupt hint is rendered', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'idle'; // connector saw end_turn/turn_duration, but claude kept going
  await paint(agent, pty, ['· Editing server/foo.mjs', '✻ Crunching… (esc to interrupt)']);
  assert.equal(agent.toJSON().status, 'working', 'interrupt hint up → card reads working');
  agent.kill?.();
});

test('toJSON leaves idle alone once the interrupt hint is gone (genuine idle)', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'idle';
  await paint(agent, pty, ['✻ Crunching… (esc to interrupt)']);
  assert.equal(agent.toJSON().status, 'working');
  // claude finishes: the status line is replaced by the idle composer.
  await paint(agent, pty, ['╭───────────╮', '│ >         │', '╰───────────╯', '  ? for shortcuts']);
  assert.equal(agent.toJSON().status, 'idle', 'hint gone → genuinely idle');
  agent.kill?.();
});

test('idle stays idle when the hint LINGERS but no fresh PTY output (false-positive guard)', async () => {
  // The reported regression: a finished session's last working frame keeps the
  // "esc to interrupt" hint in the buffer with no new bytes to clear it. The
  // scan matches, but without fresh PTY output we must NOT flip to working.
  const { agent, pty } = bootAgent();
  agent.status = 'idle';
  await paint(agent, pty, ['✻ Crunching… (esc to interrupt)']);
  assert.equal(agent.toJSON().status, 'working', 'fresh paint + hint → working');
  // Now simulate the session having gone quiet: hint still on screen, but the
  // last PTY byte arrived long ago.
  agent.lastPtyTs = Date.now() - 10000;
  assert.equal(agent.toJSON().status, 'idle', 'stale PTY + lingering hint → idle');
  agent.kill?.();
});

test('toJSON does not disturb a real working status (no regression)', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'working';
  await paint(agent, pty, ['· Reading files', 'no interrupt hint here']);
  assert.equal(agent.toJSON().status, 'working');
  agent.kill?.();
});

test('overlay-working (real status idle) does NOT accrue STUCK', async () => {
  const { agent, pty } = bootAgent();
  agent.status = 'idle';
  await paint(agent, pty, ['✻ Compiling… (esc to interrupt)']);
  // even silent for >5 min, an idle connector status never accrues STUCK.
  agent.lastEventTs = Date.now() - 6 * 60000;
  const json = agent.toJSON();
  assert.equal(json.status, 'working', 'still shows working via overlay');
  assert.equal(json.stuckMin, 0, 'idle connector status is never STUCK');
  agent.kill?.();
});
