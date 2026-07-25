// tests/app/shellHotkey.test.jsx — pins the `!` → modal='shell' keybinding
// (task 0316). The ShellOverlay render block lands in 0319, so we assert
// behaviorally: once `!` is pressed a modal state is active (subsequent `?`
// does NOT open Help), then check no existing binding regresses.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../../tui/App.jsx';

const tick = () => new Promise((r) => setTimeout(r, 30));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

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
  broadcast() { return 0; }
  setSlotCostCap() { return true; }
}

function mount(opts = {}) {
  const fleet = new FakeFleet(opts.liveSlots ?? []);
  return render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
}

const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// Control: without `!`, pressing `?` opens Help.
test('control: ? opens Help without prior ! press', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, '?');
  const frame = strip(lastFrame());
  assert.match(frame, /KEYBOARD|NAVIGATION|SESSIONS/);
  unmount();
});

// Main acceptance: pressing `!` enters a modal state. Because 0319 has not
// yet rendered the shell modal frame, we verify the modal is active by
// confirming that a subsequent `?` does NOT open Help (the modal state
// blocks normal-mode hotkeys via `if (modal) return`).
test('hotkey: ! activates shell modal state (blocks subsequent normal-mode keys)', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();
  await press(stdin, '!');
  // Now press `?` — if modal='shell' is set, `if (modal) return` fires first
  // and Help should NOT open. If ! were unbound, modal stays null and ? would open Help.
  await press(stdin, '?');
  const frame = strip(lastFrame());
  // Help must NOT be visible — it would show KEYBOARD if open.
  assert.doesNotMatch(frame, /━━ KEYBOARD ━━|NAVIGATION/);
  unmount();
});

// `!` from FleetView (no live slots) still sets modal.
test('hotkey: ! from FleetView (no live sessions) activates shell modal', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [] });
  await tick(); await tick();
  await press(stdin, '!');
  await press(stdin, '?');
  const frame = strip(lastFrame());
  assert.doesNotMatch(frame, /━━ KEYBOARD ━━|NAVIGATION/);
  unmount();
});

// `!` from a focused card (slot 1 live) still sets modal.
test('hotkey: ! from focused card activates shell modal', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();
  await press(stdin, '1');  // focus slot 1
  await press(stdin, '!');
  await press(stdin, '?');
  const frame = strip(lastFrame());
  assert.doesNotMatch(frame, /━━ KEYBOARD ━━|NAVIGATION/);
  unmount();
});

// Regression: existing bindings must not collide with `!`.
// `!` is the shifted form of `1` on standard US keyboards — verify `1`
// (slot jump) still works normally (does NOT open a modal).
test('regression: digit 1 still jumps to slot 1 (no collision with !)', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2, 3] });
  await tick(); await tick();
  await press(stdin, '3');  // focus slot 3 first
  await press(stdin, '1');  // jump back to slot 1
  const frame = strip(lastFrame());
  // Status bar shows [1] repo-1 when focused on slot 1
  assert.match(frame, /\[1\]\s*repo-1/);
  unmount();
});

// `b` (Broadcast) still works.
test('regression: b still opens Broadcast', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();
  await press(stdin, 'b');
  const frame = strip(lastFrame());
  assert.match(frame, /broadcast|targets|chips/i);
  unmount();
});
