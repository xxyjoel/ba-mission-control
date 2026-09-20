// tests/shellOverlay.scroll.test.jsx — the `!` shell overlay's scrollback,
// driven through the real component.
//
// The previous version of this file imported node:test, node:assert/strict and
// @xterm/headless and nothing else. It never imported ShellOverlay, never
// mounted it and never wrote a byte to stdin — it drove a bare emulator and
// asserted on that. Proven by mutation: every case stayed green with the
// component's scroll binding deleted, which is how the PageUp regression in
// 0413 shipped. These mount the real component and push real key bytes through
// Ink's parser, the path production uses. Harness copied from
// tests/shell/ShellOverlay.keys.test.jsx.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { _resetForTest, getShellSession } from '../server/shellSession.mjs';
import ShellOverlay from '../tui/modals/ShellOverlay.jsx';

const THEME = { accent: '#19D4D4', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59', bg: '#0b0d12', yellow: '#d7a65f' };

// Let React flush renders and the 33ms paint throttle settle.
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// xterm's write queue is async — an un-awaited write races the assertion.
const feed = (term, s) => new Promise((r) => term.write(s, r));

const label = (n) => 'L' + String(n).padStart(3, '0');
const lines = (from, to) => {
  let s = '';
  for (let i = from; i < to; i++) s += label(i) + '\r\n';
  return s;
};

// Ink writes SGR codes mid-row: on the cursor row 'L188' arrives as L, a colour
// reset, then 188. Strip them before reading any text back out of a frame.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ShellOverlay paints the cursor as a hard background run in the theme accent
// (cursorStyle). The border carries the SAME rgb as a FOREGROUND, so match on
// the 48;2 (background) introducer or every border row is a false positive.
const CURSOR_BG = '\x1b[48;2;25;212;212m';
const cursorRow = (frame) => {
  const row = frame.split('\n').find((l) => l.includes(CURSOR_BG));
  return row === undefined ? undefined : plain(row);
};

// The frame is chrome plus the terminal rows; read the Lnnn labels back out.
const bodyRows = (frame) =>
  plain(frame).split('\n').map((l) => l.match(/L(\d{3})/)).filter(Boolean).map((m) => Number(m[1]));
const topRow = (frame) => bodyRows(frame)[0];

function makeStubPty() {
  let _onData = null;
  const pty = {
    pid: 42001,
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

// width 60 / height 20 gives the overlay cols 54, rows 13 (the chrome subtracted
// at ShellOverlay:44-49), so a page is Math.floor(13 / 2) = 6 rows.
const PAGE = 6;

function mount({ width = 60, height = 20 } = {}) {
  const pty = makeStubPty();
  const session = getShellSession({ spawn: () => pty });
  const r = render(React.createElement(ShellOverlay, {
    theme: THEME, width, height, onClose: () => {},
  }));
  return { pty, term: session.term, ...r };
}

describe('ShellOverlay scrollback', () => {
  beforeEach(() => { _resetForTest(); });

  it('PageUp moves the window into history and sends nothing to the shell', async () => {
    const { pty, term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await tick();

    const live = lastFrame();
    assert.ok(live.includes(label(199)), 'starts on the live output');
    const before = pty.writeCalls.length;

    stdin.write('\x1b[5~');
    await tick();

    const scrolled = lastFrame();
    assert.equal(topRow(scrolled), topRow(live) - PAGE,
      `PageUp must move the window back one half-page: top was ${topRow(live)}, now ${topRow(scrolled)}`);
    assert.deepEqual(pty.writeCalls.slice(before), [],
      'on the normal buffer the emulator scrolls and the shell must not also see the key');
    assert.ok(scrolled.includes(`${PAGE} back`),
      `the footer must count the rows back; frame was ${JSON.stringify(scrolled)}`);
  });

  it('PageDown walks back toward the live output', async () => {
    const { term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await tick();
    const live = topRow(lastFrame());

    stdin.write('\x1b[5~');
    await tick();
    assert.equal(topRow(lastFrame()), live - PAGE);

    stdin.write('\x1b[6~');
    await tick();
    assert.equal(topRow(lastFrame()), live, 'PageDown returned to the live output');
    assert.ok(!lastFrame().includes('back · type to return'), 'and the indicator cleared');
  });

  it('typing snaps back to the live output and reaches the shell', async () => {
    const { pty, term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    await tick();
    const live = topRow(lastFrame());

    stdin.write('\x1b[5~');
    await tick();
    assert.equal(topRow(lastFrame()), live - PAGE);

    const before = pty.writeCalls.length;
    stdin.write('a');
    await tick();

    assert.equal(topRow(lastFrame()), live, 'a keystroke returns the reader to the live output');
    assert.deepEqual(pty.writeCalls.slice(before), ['a'], 'and still reaches the shell');
  });

  it('the cursor stays on its own buffer row when scrolled back', async () => {
    const { term, stdin, lastFrame } = mount();
    await tick();
    await feed(term, lines(0, 200));
    // Park the cursor on the first row of the live viewport, so it is still
    // inside the window after a half-page scroll and its row can be named.
    await feed(term, '\x1b[H');
    await tick();

    const live = lastFrame();
    const liveTop = topRow(live);
    assert.ok(cursorRow(live)?.includes(label(liveTop)),
      `the cursor paints on its own row when live; got ${JSON.stringify(cursorRow(live))}`);

    stdin.write('\x1b[5~');
    await tick();

    const scrolled = lastFrame();
    assert.ok(cursorRow(scrolled)?.includes(label(liveTop)),
      `the cursor must follow its buffer row, not the window index: expected it on ${label(liveTop)}, ` +
      `got ${JSON.stringify(cursorRow(scrolled))}`);
    assert.ok(!cursorRow(scrolled)?.includes(label(topRow(scrolled))),
      `the cursor must not be painted on the new top row ${label(topRow(scrolled))}`);
  });

  it('a cursor scrolled out of the window is not painted at all', async () => {
    const { term, stdin, lastFrame } = mount();
    await tick();
    // No cursor move: the cursor sits on the last row of the live viewport, so
    // a half-page scroll puts it below the window entirely.
    await feed(term, lines(0, 200));
    await tick();
    assert.ok(cursorRow(lastFrame()), 'the cursor is visible while live');

    stdin.write('\x1b[5~');
    await tick();

    assert.equal(cursorRow(lastFrame()), undefined,
      `nothing may be painted as the cursor once it is off the window; got ${JSON.stringify(cursorRow(lastFrame()))}`);
  });
});
