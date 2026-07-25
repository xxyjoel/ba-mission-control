// tests/shell/ShellOverlay.render.test.jsx — paired test for task 0315.
//
// Acceptance criteria:
//   1. ShellOverlay mounts, attaches to getShellSession(), renders the term buffer.
//   2. Unmounting does NOT kill the pty (singleton survives).
//
// Strategy: pre-seed the singleton via _resetForTest() + getShellSession({ spawn })
// with a stub pty. ShellOverlay calls bare getShellSession() and gets the cached
// stub. We then assert term text renders and that the stub pty.kill is not called
// on unmount.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { _resetForTest, getShellSession } from '../../server/shellSession.mjs';
import ShellOverlay from '../../tui/modals/ShellOverlay.jsx';

// Minimal theme (subset used by ShellOverlay chrome)
const THEME = { accent: '#19D4D4', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59', bg: '#0b0d12' };

// Synchronous tick — lets React flush renders.
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── Stub PTY ────────────────────────────────────────────────────────────────

function makeStubPty() {
  // Minimal node-pty-compatible stub: onData handler registry and kill spy.
  let _onData = null;
  const pty = {
    pid: 99999,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: (_cb) => { return { dispose: () => {} }; },
    write: (_s) => {},
    resize: (_c, _r) => {},
    kill: () => { pty._killed = true; },
    _killed: false,
    // Helper: push output bytes through as if the real PTY emitted them.
    emit: (chunk) => { if (_onData) _onData(chunk); },
  };
  return pty;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ShellOverlay', () => {
  beforeEach(() => {
    // Reset the singleton so each test starts with a fresh stub.
    _resetForTest();
  });

  it('mounts and renders the terminal body from the session term buffer', async () => {
    const stubPty = makeStubPty();
    // Pre-seed the singleton. The stub pty's onData callback will be wired
    // by getShellSession to pump bytes into the xterm Terminal.
    const session = getShellSession({ spawn: () => stubPty });
    assert.ok(session.pty === stubPty, 'singleton should use stub pty');
    assert.ok(session.term, 'term should be constructed');

    // Emit some text into the PTY so the term buffer has content to render.
    stubPty.emit('hello shell\r\n');
    await tick();

    const { lastFrame, unmount } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );

    await tick(50); // let scheduleRender fire

    // The component must render term buffer content via rowToRuns — not the
    // placeholder. "hello shell" was emitted above and must appear in the frame.
    // If view is null or rowToRuns never ran, the placeholder "(launching shell…)"
    // appears instead and the first assert below will fail loudly.
    const frame = lastFrame();
    assert.ok(typeof frame === 'string' && frame.length > 0, 'should render a non-empty frame');
    assert.ok(frame.includes('hello shell'),
      'term buffer content "hello shell" must appear in frame (proves rowToRuns rendered the buffer)');
    assert.ok(!frame.includes('launching shell'),
      'placeholder must NOT appear — buffer content should render via rowToRuns, not the fallback');
    assert.ok(frame.includes('⌃Q'), 'footer should include ⌃Q hint');

    unmount();
  });

  it('unmounting does NOT kill the pty (singleton survives keep-warm)', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    const { unmount } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick();

    unmount();
    await tick();

    assert.strictEqual(stubPty._killed, false,
      'pty.kill() must NOT be called when ShellOverlay unmounts (keep-warm lifecycle)');
  });
});
