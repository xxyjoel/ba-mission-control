// tests/app/shellHotkeyPrecedence.test.jsx — task 0330
// Pins the precedence rule: `!` in command-bar/filter mode types literally;
// `!` in normal mode opens the shell overlay.
//
// Written alongside 0323 (paired test for 0330).

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
  broadcast() { return { sent: 0, skipped: 0 }; }
  setSlotCostCap() { return true; }
}

function mount(opts = {}) {
  const fleet = new FakeFleet(opts.liveSlots ?? []);
  return render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
}

const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// ── Criterion #1: `!` in filter mode types literally into the buffer ──

test('filter mode: ! types literally into the buffer (does not open overlay)', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();

  // Enter filter mode by pressing `/`.
  await press(stdin, '/');
  // Now press `!` — must land in the cmdBuffer, not trigger shell overlay.
  await press(stdin, '!');

  const frame = strip(lastFrame());

  // The status bar renders `/` + cmdBuffer when in filter mode.
  // The buffer must contain `!`.
  assert.match(frame, /\/!/,
    'filter bar must show /! (typed literal) when ! pressed in filter mode');

  // The shell overlay has not opened: Help still reachable via ? means
  // modal is null. More direct: the main view still renders (no overlay chrome).
  // Since modal==='shell' in App.jsx currently falls through to the main grid
  // view (0319 not yet wired), we assert via a subsequent ? NOT opening help.
  // But we CAN check the filter bar is still visible (not replaced by overlay).
  assert.match(frame, /FILTER|↵ run · esc cancel/,
    'filter bar chrome must still be visible (not replaced by overlay)');

  unmount();
});

test('filter mode: ! in :command mode types literally (not overlay)', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();

  // Enter command mode by pressing `:`.
  await press(stdin, ':');
  await press(stdin, '!');

  const frame = strip(lastFrame());

  // Command-bar shows `:` prefix + buffer. The buffer must hold `!`.
  assert.match(frame, /:\s*!/,
    'command bar must show :! (typed literal) when ! pressed in command mode');

  unmount();
});

// ── Criterion #2: `!` in normal mode opens the shell overlay ──

test('normal mode: ! opens shell overlay (blocks subsequent ? from opening Help)', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();

  // Press `!` in normal mode (no cmdMode active, no modal).
  await press(stdin, '!');
  // If modal='shell' is set, `if (modal) return` fires before the ? handler.
  await press(stdin, '?');
  const frame = strip(lastFrame());

  // Help must NOT appear — it would show KEYBOARD if open.
  assert.doesNotMatch(frame, /━━ KEYBOARD ━━|NAVIGATION/,
    'Help must not open after ! — modal=shell must be blocking normal hotkeys');

  unmount();
});

test('normal mode with live sessions: ! still opens shell overlay', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();

  await press(stdin, '1');  // focus slot 1
  await press(stdin, '!');
  await press(stdin, '?');
  const frame = strip(lastFrame());

  assert.doesNotMatch(frame, /━━ KEYBOARD ━━|NAVIGATION/,
    'Help must not open — shell modal blocks hotkeys when focused on a live slot');

  unmount();
});

// ── Guard: filter mode itself does not open shell overlay ──

test('guard: entering filter mode (/) does not open shell overlay', async () => {
  const { stdin, lastFrame, unmount } = mount();
  await tick(); await tick();

  await press(stdin, '/');
  // After pressing /, pressing ? should NOT open Help (filter mode is active
  // and the cmdMode block fires first — returning before the ? handler).
  // This confirms filter mode is active, not that the overlay is.
  // Separately confirm the `!` issue: now type `!` and escape — overlay must NOT open.
  await press(stdin, '!');  // types into buffer
  await press(stdin, '\x1b');  // Escape — exits filter mode (NOT the overlay close path)
  await tick();
  // After Esc from filter mode, we're back in normal mode with no modal.
  // Pressing ? now should open Help (modal is null again).
  await press(stdin, '?');
  const frame = strip(lastFrame());

  assert.match(frame, /KEYBOARD|NAVIGATION|SESSIONS/,
    'after Esc from filter mode, ? should open Help (no overlay was set)');

  unmount();
});
