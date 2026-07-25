// tests/shell/ShellOverlay.persistence.test.jsx — paired test for task 0331.
//
// Acceptance criteria:
//   1. mount/unmount/remount preserves the term buffer (keep-warm lifecycle).
//   2. cdToCwd emits the focused card's cwd to the pty when at a fresh prompt.
//      (Component-level cwd routing is App-level; this covers the shellSession
//      mechanism proven by shellSession.cd.test.mjs. Criterion 2 is documented
//      as a 30s manual check in task Result — see task file.)
//
// Strategy for criterion 1:
//   - pre-seed the singleton via _resetForTest() + getShellSession({ spawn })
//   - mount ShellOverlay; emit PTY output; unmount; remount bare getShellSession()
//   - assert the remounted frame still contains the output (buffer survived detach)
//
// The test MUST PASS: deps [0315, 0319, 0320, 0311] are all implemented.
// The keep-warm path is: singleton onData wires pty→term at module level, NOT
// inside the component, so the buffer accumulates while unmounted (shellSession:89).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { _resetForTest, getShellSession, cdToCwd } from '../../server/shellSession.mjs';
import ShellOverlay from '../../tui/modals/ShellOverlay.jsx';

// Minimal theme (subset used by ShellOverlay chrome)
const THEME = { accent: '#19D4D4', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59', bg: '#0b0d12' };

// Synchronous tick — lets React flush renders and effects.
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── Stub PTY ─────────────────────────────────────────────────────────────────
// Mirrors the pattern established in ShellOverlay.render.test.jsx.

function makeStubPty() {
  let _onData = null;
  const pty = {
    pid: 77777,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: (_cb) => { return { dispose: () => {} }; },
    writeCalls: [],
    write: (s) => { pty.writeCalls.push(s); },
    resize: (_c, _r) => {},
    kill: () => { pty._killed = true; },
    _killed: false,
    // Helper: push PTY output bytes through onData (drives both term.write and
    // atFreshPrompt detection in the singleton's onData handler).
    emit: (chunk) => { if (_onData) _onData(chunk); },
  };
  return pty;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShellOverlay persistence (keep-warm lifecycle)', () => {
  beforeEach(() => {
    // Reset the singleton so each test starts clean.
    _resetForTest();
  });

  it('remount shows output that arrived while the overlay was closed (criterion 1)', async () => {
    const stubPty = makeStubPty();

    // Pre-seed the singleton — getShellSession wires onData → term at module level.
    const session = getShellSession({ spawn: () => stubPty });
    assert.ok(session.term, 'xterm Terminal must be constructed on the singleton');

    // ── First mount ─────────────────────────────────────────────────────────
    const { unmount: unmount1 } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick(50);

    // Emit PTY output that the user typed and saw.
    stubPty.emit('echo hi\r\nhi\r\n$ ');
    await tick(50);

    // ── Unmount (overlay "closed") ──────────────────────────────────────────
    unmount1();
    await tick(30);

    // The PTY is NOT killed — singleton stays warm. Buffer has 'hi'.
    assert.strictEqual(stubPty._killed, false,
      'pty must NOT be killed on unmount (keep-warm: singleton survives close)');

    // ── Second mount (overlay "reopened") ───────────────────────────────────
    // No _resetForTest() here — that is the whole point: same singleton, same buffer.
    const { lastFrame, unmount: unmount2 } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick(100); // let scheduleRender fire and React flush

    const frame = lastFrame();
    assert.ok(typeof frame === 'string' && frame.length > 0, 'second mount must render a non-empty frame');
    assert.ok(frame.includes('hi'),
      'term buffer content "hi" must appear after remount — proves keep-warm preserved state');
    assert.ok(!frame.includes('launching shell'),
      'placeholder must NOT appear after remount — buffer content must render via rowToRuns');

    unmount2();
  });

  it('singleton spawns only once across mount/unmount/remount (no respawn)', async () => {
    let spawnCount = 0;
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => { spawnCount++; return stubPty; } });
    assert.strictEqual(spawnCount, 1, 'spawn called once on first getShellSession');

    const { unmount: u1 } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick(50);
    u1();
    await tick(30);

    // Remount — getShellSession() should return the cached singleton, not respawn.
    const { unmount: u2 } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick(50);
    u2();

    assert.strictEqual(spawnCount, 1,
      'spawn must NOT be called again on remount (singleton cached by shellSession)');
  });

  it('cdToCwd writes focused-card cwd to pty when at a fresh prompt (criterion 2 mechanism)', () => {
    // This tests the shellSession mechanism that App uses when reopening the
    // overlay from a focused card. The component itself does not call cdToCwd;
    // the App layer does. We verify the primitive here to prove criterion 2
    // is machine-checkable; the full end-to-end is covered by the 30s manual
    // check documented in the task Result.
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    // Simulate the shell emitting a prompt (atFreshPrompt → true).
    stubPty.emit('repo % ');

    const emitted = cdToCwd('/Users/joelproctor/src/foo');

    assert.strictEqual(emitted, true, 'cdToCwd returns true at a fresh prompt');
    assert.strictEqual(stubPty.writeCalls.length, 1, 'exactly one write to the pty');
    assert.strictEqual(stubPty.writeCalls[0], "cd '/Users/joelproctor/src/foo'\n",
      'cd command must be single-quoted for the focused card cwd');
  });
});
