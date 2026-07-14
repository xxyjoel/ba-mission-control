// tests/recipes/zoom-text-input.recipes.test.jsx — programmatic coverage
// for the zoom textbox bugs the user wants caught without manual testing.
//
// 14 of the 20 candidate bugs from the plan are checked here. The other
// 6 are out of scope: #6/#14/#16 (latency-class — need event-loop timing,
// not recipes), #M/N/P (need a real claude subprocess fixture — follow-up
// PR will add tests/lib/pty-fixtures/zoom-claude-stub.mjs).
//
// Layers:
//   ptyKeys.js     → tests A, C, D, E, F (pure unit tests on keyToBytes)
//   PtyPane.jsx    → tests B, G, H, I, J, O, Q (ink-testing-library +
//                    tests/lib/zoom-stub.js to inject a fake agent)
//   Zoom.jsx       → tests K, L (layout integration — frame inspection)

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { keyToBytes } from '../../tui/zoom/ptyKeys.js';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import Zoom from '../../tui/modals/Zoom.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';

// Mirror the minimal theme shape PtyPane/Zoom read from.
const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

// Render PtyPane against a stub agent. Returns the render handle plus
// the stub so tests can introspect writes / resizes.
function renderPane({ cols = 60, rows = 20, onClose = () => {}, onToggleTools = () => {}, onToggleStats = () => {} } = {}) {
  const stub = makeStubAgent({ cols, rows });
  const handle = render(
    <PtyPane
      agent={stub.agent}
      width={cols}
      height={rows}
      focus={true}
      onClose={onClose}
      onToggleTools={onToggleTools}
      onToggleStats={onToggleStats}
      onCyclePerm={() => {}}
      theme={THEME}
    />
  );
  return { ...handle, stub };
}

// ─── Recipe A — Enter sends 0x0d (\r) via keyToBytes ────────────────
test('zoom recipe A: Enter sends \\r', () => {
  assert.equal(keyToBytes('', { return: true }), '\r');
});

// ─── Recipe C — Backspace sends 0x7f via keyToBytes ─────────────────
test('zoom recipe C: Backspace sends 0x7f (DEL, not BS)', () => {
  assert.equal(keyToBytes('', { backspace: true }), '\x7f');
  assert.equal(keyToBytes('', { delete: true }), '\x7f');
});

// ─── Recipe D — Tab sends 0x09 (and Shift+Tab sends CSI Z) ──────────
test('zoom recipe D: Tab sends \\t, Shift+Tab sends CSI Z', () => {
  assert.equal(keyToBytes('', { tab: true }), '\t');
  assert.equal(keyToBytes('', { tab: true, shift: true }), '\x1b[Z');
});

// ─── Recipe E — Arrow keys send CSI A/B/C/D ─────────────────────────
test('zoom recipe E: arrow keys send CSI A/B/C/D', () => {
  assert.equal(keyToBytes('', { upArrow: true }),    '\x1b[A');
  assert.equal(keyToBytes('', { downArrow: true }),  '\x1b[B');
  assert.equal(keyToBytes('', { rightArrow: true }), '\x1b[C');
  assert.equal(keyToBytes('', { leftArrow: true }),  '\x1b[D');
});

// ─── Recipe F — Ctrl+C sends 0x03 ───────────────────────────────────
test('zoom recipe F: Ctrl+C sends \\x03', () => {
  assert.equal(keyToBytes('c', { ctrl: true }), '\x03');
  // also: Ctrl+D = 0x04, Ctrl+Z = 0x1a
  assert.equal(keyToBytes('d', { ctrl: true }), '\x04');
  assert.equal(keyToBytes('z', { ctrl: true }), '\x1a');
});

// ─── Recipe B — Ctrl+J inserts newline (does NOT submit) ────────────
// Alt+Enter (ESC+CR) is intentionally not bound because PtyPane's
// single-tap Esc-exits-zoom design intercepts the ESC byte before the
// CR arrives. Ctrl+J sends a clean LF byte that can't be confused.
test('zoom recipe B: Ctrl+J writes bracketed-paste-wrapped \\n when mode on', async () => {
  const { stdin, stub, unmount } = renderPane();
  await tick(60);
  // Enable bracketed paste mode through the real parser path so the
  // term tracks it (poking term.modes directly doesn't take).
  stub.term.write('\x1b[?2004h');
  await tick(40);
  // Ctrl+J = LF byte 0x0a.
  await press(stdin, '\x0a');
  const writes = stub.getWrites();
  assert.equal(writes.length, 1, 'exactly one write');
  assert.equal(writes[0], '\x1b[200~\n\x1b[201~',
    'Ctrl+J must be wrapped in bracketed paste with embedded LF');
  unmount();
});

test('zoom recipe B (fallback): Ctrl+J writes raw \\n when bracketed-paste mode off', async () => {
  const { stdin, stub, unmount } = renderPane();
  await tick(60);
  // Leave bracketed paste disabled — the brief window before claude's
  // prompt has drawn its mode-set sequence.
  await press(stdin, '\x0a');
  const writes = stub.getWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0], '\n');
  unmount();
});

// ─── Recipe G — Esc now FORWARDS to claude (cancel/back-out); the zoom
//     exit moved to Ctrl+Q. Esc was shadowing claude's own Esc, which is
//     why you couldn't back out of claude menus inside zoom. ────────────
test('zoom recipe G: Esc forwards \\x1b to claude and does NOT exit zoom', async () => {
  const closes = [];
  const { stdin, stub, unmount } = renderPane({ onClose: () => closes.push(1) });
  await tick(60);
  await press(stdin, '\x1b');
  await tick(120);
  assert.ok(stub.getWrites().some((w) => w.includes('\x1b')), 'Esc (\\x1b) forwarded to claude');
  assert.equal(closes.length, 0, 'Esc must NOT exit zoom — claude owns it');
  unmount();
});

test('zoom recipe G2: Ctrl+Q exits zoom and is NOT forwarded to claude', async () => {
  const closes = [];
  const { stdin, stub, unmount } = renderPane({ onClose: () => closes.push(1) });
  await tick(60);
  await press(stdin, '\x11'); // Ctrl+Q (0x11)
  await tick(120);
  assert.ok(closes.length >= 1, 'Ctrl+Q fired onClose');
  assert.ok(!stub.getWrites().some((w) => w.includes('\x11')), 'Ctrl+Q not forwarded to claude');
  unmount();
});

// ─── Recipe H — Bracketed paste wraps multi-char when mode is on ────
test('zoom recipe H: multi-char paste wrapped in CSI 200~/201~ when mode on', async () => {
  const { stdin, stub, unmount } = renderPane();
  await tick(60);
  // Enable bracketed paste mode via the real parser path.
  stub.term.write('\x1b[?2004h');
  await tick(40);
  // Multi-char single chunk (simulating a paste). Ink delivers a paste
  // as one input event because stdin chunks bytes together.
  stdin.write('hello world');
  await tick(60);
  const writes = stub.getWrites();
  // The paste-detection branch only triggers for input.length > 1, and
  // it must be wrapped. The branch is bypassed if Ink delivered it as
  // many single-char events (depends on stdin chunking) — accept either
  // a single wrapped write or many single-char writes.
  if (writes.length === 1) {
    assert.equal(writes[0], '\x1b[200~hello world\x1b[201~',
      'wrapped paste when delivered as one chunk');
  } else {
    // Char-by-char delivery — no wrap, just verify nothing got duplicated.
    assert.equal(writes.join(''), 'hello world');
    for (const w of writes) {
      assert.ok(!w.includes('\x1b[200~'), 'no bracketed-paste on single-char');
    }
  }
  unmount();
});

// ─── Recipe I — Bracketed paste does NOT fire on single 'a' ─────────
test('zoom recipe I: single-char "a" sent raw (no bracketed-paste wrap)', async () => {
  const { stdin, stub, unmount } = renderPane();
  await tick(60);
  stub.term.write('\x1b[?2004h');
  await tick(40);
  await press(stdin, 'a');
  const writes = stub.getWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0], 'a', 'raw a, no escape sequence');
  unmount();
});

// ─── Recipe J — No double-character on typing ────────────────────────
test('zoom recipe J: typing "a" produces exactly one write of "a"', async () => {
  const { stdin, stub, unmount } = renderPane();
  await tick(60);
  await press(stdin, 'a');
  await press(stdin, 'b');
  await press(stdin, 'c');
  const writes = stub.getWrites();
  assert.equal(writes.length, 3, 'three keystrokes → three writes');
  assert.deepEqual(writes, ['a', 'b', 'c']);
  unmount();
});

// ─── Recipe O — chrome intercepts moved OFF claude's keys ───────────
// Tools=Ctrl+K (0x0b), Stats=Ctrl+U (0x15): both Ink-reliable (0x01-0x1a)
// AND unused by claude. The old Ctrl+T / Ctrl+S shadowed claude's
// app:toggleTodos / chat:stash — those now FORWARD to claude.
// (Ctrl+] / Ctrl+\ are NOT used: 0x1d/0x1c arrive with ctrl:false, so a
// `key.ctrl && input===']'` handler is unreachable — the old dead-key bug.)
test('zoom recipe O: Ctrl+K toggles tools, no PTY write', async () => {
  const toggles = [];
  const { stdin, stub, unmount } = renderPane({ onToggleTools: () => toggles.push(1) });
  await tick(60);
  await press(stdin, '\x0b'); // Ctrl+K
  assert.equal(toggles.length, 1, 'onToggleTools fired exactly once');
  assert.equal(stub.getWrites().length, 0, 'Ctrl+K not forwarded to claude');
  unmount();
});

test('zoom recipe O2: Ctrl+U toggles stats, no PTY write', async () => {
  const stats = [];
  const { stdin, stub, unmount } = renderPane({ onToggleStats: () => stats.push(1) });
  await tick(60);
  await press(stdin, '\x15'); // Ctrl+U
  assert.equal(stats.length, 1, 'onToggleStats fired exactly once');
  assert.equal(stub.getWrites().length, 0, 'Ctrl+U not forwarded to claude');
  unmount();
});

test('zoom recipe O3: Ctrl+T forwards to claude (its toggleTodos), not intercepted', async () => {
  const toggles = [];
  const { stdin, stub, unmount } = renderPane({ onToggleTools: () => toggles.push(1) });
  await tick(60);
  await press(stdin, '\x14'); // Ctrl+T
  assert.equal(toggles.length, 0, 'Ctrl+T no longer toggles mc tools');
  assert.ok(stub.getWrites().some((w) => w.includes('\x14')), 'Ctrl+T forwarded to claude');
  unmount();
});

// ─── Recipe Q — Resize forwards to both PTY and term ────────────────
test('zoom recipe Q: rerender with new dims calls pty.resize AND term.resize', async () => {
  const stub = makeStubAgent({ cols: 60, rows: 20 });
  const { rerender, unmount } = render(
    <PtyPane
      agent={stub.agent}
      width={60}
      height={20}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />
  );
  await tick(60);
  rerender(
    <PtyPane
      agent={stub.agent}
      width={100}
      height={30}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />
  );
  await tick(60);
  // The attach call resized once to (60,20), then the resize effect
  // fires again with the new dims. We just need to see (100,30) end up
  // in both resize logs.
  const ptyResizes = stub.getResizes();
  const termResizes = stub.getTermResizes();
  assert.ok(ptyResizes.some(([c, r]) => c === 100 && r === 30),
    `pty.resize never called with (100,30) — got ${JSON.stringify(ptyResizes)}`);
  assert.ok(termResizes.some(([c, r]) => c === 100 && r === 30),
    `term.resize never called with (100,30) — got ${JSON.stringify(termResizes)}`);
  unmount();
});

// ─── Recipe K — PtyPane respects allocated row count ────────────────
test('zoom recipe K: PtyPane renders exactly `rows` Text lines', async () => {
  const stub = makeStubAgent({ cols: 50, rows: 12 });
  const { lastFrame, unmount } = render(
    <PtyPane
      agent={stub.agent}
      width={50}
      height={12}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />
  );
  await tick(60);
  const frame = lastFrame() || '';
  const lines = frame.split('\n');
  // PtyPane allocates exactly `rows` Text children. Ink may add trailing
  // blank lines from the Box height; assert we have AT LEAST `rows`
  // lines AND no more than rows+1 (allow one tail newline).
  assert.ok(lines.length >= 12 && lines.length <= 13,
    `expected 12-13 rendered lines, got ${lines.length}`);
  unmount();
});

// ─── Recipe L — mc footer rendered below PtyPane in Zoom modal ──────
// ─── Recipe L2 — Zoom respects its `height` prop ─────────────────────
// Regression for the wrapper-overhead bleed bug: App.jsx wraps Zoom
// in paddingY=2 + FeedbackStrip + StatusBar (4 rows of overhead). If
// Zoom uses stdout.rows directly instead of the passed `height`, it
// allocates more body rows than the wrapper actually has, and claude's
// bottom UI bleeds past mc's footer into the FeedbackStrip region.
test('zoom recipe L2: Zoom modal height never exceeds the `height` prop', async () => {
  const stub = makeStubAgent({ cols: 100, rows: 30 });
  const zoomAgent = {
    ...stub.agent,
    branch: 'main', context: 1000, tokensIn: 100, tokensOut: 100,
    costSession: 0.1, status: 'idle', dirty: 0, ahead: 0, behind: 0,
  };
  const ALLOWED = 20;
  const { lastFrame, unmount } = render(
    <Zoom
      agent={zoomAgent}
      threshold={100000}
      onClose={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
      width={100}
      height={ALLOWED}
    />
  );
  await tick(80);
  const frame = lastFrame() || '';
  const lines = frame.split('\n');
  // Trim trailing whitespace-only lines from Ink padding.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  assert.ok(lines.length <= ALLOWED,
    `Zoom rendered ${lines.length} lines but was told it had ${ALLOWED} — overflow bleeds past mc chrome`);
  unmount();
});

test('zoom recipe L: Zoom footer ("⌃J newline") appears AFTER PtyPane region', async () => {
  // Build a Zoom-shaped agent the modal can render. Use the same stub
  // for the PtyPane subtree.
  const stub = makeStubAgent({ cols: 90, rows: 30 });
  const zoomAgent = {
    ...stub.agent,
    branch: 'main',
    context: 1000,
    tokensIn: 100, tokensOut: 100,
    costSession: 0.1,
    status: 'idle',
    dirty: 0, ahead: 0, behind: 0,
  };
  const { lastFrame, unmount } = render(
    <Zoom
      agent={zoomAgent}
      threshold={100000}
      onClose={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
      width={90}
    />
  );
  await tick(80);
  const frame = lastFrame() || '';
  const lines = frame.split('\n');
  // Footer is the row containing "newline" (from "⌥↵ newline"). It must
  // be near the BOTTOM of the rendered modal — last 3 rows.
  const footerIdx = lines.findIndex((l) => l.includes('newline'));
  assert.ok(footerIdx >= 0, `footer "newline" hint must appear in frame`);
  assert.ok(footerIdx >= lines.length - 4,
    `footer at row ${footerIdx} of ${lines.length} — expected within last 4 rows`);
  unmount();
});
