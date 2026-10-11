// tests/ptyCore.stuckClock.test.mjs — 0450: which PtyCore subclasses count
// PTY bytes as events on the STUCK clock (lastEventTs).
//
// Claude (PtyAgent) does not: its spinner repaints while wedged. Cursor keeps
// the old any-byte clock: it has no hooks and writes no tool_result line, so
// its screen output is the only liveness it shows during a long tool.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorAgent } from '../server/providers/cursor/cursorAgent.mjs';
import { PtyAgent } from '../server/ptyAgent.mjs';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 5300 + spawned.length, _writes: [], _kills: [],
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize() {},
      onData(fn) { handlers.data.push(fn); return { dispose() {} }; },
      onExit(fn) { handlers.exit.push(fn); return { dispose() {} }; },
      fireData(s) { for (const fn of handlers.data) fn(s); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

test('Cursor: PTY bytes still bump lastEventTs, so a long tool does not read STUCK (0450)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: T0 });
  const spawn = makeFakeSpawn();
  const a = new CursorAgent({
    slot: 2, id: 's2-cursor', cwd: '/tmp/fake-cursor-cwd', model: 'cursor:composer-2.5',
    permissionMode: 'default', sessionId: '11111111-2222-3333-4444-555555555555',
    spawn, mintChat: async () => 'minted-should-not-run',
  });
  t.after(() => { try { a.kill(); } catch {} });
  a.start();
  a.status = 'working';
  a.lastEventTs = T0 - 30 * MIN;
  assert.ok(a.toJSON().stuckMin >= 5, 'precondition: a silent working cursor slot reads STUCK');
  spawn.spawned[0].fireData('tool output\r\n');
  assert.equal(a.lastEventTs, T0, 'cursor screen output is its liveness signal');
  assert.equal(a.toJSON().stuckMin, 0);
});

test('Claude: PTY bytes do not bump lastEventTs (0450)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: T0 });
  const spawn = makeFakeSpawn();
  const a = new PtyAgent({ slot: 3, cwd: '/tmp/fake-claude-cwd', spawn });
  t.after(() => { try { a.kill(); } catch {} });
  a.start();
  a.lastEventTs = T0 - 30 * MIN;
  spawn.spawned[0].fireData('\x1b[2K✻ Thinking…');
  assert.equal(a.lastEventTs, T0 - 30 * MIN);
  assert.equal(a.lastPtyTs, T0);
});
