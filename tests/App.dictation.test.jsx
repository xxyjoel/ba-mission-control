// tests/App.dictation.test.jsx — 0389. Dictation into the command / filter bar.
//
// The bar's input handler used to require `input.length === 1`, so it accepted
// keystrokes and silently DROPPED anything longer. Dictation and paste both
// arrive as one multi-character chunk, so a dictated phrase never appeared in
// the bar at all — the "dictated text is invisible" half of the report.
//
// Harness mirrors tests/App.hotkeys.test.jsx (FakeFleet, no claude children).

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../tui/App.jsx';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

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
  setViewport() { return 0; }
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

test('0389: a dictated phrase reaches the command bar (it used to vanish)', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  await press(stdin, ':');
  stdin.write('resume all sessions');           // one write, as dictation sends it
  await tick(); await tick();
  const frame = strip(lastFrame());
  assert.match(frame, /resume all sessions/, `phrase missing from the bar:\n${frame}`);
  unmount();
});

test('0389: a dictated phrase reaches the filter bar', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1, 2] });
  await tick(); await tick();
  await press(stdin, '/');
  stdin.write('mission control');
  await tick(); await tick();
  assert.match(strip(lastFrame()), /mission control/);
  unmount();
});

test('0389: dictated runs in one write append in order', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  await press(stdin, ':');
  // Two text runs separated by a DEL, exactly what a revision looks like.
  stdin.write('resume alx\x7fl');
  await tick(); await tick();
  assert.match(strip(lastFrame()), /resume all/);
  unmount();
});

test('0389: an embedded line break in the bar collapses to a space', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  await press(stdin, ':');
  stdin.write('two\rwords');
  await tick(); await tick();
  const frame = strip(lastFrame());
  assert.match(frame, /two words/, `expected a single-line bar, got:\n${frame}`);
  unmount();
});

test('single keystrokes into the bar still work', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  await press(stdin, ':');
  for (const ch of 'help') { stdin.write(ch); await tick(20); }
  await tick();
  assert.match(strip(lastFrame()), /help/);
  unmount();
});

test('0389: the status bar stays ONE row no matter how long the buffer gets', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  const rowsIdle = strip(lastFrame()).split('\n').length;
  await press(stdin, ':');
  const rowsCmd = strip(lastFrame()).split('\n').length;
  assert.equal(rowsCmd, rowsIdle, 'opening the bar must not change the frame height');
  // Far longer than the bar is wide — this used to wrap the bar onto two or
  // three rows and push the whole frame up past the terminal's height.
  stdin.write('resume every single saved session and then broadcast a very long message to all of them right now please');
  await tick(); await tick();
  const rowsLong = strip(lastFrame()).split('\n').length;
  assert.equal(
    rowsLong, rowsIdle,
    `a long dictated buffer grew the frame from ${rowsIdle} to ${rowsLong} rows`,
  );
  unmount();
});

test('0389: the nav hints yield the bar to the buffer while typing a command', async () => {
  const { stdin, lastFrame, unmount } = mount({ liveSlots: [1] });
  await tick(); await tick();
  // The nav hints truncate to fit the row now (they used to wrap it onto two),
  // so assert on their leading words, which survive at any usable width.
  assert.match(strip(lastFrame()), /move/, 'nav hints show when the bar is idle');
  await press(stdin, ':');
  stdin.write('resume all sessions');
  await tick(); await tick();
  const frame = strip(lastFrame());
  assert.match(frame, /resume all sessions/, 'the whole phrase is readable');
  assert.match(frame, /run · esc cancel/, 'the bar keeps its own hint');
  assert.doesNotMatch(frame, /↵ open/, 'the nav hints step aside while typing');
  unmount();
});
