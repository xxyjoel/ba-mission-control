// tests/App.sigcontRedraw.test.jsx — review of 0464, findings 1 and 2.
//
// Finding 2: main.jsx renders with incrementalRendering, which rewrites only
// the lines that changed. After `kill -STOP` / `kill -CONT` main.jsx re-enters
// the alternate screen, which comes back blank; an idle fleet then makes no
// React commit for up to a minute, so nothing repainted it. App now forces
// Ink's full redraw on SIGCONT.
//
// Finding 1: at boot an idle `now` is floored to the minute and can be earlier
// than Fleet.sessionStart, so the header session timer showed "-1:-1".
//
// This renders through Ink's REAL interactive path (TTY stdout, incremental
// rendering, throttled), not ink-testing-library's debug mode, which writes
// every frame in full and so cannot show either defect.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { render } from 'ink';

import App from '../tui/App.jsx';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[78]/g, '');

class TtyOut extends EventEmitter {
  isTTY = true;
  columns = 160;
  rows = 50;
  chunks = [];
  write(d, cb) { this.chunks.push(String(d)); if (typeof cb === 'function') cb(); return true; }
}
class TtyIn extends EventEmitter {
  isTTY = true;
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read() { return null; }
}

class IdleFleet extends EventEmitter {
  constructor() {
    super();
    // sessionStart = now, as Fleet sets it just before main.jsx renders.
    this._snap = { sessionStart: Date.now(), slots: 10, background: null, agents: [] };
    for (let i = 1; i <= 10; i++) {
      this._snap.agents.push(i === 1 ? {
        id: 's1-fake', slot: 1, status: 'idle', name: 'repo-one', provider: 'claude',
        model: 'claude-sonnet-4-6', branch: 'main', cwd: '/tmp',
        context: 1000, tokensIn: 100, tokensOut: 50, costSession: 0.01,
        spark: [0.5, 0.5, 0.5], activity: '', tail: [{ kind: 'text', text: 'done' }],
        permissionMode: 'default', sessionId: '00000001-0000-4000-8000-000000000000',
        stuckMin: 0, lastTokRate: 0, otherSessions: 0,
      } : { id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
    }
  }
  snapshot() { return { ...structuredClone(this._snap), now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find((a) => a.id === id) || null; }
  setViewport() { return 0; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
}

test('0464 review: idle boot header has no negative session timer; SIGCONT forces a full redraw', async () => {
  const stdout = new TtyOut();
  const inst = render(
    <App fleet={new IdleFleet()} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />,
    { stdout, stderr: new TtyOut(), stdin: new TtyIn(), interactive: true,
      incrementalRendering: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    // Past boot effects and the boot toast's expiry.
    await wait(5000);
    const boot = strip(stdout.chunks.join(''));
    assert.ok(boot.includes('repo-one'), 'the fleet view never painted');
    assert.ok(!/-1:-1/.test(boot), 'the header session timer showed a negative duration');

    // Idle and settled: nothing more is written.
    stdout.chunks.length = 0;
    await wait(1000);
    assert.equal(stdout.chunks.join(''), '', 'an idle, settled fleet still wrote to the terminal');

    process.emit('SIGCONT');
    await wait(300);
    const after = strip(stdout.chunks.join(''));
    // A full frame rewrites lines that did not change, the card's name among them.
    assert.ok(after.includes('repo-one'),
      `SIGCONT did not repaint the unchanged frame (${after.length} printable bytes written)`);
  } finally {
    inst.unmount();
  }
});
