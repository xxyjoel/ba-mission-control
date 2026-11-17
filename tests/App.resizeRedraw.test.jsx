// tests/App.resizeRedraw.test.jsx — 0478. A terminal resize left rows of the
// old frame on screen: a second status bar row, card edges at the top, the
// summary row missing (screen recording 2026-11-04).
//
// Ink draws each frame with cursor moves relative to the previous one, and
// with incrementalRendering it skips lines that did not change. The terminal
// has already trimmed or re-flowed the old frame when Ink runs, so the moves
// land on the wrong rows. App now wipes the screen and repaints in full once
// a resize settles.
//
// Renders through Ink's REAL interactive path into an @xterm/headless
// terminal that is resized alongside stdout, as a real terminal would be.
// ink-testing-library writes every frame in full and cannot show the defect.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import xtermPkg from '@xterm/headless';

import App from '../tui/App.jsx';
import { makeStubAgent } from './lib/zoom-stub.js';

const { Terminal } = xtermPkg.default || xtermPkg;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// mc's own wipe. Ink writes its clearTerminal ('\x1b[2J\x1b[3J\x1b[H') for
// frames taller than the screen; those are not counted.
const WIPE = '\x1b[2J\x1b[H';

class TtyOut extends EventEmitter {
  isTTY = true;
  clears = 0;
  constructor(term) { super(); this.term = term; this.columns = term.cols; this.rows = term.rows; }
  write(d, cb) {
    const s = String(d);
    if (s === WIPE) this.clears++;
    this.term.write(s);
    if (typeof cb === 'function') cb();
    return true;
  }
}
class TtyIn extends EventEmitter {
  isTTY = true;
  queue = [];
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read() { return this.queue.length ? this.queue.shift() : null; }
  type(s) { this.queue.push(s); this.emit('readable'); }
}

class IdleFleet extends EventEmitter {
  constructor() {
    super();
    this._snap = { sessionStart: Date.now(), slots: 10, background: null, agents: [] };
    for (let i = 1; i <= 10; i++) {
      this._snap.agents.push(i <= 4 ? {
        id: `s${i}-fake`, slot: i, status: 'idle', name: `repo-${i}`, provider: 'claude',
        model: 'claude-sonnet-4-6', branch: 'main', cwd: '/tmp',
        context: 1000, tokensIn: 100, tokensOut: 50, costSession: 0.01,
        spark: [0.5, 0.5, 0.5], activity: '', tail: [{ kind: 'text', text: 'done' }],
        permissionMode: 'default', sessionId: `0000000${i}-0000-4000-8000-000000000000`,
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

// convertEol stands in for the tty's ONLCR: node's raw mode keeps it on, so
// a real terminal sees "\r\n" where Ink writes "\n".
function makeTerminal() {
  const term = new Terminal({ cols: 170, rows: 77, allowProposedApi: true, scrollback: 0, convertEol: true });
  term.write('\x1b[?1049h'); // main.jsx's alternate screen
  return term;
}
const flush = (term) => new Promise((r) => term.write('', r));
async function screen(term) {
  await flush(term);
  const b = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  // The header clock may tick a minute while the test runs.
  rows[0] = rows[0].replace(/\d\d:\d\d/g, 'hh:mm');
  return rows;
}
function mount(fleet, term, stdin = new TtyIn()) {
  const stdout = new TtyOut(term);
  const inst = render(
    <App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />,
    { stdout, stderr: new EventEmitter(), stdin, interactive: true,
      incrementalRendering: true, exitOnCtrlC: false, patchConsole: false },
  );
  return { stdout, stdin, inst };
}

// The sizes from the recording, in two quick drags with a pause after each,
// ending back at the starting 170×77.
async function resizeLikeTheRecording(term, stdout) {
  const drags = [['81x39', '119x49', '96x58'], ['215x77', '254x77'], ['170x77']];
  for (const drag of drags) {
    for (const size of drag) {
      const [c, r] = size.split('x').map(Number);
      term.resize(c, r);
      stdout.columns = c; stdout.rows = r;
      stdout.emit('resize');
      await wait(40);
    }
    await wait(500);
  }
  await wait(300);
}

const diff = (a, b) => a.map((row, i) => (row === b[i] ? null : `row ${i}\n  before: ${b[i]}\n  after:  ${row}`)).filter(Boolean);

test('0478: after resizing away and back, the grid screen is the same as before', async () => {
  const term = makeTerminal();
  const { stdout, inst } = mount(new IdleFleet(), term);
  try {
    await wait(5000); // boot effects and the boot toast's expiry
    const before = await screen(term);
    assert.ok(before.some((r) => r.includes('repo-1')), 'the fleet view never painted');
    assert.equal(stdout.clears, 0, 'mc wiped the screen with no resize');

    await resizeLikeTheRecording(term, stdout);
    const after = await screen(term);

    assert.deepEqual(diff(after, before), [], 'rows of an old frame were left on screen');
    // One wipe per settled resize, not one per resize event of a drag.
    assert.equal(stdout.clears, 3);
  } finally {
    inst.unmount();
  }
});

test('0478: in zoom, the screen and the real cursor come back after a resize', async () => {
  const term = makeTerminal();
  const stub = makeStubAgent({ cols: 160, rows: 60 });
  for (let i = 0; i < 50; i++) stub.term.write(`transcript line ${i}\r\n`);
  // claude's composer with its cursor after "> what next".
  stub.term.write('────────────\r\n> what next\r\n────────────\r\n  ⏵⏵ auto mode on\x1b[2A\x1b[13G');
  const fleet = new IdleFleet();
  const slot1 = fleet._snap.agents[0];
  const { writeInput, attachZoomView } = stub.agent;
  Object.assign(stub.agent, slot1, { writeInput, attachZoomView });
  fleet.agentBySlot = (s) => (s === 1 ? stub.agent : fleet._snap.agents[s - 1]);
  fleet.agentById = (id) => (id === slot1.id ? stub.agent : fleet._snap.agents.find((a) => a.id === id) || null);

  const { stdout, stdin, inst } = mount(fleet, term);
  try {
    await wait(5000);
    stdin.type('\r'); // open zoom on the focused card
    await wait(800);
    const before = await screen(term);
    const cursorBefore = [term.buffer.active.cursorX, term.buffer.active.cursorY];
    assert.ok(before.some((r) => r.includes('> what next')), 'zoom never showed claude\'s screen');

    await resizeLikeTheRecording(term, stdout);
    const after = await screen(term);

    assert.deepEqual(diff(after, before), [], 'rows of an old frame were left on screen');
    // Dictation previews at the real cursor (0473): it must be back on claude's
    // input cell, not left at the bottom of the screen by the repaint.
    assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], cursorBefore);
  } finally {
    inst.unmount();
  }
});
