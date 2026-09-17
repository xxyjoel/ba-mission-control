// tests/App.viewport.test.jsx — 0404. The fleet's PTY geometry follows the
// terminal, but only once the resize has settled.
//
// A window drag emits a stream of intermediate sizes. Applying each of them
// would resize all 10 sessions, and every resize costs claude a full frame
// reprint whose predecessor stays in the emulator's scrollback — the
// double-print bug, fleet-wide, once per drag step.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import App from '../tui/App.jsx';
import { zoomBodyDims } from '../tui/lib/zoomGeometry.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

class FakeFleet extends EventEmitter {
  constructor() {
    super();
    this.viewportCalls = [];
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 1; i <= 10; i++) {
      this._snap.agents.push({ id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
    }
  }
  snapshot() { return { ...this._snap, now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById() { return null; }
  setViewport(dims) { this.viewportCalls.push(dims); return 0; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
  launch() {}
  resume() {}
  kill() {}
  broadcast() { return 0; }
  setSlotCostCap() { return true; }
}

test('0404: App applies the boot geometry to the fleet', async () => {
  const fleet = new FakeFleet();
  const { unmount } = render(<App fleet={fleet} auth={{ ok: true }} />);
  await tick(400);
  assert.equal(fleet.viewportCalls.length, 1, 'exactly one apply on mount');
  const [dims] = fleet.viewportCalls;
  assert.ok(dims.cols >= 20 && dims.rows >= 6, `bad geometry ${JSON.stringify(dims)}`);
  unmount();
});

test('0404: the applied geometry is exactly zoomBodyDims of the terminal', async () => {
  const fleet = new FakeFleet();
  const { stdout, unmount } = render(<App fleet={fleet} auth={{ ok: true }} />);
  await tick(400);
  const expected = zoomBodyDims(stdout.columns || 180, stdout.rows || 50);
  assert.deepEqual(fleet.viewportCalls.at(-1), expected);
  unmount();
});
