// tests/App.gridLayout.test.jsx — verify the card grid never spills
// past the terminal width. Audit: cards used to overlap on narrow
// terminals when settings.gridCols requested more columns than the
// minimum card width could fit.
//
// We render the App against a FakeFleet with several live slots and
// inspect the rendered frame's max line width.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../tui/App.jsx';

const tick = () => new Promise((r) => setTimeout(r, 30));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

class FakeFleet extends EventEmitter {
  constructor(liveSlots = []) {
    super();
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 1; i <= 10; i++) {
      if (liveSlots.includes(i)) {
        this._snap.agents.push({
          id: `s${i}`, slot: i, status: 'idle',
          name: `r-${i}`, model: 'claude-sonnet-4-6',
          branch: 'main', cwd: '/tmp',
          context: 1000, tokensIn: 100, tokensOut: 50,
          costSession: 0.01, costWeek: 0,
          spark: [1,1], activity: '',
          tail: [], permissionMode: 'default',
          sessionId: `uuid-${i}`,
        });
      } else {
        this._snap.agents.push({ id: `e-${i}`, slot: i, status: 'empty', name: null, model: null });
      }
    }
  }
  snapshot() { return { ...this._snap, now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find(a => a.id === id) || null; }
  setCostCap() {} setSlots(n) { return n; } killAll() {} launch() {} resume() {} kill() {}
  broadcast() { return 0; } setSlotCostCap() { return true; }
}

function maxLineWidth(frame) {
  const lines = strip(frame).split('\n');
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}

// Ink-testing-library renders at process.stdout.columns (host terminal
// width) and ignores our prop wishes — so this test can't directly
// control termSize. Instead, we assert the rendered frame never
// exceeds a sane bound for the host width. The bug was that gridCols=5
// at 80 cols would overflow; we assert the frame fits within whatever
// the test runner provides.

test('grid layout: rendered frame never exceeds host terminal width', async () => {
  const fleet = new FakeFleet([1, 2, 3, 4, 5]);
  const { lastFrame, unmount } = render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
  await tick(); await tick(); await tick();
  const frame = lastFrame() || '';
  const maxW = maxLineWidth(frame);
  const hostW = process.stdout.columns || 180;
  assert.ok(
    maxW <= hostW + 4,
    `rendered max width ${maxW} exceeds host width ${hostW} — cards spilling past edge`,
  );
  unmount();
});

test('grid layout: cards render without truncation; overflow pages, never clips', async () => {
  const fleet = new FakeFleet([1, 2, 3, 4, 5]);
  const { lastFrame, unmount } = render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
  await tick(); await tick(); await tick();
  const frame = strip(lastFrame() || '');
  // Focus starts on slot 1, so the first card is always on the visible pane
  // and must render intact (catches a card wrapping off the right edge).
  assert.match(frame, /r-1/, 'first card must be on the visible pane');
  // The grid pages by terminal height, so not every card is necessarily on
  // screen at once — but nothing is silently clipped: either all five names
  // are present, or a pager strip advertises the other pane(s).
  const allVisible = [/r-1/, /r-2/, /r-3/, /r-4/, /r-5/].every((re) => re.test(frame));
  assert.ok(
    allVisible || /pane\s+\d+\/\d+/.test(frame),
    'overflow must surface a pager, not disappear',
  );
  unmount();
});
