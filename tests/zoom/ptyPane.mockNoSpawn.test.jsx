// tests/zoom/ptyPane.mockNoSpawn.test.jsx — 0444.
//
// The bug: MockAgent had no attachZoomView, so PtyPane fell back to
// startZoomSession (server/zoomSession.mjs), which spawns the real CLAUDE_BIN
// with --permission-mode acceptEdits. Mock mode promises no real claude.
//
// CLAUDE_BIN is pointed at a script that writes a marker file when run. The
// zoom must render the mock's replayed output and the marker must never
// appear. CLAUDE_BIN is read at module load, so it is set before the dynamic
// imports below.

import React from 'react';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { render } from 'ink-testing-library';

const dir = mkdtempSync(join(tmpdir(), 'mc-0444-'));
const marker = join(dir, 'spawned');
const bin = join(dir, 'fake-claude.sh');
writeFileSync(bin, `#!/bin/sh\necho "$@" > '${marker}'\nsleep 2\n`);
chmodSync(bin, 0o755);
process.env.CLAUDE_BIN = bin;

const { MockAgent } = await import('../../server/mockAgent.mjs');
const { default: PtyPane } = await import('../../tui/zoom/PtyPane.jsx');

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function renderPane(agent, onClose = () => {}) {
  return render(
    <PtyPane
      agent={agent}
      width={100}
      height={20}
      focus={true}
      onClose={onClose}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
  );
}

// Remove the marker dir only after EVERY test: a spawn in a later test must
// still have somewhere to write its marker.
after(() => rmSync(dir, { recursive: true, force: true }));

test('0444: zooming a MockAgent spawns no process and shows the replay', async () => {
  const agent = new MockAgent({
    slot: 1, name: 'mock', cwd: dir, branch: 'main', model: 'sonnet-4.6',
    fixture: 'quick-reply',
  });
  agent.start();
  await tick(1500);   // let the fixture replay its first turn

  let closed = false;
  const { lastFrame, unmount } = renderPane(agent, () => { closed = true; });
  await tick(1200);   // long enough for a spawned script to write its marker
  const frame = lastFrame() || '';
  unmount();
  agent.kill();

  assert.equal(existsSync(marker), false, 'CLAUDE_BIN was spawned by a mock zoom');
  assert.equal(closed, false, 'zoom must stay open');
  assert.match(frame, /the answer is 42/, `mock replay not rendered:\n${frame}`);
});

test('0444/0446: zoom typing reaches the mock through writeInput', async () => {
  const agent = new MockAgent({
    slot: 2, name: 'mock', cwd: dir, branch: 'main', model: 'sonnet-4.6',
    fixture: 'quick-reply',
  });
  agent.start();
  await tick(200);
  assert.equal(typeof agent.writeInput, 'function');
  const view = agent.attachZoomView({ cols: 80, rows: 24 });
  for (const ch of 'hix') agent.writeInput(ch);
  agent.writeInput('\x7f');                       // backspace drops the x
  agent.writeInput('\x1b[A');                     // an arrow key types nothing
  assert.equal(agent.writeInput('\r', { submit: true }), true);
  view.dispose();
  agent.kill();
  const users = agent.tail.filter((l) => l.kind === 'user').map((l) => l.text);
  assert.deepEqual(users, ['hi']);
  assert.equal(existsSync(marker), false);
});

test('0444: an agent without attachZoomView gets a message, not a spawned claude', async () => {
  const legacy = { id: 'legacy-1', slot: 3, sessionId: 'abc', cwd: dir, model: 'sonnet-4.6' };
  let closed = false;
  const { lastFrame, unmount } = renderPane(legacy, () => { closed = true; });
  await tick(800);
  const frame = lastFrame() || '';
  unmount();
  assert.equal(existsSync(marker), false, 'CLAUDE_BIN was spawned for an agent with no zoom view');
  assert.match(frame, /PTY failed: zoom is not supported/, frame);
  assert.equal(closed, false);
});

// ── review fixes: the mock's prompt behaves like claude's ─────────────

function screen(view) {
  const b = view.term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const s = b.getLine(i).translateToString(true);
    if (s) out.push(s);
  }
  return out;
}
function mock(slot) {
  return new MockAgent({
    slot, name: 'mock', cwd: dir, branch: 'main', model: 'sonnet-4.6', fixture: 'quick-reply',
  });
}
const users = (a) => a.tail.filter((l) => l.kind === 'user').map((l) => l.text);

test('0444: a bare \\n (the NEWLINE key) adds a line and does not submit', async () => {
  const agent = mock(4);
  agent.attachZoomView({ cols: 80, rows: 24 });
  agent.writeInput('one');
  agent.writeInput('\n');
  agent.writeInput('two');
  assert.deepEqual(users(agent), [], 'a newline must not submit');
  agent.writeInput('\r', { submit: true });
  agent.kill();
  assert.deepEqual(users(agent), ['one\ntwo']);
});

test('0444: a multi-line bracketed paste is one message', async () => {
  const agent = mock(5);
  const view = agent.attachZoomView({ cols: 80, rows: 24 });
  await tick(30);
  assert.equal(view.term.modes.bracketedPasteMode, true, 'PtyPane wraps pastes only when the mode is on');
  agent.writeInput('\x1b[200~line one\r\nline two\rline three\x1b[201~', { paste: true });
  assert.deepEqual(users(agent), []);
  agent.writeInput('\r', { submit: true });
  agent.kill();
  assert.deepEqual(users(agent), ['line one\nline two\nline three']);
});

test('0444: replay output arriving mid-typing does not share a line with the input', async () => {
  const agent = mock(6);
  const view = agent.attachZoomView({ cols: 20, rows: 10 });
  agent.writeInput('hel');
  agent.addNote('replay line');
  agent.writeInput('x'.repeat(30));   // wraps onto a second row
  agent.addNote('another');
  await tick(30);
  assert.deepEqual(screen(view), ['# replay line', '# another', 'hel' + 'x'.repeat(17), 'x'.repeat(13)]);
  agent.writeInput('\x7f'.repeat(30) + 'lo\r', { submit: true });
  await tick(30);
  agent.kill();
  assert.deepEqual(screen(view), ['# replay line', '# another', '❯ hello']);
});

test('0444: Fleet.setViewport resizes the mock zoom view', async () => {
  const { Fleet } = await import('../../server/fleet.mjs');
  const f = new Fleet({ slots: 1 });
  try { f.stop?.(); } catch {}
  const agent = mock(7);
  const view = agent.attachZoomView({ cols: 80, rows: 24 });
  f.agents[0] = agent;
  assert.equal(f.setViewport({ cols: 120, rows: 30 }), 1);
  assert.equal(view.term.cols, 120);
  assert.equal(view.term.rows, 30);
  assert.equal(view.pty.pid, undefined, 'a stub pid of 0 would signal the process group');
  agent.kill();
});
