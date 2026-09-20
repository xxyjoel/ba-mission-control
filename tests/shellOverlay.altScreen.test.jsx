// tests/shellOverlay.altScreen.test.jsx — PageUp/PageDown inside a full-screen
// child (less, man, vim, htop).
//
// 0413 bound PageUp/PageDown to the emulator's scrollback and returned
// unconditionally, so the key never reached keyToBytes. xterm's alternate
// buffer has no scrollback: scrollLines() is a no-op there and
// baseY - viewportY is identically 0, so inside a pager the key did nothing at
// all — measured with a spy on pty.write, the child received [] on both
// buffers where before 0413 it received CSI 5~ / CSI 6~. Nothing in the
// component looked at buffer.active.type.
//
// Harness copied from tests/shell/ShellOverlay.keys.test.jsx: stub pty through
// getShellSession({ spawn }), real component, real key bytes through Ink.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { _resetForTest, getShellSession } from '../server/shellSession.mjs';
import ShellOverlay from '../tui/modals/ShellOverlay.jsx';

const THEME = { accent: '#19D4D4', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59', bg: '#0b0d12', yellow: '#d7a65f' };

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const feed = (term, s) => new Promise((r) => term.write(s, r));

// DECSET / DECRST 1049 — the alternate-screen switch every pager emits.
const ALT_ON  = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

const label = (n) => 'L' + String(n).padStart(3, '0');
const lines = (from, to) => {
  let s = '';
  for (let i = from; i < to; i++) s += label(i) + '\r\n';
  return s;
};
// Ink writes SGR codes mid-row, so strip them before reading text back out.
const plain = (frame) => frame.replace(/\x1b\[[0-9;]*m/g, '');
const topRow = (frame) => {
  const m = plain(frame).split('\n').map((l) => l.match(/L(\d{3})/)).find(Boolean);
  return m ? Number(m[1]) : undefined;
};

function makeStubPty() {
  let _onData = null;
  const pty = {
    pid: 42002,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: (_cb) => ({ dispose: () => {} }),
    writeCalls: [],
    write: (bytes) => { pty.writeCalls.push(bytes); },
    resize: (_c, _r) => {},
    kill: () => {},
    emit: (chunk) => { if (_onData) _onData(chunk); },
  };
  return pty;
}

// width 100 keeps the footer on one row, so its wording can be read back.
function mount({ width = 100, height = 20 } = {}) {
  const pty = makeStubPty();
  const session = getShellSession({ spawn: () => pty });
  const r = render(React.createElement(ShellOverlay, {
    theme: THEME, width, height, onClose: () => {},
  }));
  return { pty, term: session.term, ...r };
}

describe('ShellOverlay on the alternate screen', () => {
  beforeEach(() => { _resetForTest(); });

  it('forwards PageUp and PageDown to the child so the pager pages', async () => {
    const { pty, term, stdin } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await feed(term, ALT_ON);
    await tick();
    assert.equal(term.buffer.active.type, 'alternate', 'the child is on the alternate buffer');

    const before = pty.writeCalls.length;
    stdin.write('\x1b[5~');
    await tick();
    stdin.write('\x1b[6~');
    await tick();

    assert.deepEqual(pty.writeCalls.slice(before), ['\x1b[5~', '\x1b[6~'],
      'a buffer with no scrollback is not ours to scroll — the key belongs to the child');
  });

  it('never claims to have scrolled a buffer with no scrollback', async () => {
    const { term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await feed(term, ALT_ON);
    await tick();

    stdin.write('\x1b[5~');
    await tick();

    const b = term.buffer.active;
    assert.equal(b.baseY - b.viewportY, 0, 'the alternate buffer cannot move');
    assert.ok(!lastFrame().includes('back · type to return'),
      'so no "back" indicator may appear');
  });

  it('the footer says where PgUp/PgDn goes on each buffer', async () => {
    const { term, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await tick();
    const live = plain(lastFrame());
    assert.match(live, /PgUp\/PgDn scroll history/,
      `the normal buffer scrolls here; footer read ${JSON.stringify(live)}`);

    await feed(term, ALT_ON);
    await tick();
    const alt = plain(lastFrame());
    assert.doesNotMatch(alt, /PgUp\/PgDn scroll history/,
      'the footer must not still advertise a scroll that cannot happen');
    assert.match(alt, /PgUp\/PgDn → app/,
      `the footer must say the key goes to the child; footer read ${JSON.stringify(alt)}`);
  });

  it('a keystroke on the alternate buffer leaves the normal scroll position alone', async () => {
    const { pty, term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await tick();
    const liveTop = topRow(lastFrame());

    stdin.write('\x1b[5~');          // scroll the NORMAL buffer back one page
    await tick();
    const parkedTop = topRow(lastFrame());
    assert.ok(parkedTop < liveTop, 'parked in history on the normal buffer');

    await feed(term, ALT_ON);
    await tick();
    const before = pty.writeCalls.length;
    stdin.write('x');                // typing inside the pager
    await tick();
    assert.deepEqual(pty.writeCalls.slice(before), ['x'], 'the keystroke reaches the child');

    await feed(term, ALT_OFF);
    await tick();

    const back = plain(lastFrame());
    assert.equal(topRow(lastFrame()), parkedTop,
      'the normal buffer holds its position across the alternate-screen round trip');
    assert.match(back, /back · type to return/,
      `so the indicator must survive it too; footer read ${JSON.stringify(back)}`);
  });
});
