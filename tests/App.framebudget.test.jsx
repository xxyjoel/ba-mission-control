// tests/App.framebudget.test.jsx — the fleet view must NEVER render more rows
// than the terminal has.
//
// When it does, Ink cannot erase its previous frame, so the terminal scrolls:
// the whole UI shifts, card borders tear, and the layout looks like it is
// jumping around. Reported as "the screen bops around all over the place, is
// pushed downward and breaks all formatting edges" while dictating.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../tui/App.jsx';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

class FakeFleet extends EventEmitter {
  constructor(liveSlots = []) {
    super();
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 1; i <= 10; i++) {
      this._snap.agents.push(liveSlots.includes(i) ? {
        id: `s${i}-fake`, slot: i, status: 'idle', name: `repo-${i}`,
        model: 'claude-sonnet-4-6', branch: 'main', cwd: '/tmp',
        context: 1000, tokensIn: 100, tokensOut: 50, costSession: 0.01,
        spark: [1, 1, 1], activity: '', tail: [], permissionMode: 'default',
        sessionId: `uuid-${i}`,
      } : { id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
    }
  }
  snapshot() { return { ...this._snap, now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find(a => a.id === id) || null; }
  setViewport() { return 0; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
  launch() {}
  resume() {}
  kill() {}
  broadcast() { return 0; }
  setSlotCostCap() { return true; }
}

// Every unknown command pushes one warn toast. pushToast keeps the last 3 plus
// the new one, so four of these fills the strip to its maximum.
async function pushToasts(stdin, n) {
  for (let i = 0; i < n; i++) {
    stdin.write(':');
    await tick();
    stdin.write(`nosuchverb${i}`);
    await tick();
    stdin.write('\r');
    await tick();
  }
}

// ink-testing-library reports no rows, so App falls back to its 50-row
// default — that is the budget the frame must respect.
const TERM_ROWS = 50;

test('fleet view: frame fits the terminal with no toasts', async () => {
  const { lastFrame, unmount } = render(<App fleet={new FakeFleet([1, 2, 3])} auth={{ ok: true }} />);
  await tick(); await tick();
  const rows = strip(lastFrame()).split('\n').length;
  assert.ok(rows <= TERM_ROWS, `frame is ${rows} rows, terminal is ${TERM_ROWS}`);
  unmount();
});

test('fleet view: a full feedback strip must not push the frame past the terminal', async () => {
  const { stdin, lastFrame, unmount } = render(<App fleet={new FakeFleet([1, 2, 3])} auth={{ ok: true }} />);
  await tick(); await tick();
  const before = strip(lastFrame()).split('\n').length;
  await pushToasts(stdin, 4);
  const after = strip(lastFrame()).split('\n').length;
  assert.ok(
    after <= TERM_ROWS,
    `4 toasts grew the frame to ${after} rows for a ${TERM_ROWS}-row terminal `
    + `(was ${before}) — Ink cannot erase this, so the terminal scrolls and the UI tears`,
  );
  unmount();
});

test('fleet view: the frame height does not change as toasts arrive', async () => {
  const { stdin, lastFrame, unmount } = render(<App fleet={new FakeFleet([1, 2])} auth={{ ok: true }} />);
  await tick(); await tick();
  const before = strip(lastFrame()).split('\n').length;
  await pushToasts(stdin, 4);
  const after = strip(lastFrame()).split('\n').length;
  assert.equal(after, before, 'a stable frame height is what stops the view jumping');
  unmount();
});
