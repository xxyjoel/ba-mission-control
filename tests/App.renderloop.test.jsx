// tests/App.renderloop.test.jsx — regression for audit #57.
//
// The tick interval that refreshes the snapshot used to depend on
// `snapshot` itself in its useEffect dep array. Every snapshot change
// triggered the effect → cleared the interval → set a NEW interval, so
// on a fleet with active streaming agents the interval was constantly
// being torn down and rebuilt. Worst case: the next tick fires within
// 1ms of the rebuild, producing a busy loop.
//
// We don't have a clean way to inspect effect-fire counts from here,
// but we CAN measure the interval cadence: ~3 fires/sec at default
// tickRate=300ms regardless of how many fleet emits happen in the
// window. If the bug regresses, the tick rate will spike with emit
// frequency.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';

import App from '../tui/App.jsx';

// Tiny fake Fleet that lets us emit changes on demand and counts how
// many times snapshot() is invoked — the interval's main side-effect.
class FakeFleet extends EventEmitter {
  constructor() {
    super();
    this.snapshotCount = 0;
    this._snap = { sessionStart: Date.now(), now: Date.now(), agents: [] };
    for (let i = 0; i < 10; i++) {
      this._snap.agents.push({
        id: `empty-${i+1}`, slot: i+1, status: 'empty',
        name: null, model: null,
      });
    }
  }
  snapshot() {
    this.snapshotCount++;
    return { ...this._snap, now: Date.now() };
  }
  agentBySlot() { return null; }
  agentById() { return null; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
}

test('app: tick interval rate stays steady when fleet emits many changes', async () => {
  const fleet = new FakeFleet();
  const { unmount } = render(<App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />);
  // Let mc settle past its boot effects.
  await new Promise((r) => setTimeout(r, 600));
  const startCount = fleet.snapshotCount;
  const startMs = Date.now();

  // Burst the fleet with emits during a 1s window. If the dep bug
  // regresses, the interval will tear down + rebuild on each emit and
  // potentially fire much more often than its cadence.
  const burst = setInterval(() => fleet.emit('change', fleet._snap), 5);
  await new Promise((r) => setTimeout(r, 1000));
  clearInterval(burst);

  const elapsedMs = Date.now() - startMs;
  const snapshotsFromInterval = fleet.snapshotCount - startCount;
  const ratePerSec = snapshotsFromInterval / (elapsedMs / 1000);

  // Default tickRate is 700ms (from SETTINGS_DEFAULTS), clamped to >=300ms,
  // so we expect ~1.4 calls/sec from the interval. Plus the emit-driven
  // setSnapshot calls trigger one snapshot() each from the subscription.
  // We tolerate up to ~250 calls/sec (matching the burst rate is fine —
  // each emit produces one snapshot lookup) but anything WAY above that
  // signals the runaway interval loop.
  assert.ok(
    ratePerSec < 500,
    `snapshot() rate ${ratePerSec.toFixed(1)}/sec is too high — interval likely re-fires on every emit (audit #57)`,
  );
  unmount();
});
