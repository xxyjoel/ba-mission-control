// tests/App.hotkeys.test.jsx — coverage for the App.jsx hotkey layer.
// Hotkeys are the contract between the user and mc; until now they
// were untested. Each test renders the full App against a FakeFleet
// (no claude subprocesses) and asserts what the frame looks like
// after the keystroke.
//
// Audit #244-258 — the "hotkey test coverage" batch.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../tui/App.jsx';

const tick = () => new Promise((r) => setTimeout(r, 30));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

// Tiny stand-in for the real Fleet. Pre-populates `liveSlots` (1-indexed)
// with non-empty placeholder agents so focus + nav tests have something
// to walk. The rest are 'empty' slots.
class FakeFleet extends EventEmitter {
  constructor(liveSlots = []) {
    super();
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 1; i <= 10; i++) {
      if (liveSlots.includes(i)) {
        this._snap.agents.push({
          id: `s${i}-fake`, slot: i, status: 'idle',
          name: `repo-${i}`, model: 'claude-sonnet-4-6',
          branch: 'main', cwd: '/tmp',
          context: 1000, tokensIn: 100, tokensOut: 50,
          costSession: 0.01, costWeek: 0,
          spark: [1,1,1], activity: '',
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
  // Stubs so the App can call them without exploding
  launch() {}
  resume() {}
  kill() {}
  broadcast() { return 0; }
  setSlotCostCap() { return true; }
}

function mount(opts = {}) {
  const fleet = new FakeFleet(opts.liveSlots ?? []);
  return render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
}

// Strip ANSI for cleaner frame matching.
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

test('hotkey: ? opens Help', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, '?');
  const frame = strip(lastFrame());
  assert.match(frame, /KEYBOARD|NAVIGATION|SESSIONS/);
  unmount();
});

test('hotkey: , opens Settings', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, ',');
  const frame = strip(lastFrame());
  // Settings modal has theme/grid keywords
  assert.match(frame, /SETTINGS|theme|grid|density/i);
  unmount();
});

test('hotkey: b opens Broadcast', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();
  await press(stdin, 'b');
  const frame = strip(lastFrame());
  assert.match(frame, /broadcast|targets|chips/i);
  unmount();
});

test('hotkey: d opens Dashboard', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  await press(stdin, 'd');
  const frame = strip(lastFrame());
  // Dashboard shows a table; it has column headers (DBG, slot, status, etc.)
  assert.match(frame, /slot|status|fleet/i);
  unmount();
});

test('hotkey: q opens QuitConfirm (does NOT exit immediately)', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, 'q');
  const frame = strip(lastFrame());
  assert.match(frame, /Quit mc\?/);
  assert.match(frame, /\[s\] save & quit/);
  assert.match(frame, /\[d\] quit, no save/);
  unmount();
});

test('hotkey: n opens NewSession', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, 'n');
  const frame = strip(lastFrame());
  // NewSession has model selector / "Open repo" / "Browse"
  assert.match(frame, /new session|browse|model|repo/i);
  unmount();
});

test('hotkey: : enters command bar', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, ':');
  await press(stdin, 'h');
  const frame = strip(lastFrame());
  // Command bar renders the typed buffer in the status row
  assert.match(frame, /:h/);
  unmount();
});

test('hotkey: / enters filter mode', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();
  await press(stdin, '/');
  await press(stdin, 'r');
  const frame = strip(lastFrame());
  assert.match(frame, /\/r|FILTER/);
  unmount();
});

test('hotkey: esc closes Help modal', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, '?');
  await press(stdin, '\x1b');
  await tick(); await tick();
  const frame = strip(lastFrame());
  // After close we should NOT still see help's KEYBOARD header
  assert.doesNotMatch(frame, /━━ KEYBOARD ━━/);
  unmount();
});

test('hotkey: n in QuitConfirm cancels and keeps mc alive', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, 'q');
  await press(stdin, 'n');
  await tick();
  const frame = strip(lastFrame());
  assert.doesNotMatch(frame, /Quit mc\?/);
  // Status bar / hint should be visible again
  assert.match(frame, /NORMAL|press|new session|no sessions/i);
  unmount();
});

test('hotkey: slot jump 1 focuses slot 1', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  // Press 1 → focus moves to slot 1
  await press(stdin, '1');
  const frame = strip(lastFrame());
  // Status bar shows "[1] repo-1" when focused on slot 1
  assert.match(frame, /\[1\]\s*repo-1/);
  unmount();
});

test('hotkey: slot jump 3 focuses slot 3', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  await press(stdin, '3');
  const frame = strip(lastFrame());
  assert.match(frame, /\[3\]\s*repo-3/);
  unmount();
});

test('hotkey: → arrow advances focus across grid', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  await press(stdin, '1'); // focus slot 1
  await press(stdin, '\x1b[C'); // → advance
  const frame = strip(lastFrame());
  // Should now be on slot 2
  assert.match(frame, /\[2\]\s*repo-2/);
  unmount();
});

test('hotkey: ← arrow retreats focus across grid', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  await press(stdin, '3'); // focus slot 3
  await press(stdin, '\x1b[D'); // ← retreat
  const frame = strip(lastFrame());
  assert.match(frame, /\[2\]\s*repo-2/);
  unmount();
});

test('hotkey: vim-style l advances focus (when vimKeys enabled by default)', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  await press(stdin, '1');
  await press(stdin, 'l');
  const frame = strip(lastFrame());
  assert.match(frame, /\[2\]\s*repo-2/);
  unmount();
});
