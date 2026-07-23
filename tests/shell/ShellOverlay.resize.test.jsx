// tests/shell/ShellOverlay.resize.test.jsx — paired test for task 0317.
//
// Acceptance criteria:
//   1. When cols/rows props change, ShellOverlay calls resizeShellSession(cols, rows)
//      which forwards the new dims to pty.resize and term.resize.
//   2. The pty is NOT respawned on resize (singleton survives).
//
// Strategy: pre-seed the singleton via _resetForTest() + getShellSession({ spawn })
// with a stub pty that records resize() calls. Re-render with new width/height props;
// assert pty.resize received the computed inner dims.
//
// Inner-dim formula (mirrors ShellOverlay.jsx):
//   cols = Math.max(20, Math.floor(width  || stdout?.columns || 80))
//   rows = Math.max(5,  Math.floor((height || stdout?.rows   || 24) - 6))

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
    pid: 11111,
    onData: (cb) => { _onData = cb; return { dispose: () => { _onData = null; } }; },
    onExit: (_cb) => { return { dispose: () => {} }; },
    write: (_s) => {},
    // Record resize(cols, rows) calls — primary observable for this test.
    resizeCalls: [],
    resize: (c, r) => { pty.resizeCalls.push([c, r]); },
    kill: () => { pty._killed = true; },
    _killed: false,
    emit: (chunk) => { if (_onData) _onData(chunk); },
  };
  return pty;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShellOverlay resize forwarding', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('calls resizeShellSession with computed inner dims when props change', async () => {
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => stubPty });

    // Initial render: width=100, height=30.
    // Inner dims: cols=max(20,100)=100, rows=max(5,30-6)=24.
    const { rerender } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 100, height: 30, onClose: () => {} })
    );
    await tick(50);

    // Capture the baseline — initial mount fires resize once with starting dims.
    const baselineCount = stubPty.resizeCalls.length;

    // Re-render with new size: width=120, height=40.
    // Inner dims: cols=max(20,120)=120, rows=max(5,40-6)=34.
    rerender(
      React.createElement(ShellOverlay, { theme: THEME, width: 120, height: 40, onClose: () => {} })
    );
    await tick(50);

    // At least one resize call should have arrived after the prop change.
    const newCalls = stubPty.resizeCalls.slice(baselineCount);
    assert.ok(
      newCalls.length > 0,
      'pty.resize must be called (via resizeShellSession) when width/height props change'
    );
    // The last call should match the new computed inner dims.
    const last = newCalls[newCalls.length - 1];
    assert.strictEqual(last[0], 120, 'cols forwarded to pty.resize should equal Math.max(20, width)');
    assert.strictEqual(last[1], 34,  'rows forwarded to pty.resize should equal Math.max(5, height - 6)');
  });

  it('does NOT respawn the pty when size changes (singleton survives)', async () => {
    let spawnCount = 0;
    const stubPty = makeStubPty();
    getShellSession({ spawn: () => { spawnCount++; return stubPty; } });
    assert.strictEqual(spawnCount, 1, 'pty spawned once on first getShellSession');

    const { rerender } = render(
      React.createElement(ShellOverlay, { theme: THEME, width: 80, height: 24, onClose: () => {} })
    );
    await tick(50);

    rerender(
      React.createElement(ShellOverlay, { theme: THEME, width: 100, height: 30, onClose: () => {} })
    );
    await tick(50);

    assert.strictEqual(spawnCount, 1,
      'pty must NOT be respawned when size props change (singleton survives)');
    assert.strictEqual(stubPty._killed, false,
      'pty must NOT be killed on resize');
  });
});
