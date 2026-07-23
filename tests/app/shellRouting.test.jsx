// tests/app/shellRouting.test.jsx — paired test for task 0319.
//
// Acceptance criteria:
//   1. modal==='shell' renders <ShellOverlay/> replacing the main view.
//   2. Opening from a focused live card calls cdToCwd(card.cwd).
//   3. Opening from FleetView (no live card focused) does NOT call cdToCwd.

import React from 'react';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';

// ── Module-level spy on cdToCwd ──────────────────────────────────────────────
// We mock the shellSession module before importing App so the spy is in place
// at import time. Node's module cache means both App.jsx and this file see the
// same module object after the first require.
import * as shellSession from '../../server/shellSession.mjs';
import { _resetForTest } from '../../server/shellSession.mjs';
import App from '../../tui/App.jsx';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

// ── Stub PTY (keeps node-pty out of the test process) ───────────────────────
function makeStubPty() {
  let _onData = null;
  return {
    pid: 12345,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

// Pre-seed the singleton with a stub before App mounts so getShellSession()
// returns immediately (no real node-pty spawn).
before(() => {
  _resetForTest();
  shellSession.getShellSession({ spawn: () => makeStubPty() });
});

after(() => {
  _resetForTest();
});

// ── FakeFleet ────────────────────────────────────────────────────────────────
class FakeFleet extends EventEmitter {
  constructor(liveSlots = []) {
    super();
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 1; i <= 10; i++) {
      if (liveSlots.includes(i)) {
        this._snap.agents.push({
          id: `s${i}-fake`, slot: i, status: 'idle',
          name: `repo-${i}`, model: 'claude-sonnet-4-6',
          branch: 'main', cwd: `/tmp/repo-${i}`,
          context: 1000, tokensIn: 100, tokensOut: 50,
          costSession: 0.01, costWeek: 0,
          spark: [1, 1, 1], activity: '',
          tail: [], permissionMode: 'default',
          sessionId: `uuid-${i}`,
        });
      } else {
        this._snap.agents.push({ id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
      }
    }
  }
  snapshot() { return { ...this._snap, now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find(a => a.id === id) || null; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
  launch() {}
  resume() {}
  kill() {}
  broadcast() { return { sent: 0, skipped: 0 }; }
  setSlotCostCap() { return true; }
}

const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// ── Acceptance 1: modal==='shell' renders ShellOverlay ───────────────────────
test('pressing ! renders ShellOverlay chrome (shell header + ⌃Q footer)', async () => {
  const fleet = new FakeFleet([]);
  const { stdin, lastFrame, unmount } = render(
    <App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />
  );
  await tick(); await tick();

  await press(stdin, '!');
  await tick(50);

  const frame = strip(lastFrame());
  // ShellOverlay renders header containing 'shell' and footer with ⌃Q
  assert.match(frame, /shell/, 'shell header text must appear');
  assert.match(frame, /⌃Q/, 'footer ⌃Q hint must appear');

  unmount();
});

// ── Acceptance 2: cd issued when opened from a focused live card ─────────────
test('! from focused live card calls cdToCwd with card.cwd', async () => {
  const fleet = new FakeFleet([1, 2]);
  // Spy on cdToCwd — replace with a tracker, restore after.
  const calls = [];
  const orig = shellSession.cdToCwd;
  // Monkeypatching ESM is not directly supported; instead we confirm the
  // atFreshPrompt guard path: seed the singleton as at-prompt so cdToCwd
  // would actually write. We spy by wrapping pty.write.
  const session = shellSession.getShellSession();
  const writes = [];
  const origWrite = session.pty.write.bind(session.pty);
  session.pty.write = (s) => { writes.push(s); origWrite(s); };
  // Mark fresh prompt so cdToCwd passes the guard.
  session.atFreshPrompt = true;

  const { stdin, unmount } = render(
    <App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />
  );
  await tick(); await tick();

  // Focus slot 1 (repo-1 at /tmp/repo-1) then open shell overlay.
  await press(stdin, '1');
  await press(stdin, '!');
  await tick(50); // let setTimeout(() => cdToCwd(...), 0) fire

  // The cd command for slot 1's cwd must have been written to the PTY.
  const cdLine = writes.find(w => w.startsWith('cd ') && w.includes('repo-1'));
  assert.ok(cdLine, `expected a cd line for /tmp/repo-1, got writes: ${JSON.stringify(writes)}`);

  // Restore
  session.pty.write = origWrite;
  unmount();
});

// ── Acceptance 3: no cd when opened from FleetView (no live focus) ───────────
test('! from FleetView (no live sessions) does NOT call cdToCwd', async () => {
  const fleet = new FakeFleet([]); // no live slots
  const session = shellSession.getShellSession();
  const writes = [];
  const origWrite = session.pty.write.bind(session.pty);
  session.pty.write = (s) => { writes.push(s); origWrite(s); };
  session.atFreshPrompt = true;

  const { stdin, unmount } = render(
    <App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />
  );
  await tick(); await tick();

  await press(stdin, '!');
  await tick(50);

  const cdLines = writes.filter(w => w.startsWith('cd '));
  assert.strictEqual(cdLines.length, 0, `expected no cd writes from FleetView, got: ${JSON.stringify(cdLines)}`);

  session.pty.write = origWrite;
  unmount();
});
