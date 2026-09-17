// tests/fleet.viewport.test.mjs — 0404. Fleet.setViewport is the ONLY thing
// that resizes a live claude.
//
// Why it has to be the only one: claude reprints its whole frame on SIGWINCH
// and the pre-resize copy stays in the emulator's scrollback, so each resize
// leaves an extra, differently-wrapped copy of the conversation behind. The
// terminal's own size change is the one moment a repaint is expected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../server/fleet.mjs';

function fakeAgent() {
  return {
    cols: 80,
    rows: 24,
    resizes: [],
    resize(c, r) {
      if (c === this.cols && r === this.rows) return false;
      this.cols = c; this.rows = r;
      this.resizes.push([c, r]);
      return true;
    },
  };
}

function bareFleet(opts) {
  const f = new Fleet(opts);
  // Nothing here needs the shared tailer/proc timers.
  try { f.stop?.(); } catch {}
  return f;
}

test('Fleet: a boot viewport is stored and handed to new agents', () => {
  const f = bareFleet({ slots: 3, viewport: { cols: 214, rows: 36 } });
  assert.deepEqual(f.viewport, { cols: 214, rows: 36 });
});

test('Fleet.setViewport resizes every live agent exactly once', () => {
  const f = bareFleet({ slots: 3 });
  const a = fakeAgent(), b = fakeAgent();
  f.agents[0] = a;
  f.agents[2] = b;
  assert.equal(f.setViewport({ cols: 214, rows: 36 }), 2);
  assert.deepEqual(a.resizes, [[214, 36]]);
  assert.deepEqual(b.resizes, [[214, 36]]);
});

test('Fleet.setViewport is a no-op when the geometry has not changed', () => {
  const f = bareFleet({ slots: 2 });
  const a = fakeAgent();
  f.agents[0] = a;
  f.setViewport({ cols: 214, rows: 36 });
  assert.equal(f.setViewport({ cols: 214, rows: 36 }), 0, 'repeat must not touch the PTY');
  assert.deepEqual(a.resizes, [[214, 36]]);
  // A real change still lands.
  assert.equal(f.setViewport({ cols: 180, rows: 30 }), 1);
  assert.deepEqual(a.resizes, [[214, 36], [180, 30]]);
});

test('Fleet.setViewport ignores garbage dimensions rather than shrinking the fleet', () => {
  const f = bareFleet({ slots: 2, viewport: { cols: 214, rows: 36 } });
  const a = fakeAgent();
  f.agents[0] = a;
  for (const bad of [{}, { cols: 0, rows: 0 }, { cols: -5, rows: 40 }, { cols: 200 }, { rows: 40 }]) {
    assert.equal(f.setViewport(bad), 0, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(f.viewport, { cols: 214, rows: 36 });
  assert.deepEqual(a.resizes, []);
});

test('Fleet.setViewport survives an agent whose resize throws', () => {
  const f = bareFleet({ slots: 3 });
  const good = fakeAgent();
  f.agents[0] = { resize() { throw new Error('pty died'); } };
  f.agents[1] = good;
  f.agents[2] = { /* legacy agent with no resize at all */ };
  assert.equal(f.setViewport({ cols: 200, rows: 30 }), 1);
  assert.deepEqual(good.resizes, [[200, 30]]);
});
