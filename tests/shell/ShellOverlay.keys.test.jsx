// tests/shell/ShellOverlay.keys.test.jsx — paired test for task 0320.
//
// Acceptance criteria:
//   1. ShellOverlay's useInput routes every non-chrome key through keyToBytes
//      to the pty (forwarding acceptance).
//   2. Ctrl+Q (classifyShellKey === 'EXIT') calls onClose and is NOT written
//      to the pty (close-chord acceptance).
//
// Strategy: pre-seed the singleton via _resetForTest() + getShellSession({ spawn })
// with a stub pty that records write() calls. Use ink-testing-library stdin.write
// to inject raw byte sequences and assert pty.write is (or isn't) called.
//
// Note: useInput requires raw mode. ink-testing-library drives it via its own
// stdin mock, which bypasses the TTY raw-mode guard — this is the established
// pattern in this repo (see ShellOverlay.render.test.jsx, TextField.test.jsx).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { _resetForTest, getShellSession } from '../../server/shellSession.mjs';
import ShellOverlay from '../../tui/modals/ShellOverlay.jsx';

// Minimal theme (subset used by ShellOverlay chrome)
const THEME = { accent: '#19D4D4', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59', bg: '#0b0d12' };

// Synchronous tick — lets React flush renders and effects.
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── Stub PTY ─────────────────────────────────────────────────────────────────

function makeStubPty() {
  let _onData = null;
  const pty = {
    pid: 42000,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: (_cb) => { return { dispose: () => {} }; },
    // Record every write() call — primary observable for key-forwarding tests.
    writeCalls: [],
    write: (bytes) => { pty.writeCalls.push(bytes); },
    resize: (_c, _r) => {},
    kill: () => { pty._killed = true; },
    _killed: false,
    emit: (chunk) => { if (_onData) _onData(chunk); },
  };
  return pty;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShellOverlay key forwarding', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('forwards a plain letter keystroke to the pty via keyToBytes', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    let closed = false;
    const { stdin } = render(
      React.createElement(ShellOverlay, {
        theme: THEME, width: 80, height: 24, onClose: () => { closed = true; }
      })
    );
    await tick(50);

    const beforeCount = stubPty.writeCalls.length;

    // Write the letter 'a' — keyToBytes returns 'a' verbatim.
    stdin.write('a');
    await tick(30);

    const newCalls = stubPty.writeCalls.slice(beforeCount);
    assert.ok(newCalls.length > 0, 'pty.write() must be called for plain letter "a"');
    assert.ok(newCalls.some(b => b === 'a'), `pty.write must receive "a"; got: ${JSON.stringify(newCalls)}`);
    assert.strictEqual(closed, false, 'onClose must NOT be called for plain letter');
  });

  it('forwards Ctrl+K to the pty (readline kill-line must reach the shell)', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    const { stdin } = render(
      React.createElement(ShellOverlay, {
        theme: THEME, width: 80, height: 24, onClose: () => {}
      })
    );
    await tick(50);

    const beforeCount = stubPty.writeCalls.length;

    // Ctrl+K is the raw byte 0x0b.
    stdin.write('\x0b');
    await tick(30);

    const newCalls = stubPty.writeCalls.slice(beforeCount);
    assert.ok(newCalls.length > 0,
      'pty.write() must be called for Ctrl+K (readline kill-line must not be swallowed)');
    // keyToBytes encodes Ctrl+K as 0x0b (c=0x6b → 0x6b-0x60=0x0b).
    assert.ok(newCalls.some(b => b === '\x0b'),
      `Ctrl+K must be forwarded as 0x0b; got: ${JSON.stringify(newCalls)}`);
  });

  it('forwards Ctrl+U to the pty (readline kill-line-backward must reach the shell)', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    const { stdin } = render(
      React.createElement(ShellOverlay, {
        theme: THEME, width: 80, height: 24, onClose: () => {}
      })
    );
    await tick(50);

    const beforeCount = stubPty.writeCalls.length;

    // Ctrl+U is the raw byte 0x15.
    stdin.write('\x15');
    await tick(30);

    const newCalls = stubPty.writeCalls.slice(beforeCount);
    assert.ok(newCalls.length > 0,
      'pty.write() must be called for Ctrl+U (readline kill-line-backward must not be swallowed)');
    assert.ok(newCalls.some(b => b === '\x15'),
      `Ctrl+U must be forwarded as 0x15; got: ${JSON.stringify(newCalls)}`);
  });

  it('closes the overlay on Ctrl+Q and does NOT write to the pty', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    let closed = false;
    const { stdin } = render(
      React.createElement(ShellOverlay, {
        theme: THEME, width: 80, height: 24, onClose: () => { closed = true; }
      })
    );
    await tick(50);

    const beforeCount = stubPty.writeCalls.length;

    // Ctrl+Q is the raw byte 0x11.
    stdin.write('\x11');
    await tick(30);

    assert.strictEqual(closed, true, 'onClose() must be called on Ctrl+Q');

    const newCalls = stubPty.writeCalls.slice(beforeCount);
    assert.strictEqual(newCalls.length, 0,
      `Ctrl+Q must NOT be written to the pty; got: ${JSON.stringify(newCalls)}`);
  });
});
