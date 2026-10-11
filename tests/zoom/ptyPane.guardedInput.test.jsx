// tests/zoom/ptyPane.guardedInput.test.jsx — 0446.
//
// Two bugs, one cause: PtyPane wrote keystrokes straight to the pty handle it
// cached at mount (ptyRef.current = session.pty).
//   1. The cost cap lives in PtyCore.send(). Zoom never called send(), so a
//      capped agent still took Enter and pastes from zoom (the review's stub
//      saw ['spend more', '\r'] while send() returned false).
//   2. After :model / :perm respawned claude, ptyRef still pointed at the dead
//      pty, so every keystroke typed in zoom went nowhere.
// The fix routes every zoom write through PtyCore.writeInput, which writes to
// the CURRENT this.pty and refuses submit/paste once the cap is reached.
//
// These pins drive a REAL PtyAgent (injected fake spawn, same pattern as
// tests/ptyAgent.lifecycle.test.mjs), not the zoom stub, so the real
// writeInput and the real respawn path are under test.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { PtyAgent } from '../../server/ptyAgent.mjs';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 4321 + spawned.length,
      _writes: [],
      _kills: [],
      _handlers: handlers,
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize() {},
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireData(s) { for (const fn of [...handlers.data]) fn(s); },
      fireExit({ exitCode = 0, signal = null } = {}) {
        for (const fn of [...handlers.exit]) fn({ exitCode, signal });
      },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeAgent(spawn) {
  return new PtyAgent({
    slot: 1,
    id: 's1-0446',
    cwd: '/tmp/fake-cwd',
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn,
  });
}

function renderPane(agent, { onClose = () => {} } = {}) {
  return render(
    <PtyPane
      agent={agent}
      width={60}
      height={20}
      focus={true}
      onClose={onClose}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
  );
}

test('0446: a capped agent in zoom refuses Enter and paste, and shows the cap message', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 1;
  p.costSession = 1.25;
  const pty = fake.spawned[0];
  const { stdin, lastFrame, unmount } = renderPane(p);
  try {
    await tick(60);
    // Plain keystrokes still reach claude: the user can edit or back out.
    await press(stdin, 'x');
    await press(stdin, '\x7f'); // backspace
    // Enter (submit) and a multi-char chunk (paste) are refused.
    await press(stdin, '\r');
    await press(stdin, 'spend more');
    assert.deepEqual(pty._writes, ['x', '\x7f'],
      'only the plain keystrokes reach the pty; Enter and the paste are refused');
    assert.ok(p.tail.some((e) => e.kind === 'err' && /cost cap reached/.test(e.text)),
      'the agent tail records the same cap message send() uses');
    assert.match(lastFrame(), /cost cap reached/, 'zoom shows the cap message');
    assert.notEqual(p.status, 'working', 'a refused Enter does not mark the agent working');
  } finally {
    unmount();
    p.kill();
  }
});

test('0446: a capped agent in zoom refuses a bracketed paste too', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 1;
  p.costSession = 1;
  const pty = fake.spawned[0];
  // Claude turns bracketed-paste mode on at its prompt.
  pty.fireData('\x1b[?2004h');
  const { stdin, unmount } = renderPane(p);
  try {
    await tick(60);
    await press(stdin, 'spend more');
    assert.deepEqual(pty._writes, [], 'the bracketed paste is refused');
  } finally {
    unmount();
    p.kill();
  }
});

for (const [label, change] of [
  ['changePermissionMode', (p) => p.changePermissionMode('plan')],
  ['changeModel', (p) => p.changeModel('opus-4.7')],
]) {
  test(`0446: after ${label} respawns claude, typing in zoom reaches the new pty`, async () => {
    const fake = makeFakeSpawn();
    const p = makeAgent(fake);
    p.start();
    let closes = 0;
    const { stdin, lastFrame, unmount } = renderPane(p, { onClose: () => { closes++; } });
    try {
      await tick(60);
      await press(stdin, 'a');
      const old = fake.spawned[0];
      assert.deepEqual(old._writes, ['a'], 'before the respawn, keys reach the first pty');
      change(p);
      // 0441: the successor spawns only once the old claude has exited.
      old.fireExit({ exitCode: 0, signal: 15 });
      assert.equal(fake.spawned.length, 2, 'respawned once');
      const fresh = fake.spawned[1];
      assert.equal(p.pty, fresh);
      await press(stdin, 'b');
      await press(stdin, '\r');
      assert.deepEqual(old._writes, ['a'], 'nothing more goes to the dead pty');
      assert.deepEqual(fresh._writes, ['b', '\r'], 'keys typed after the respawn reach the new pty');
      // 0446: the respawn's exit of the old claude does not close zoom.
      await tick(20);
      assert.equal(closes, 0, 'zoom stays open across the respawn');
      assert.doesNotMatch(lastFrame(), /claude exited/);
      // A real exit of the successor still closes zoom.
      fresh.fireExit({ exitCode: 1, signal: 0 });
      await tick(20);
      assert.equal(closes, 1, 'an exit of the new claude closes zoom');
    } finally {
      unmount();
      p.kill();
    }
  });
}

// ─── PtyCore.writeInput unit pins ───────────────────────────────────

test('0446: writeInput and send() refuse with the same cap message', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 2;
  p.costSession = 3;
  assert.equal(p.send('hi'), false);
  const fromSend = p.tail.at(-1).text;
  assert.equal(p.writeInput('\r', { submit: true }), false);
  assert.equal(p.tail.at(-1).text, fromSend, 'one message for both paths');
  assert.equal(fromSend, p.capMessage());
  // A chunk carrying a CR is a submit even when the caller did not say so.
  assert.equal(p.writeInput('go\r'), false);
  // Plain keys pass under the cap.
  assert.equal(p.writeInput('\x1b'), true);
  assert.deepEqual(fake.spawned[0]._writes, ['\x1b']);
  // Cap off: everything passes.
  p.costCapUSD = 0;
  assert.equal(p.capMessage(), null);
  assert.equal(p.writeInput('\r', { submit: true }), true);
  p.kill();
});

test('0446: writeInput with no live pty drops the bytes and does not revive', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const old = fake.spawned[0];
  p.changeModel('opus-4.7'); // 0441 window: old claude still stopping, pty null
  assert.equal(p.pty, null);
  assert.equal(p.writeInput('x'), false);
  assert.deepEqual(old._writes, []);
  assert.equal(fake.spawned.length, 1, 'no spawn from a keystroke');
  assert.equal(p.pendingSends.length, 0, 'keystrokes are not queued as messages');
  p.kill();
});

test('0446: a held Enter under the cap logs one tail line, not one per key', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 1;
  p.costSession = 2;
  const before = p.tail.length;
  for (let i = 0; i < 5; i++) assert.equal(p.writeInput('\r', { submit: true }), false);
  assert.equal(p.tail.length, before + 1, 'one refusal line for the run');
  // An accepted submit ends the run; the next refusal logs again.
  p.costCapUSD = 0;
  assert.equal(p.writeInput('\r', { submit: true }), true);
  p.costCapUSD = 1;
  assert.equal(p.writeInput('\r', { submit: true }), false);
  assert.equal(p.tail.length, before + 2);
  p.kill();
});

test('0446: one emoji is a key, not a paste the cap refuses', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 1;
  p.costSession = 2;
  const pty = fake.spawned[0];
  const { stdin, lastFrame, unmount } = renderPane(p);
  try {
    await tick(60);
    await press(stdin, '\u{1F600}');
    assert.deepEqual(pty._writes, ['\u{1F600}']);
    assert.doesNotMatch(lastFrame(), /cost cap reached/);
  } finally {
    unmount();
    p.kill();
  }
});

test('0446: the cap notice clears once the cap is raised', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.costCapUSD = 1;
  p.costSession = 2;
  const { stdin, lastFrame, unmount } = renderPane(p);
  try {
    await tick(60);
    await press(stdin, '\r');
    assert.match(lastFrame(), /cost cap reached/);
    p.costCapUSD = 10;
    // Any repaint drops it — here claude echoing a typed key.
    await press(stdin, 'x');
    p.pty.fireData('x');
    await tick(60);
    assert.doesNotMatch(lastFrame(), /cost cap reached/);
  } finally {
    unmount();
    p.kill();
  }
});
