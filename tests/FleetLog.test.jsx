// tests/FleetLog.test.jsx — FleetLog derivation + row rendering.
//   0027 stable sort for equal timestamps
//   0052 auto-tail is deterministic under a burst (no flicker)
//   0025 name fallback is '—' (not the literal 'unknown')
//   0023/0024 name column is grapheme-safe (multi-byte names not split)
//   0021/0022 row text is truncated to a width-aware budget, not a fixed 90
//   0029/0030 err rows render their tool prefix (red), not nothing

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import FleetLog, { deriveFleetLog, fleetLogTextBudget } from '../tui/FleetLog.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const agent = (id, slot, name, tail) => ({ id, slot, name, status: 'working', tail });
const row = (over = {}) => ({ kind: 'asst', text: 'x', preview: 'x', ts: 1, slot: 1, agentId: 'a', name: 'A', ...over });

// ── deriveFleetLog: stable sort (0027) ─────────────────────────
test('deriveFleetLog keeps insertion order for equal timestamps (0027)', () => {
  const agents = [
    agent('a', 1, 'A', [{ kind: 'user', text: 'a1', ts: 100 }, { kind: 'asst', text: 'a2', ts: 100 }]),
    agent('b', 2, 'B', [{ kind: 'user', text: 'b1', ts: 100 }]),
  ];
  const out = deriveFleetLog(agents, 12, 'all');
  assert.deepEqual(out.map((x) => x.text), ['a1', 'a2', 'b1'], 'equal-ts entries keep agent+tail order');
});

test('deriveFleetLog orders by timestamp, tiebreak by sequence', () => {
  const agents = [
    agent('a', 1, 'A', [{ kind: 'asst', text: 'late', ts: 200 }, { kind: 'asst', text: 'mid', ts: 100 }]),
    agent('b', 2, 'B', [{ kind: 'asst', text: 'early', ts: 50 }]),
  ];
  assert.deepEqual(deriveFleetLog(agents, 12, 'all').map((x) => x.text), ['early', 'mid', 'late']);
});

// ── deriveFleetLog: auto-tail under burst (0052) ───────────────
test('deriveFleetLog auto-tails the last N deterministically under a burst (0052)', () => {
  const tail = Array.from({ length: 50 }, (_, i) => ({ kind: 'asst', text: `m${i}`, ts: i }));
  const agents = [agent('a', 1, 'A', tail)];
  const out1 = deriveFleetLog(agents, 12, 'all');
  const out2 = deriveFleetLog(agents, 12, 'all');
  assert.equal(out1.length, 12, 'returns exactly maxLines');
  assert.deepEqual(out1.map((x) => x.text), out2.map((x) => x.text), 'identical across calls — no reshuffle/flicker');
  assert.deepEqual(out1.map((x) => x.text), Array.from({ length: 12 }, (_, i) => `m${38 + i}`), 'the most recent 12');
});

// ── name fallback (0025) ───────────────────────────────────────
test('name column falls back to "—", never the literal "unknown" (0025)', () => {
  const { lastFrame, unmount } = render(<FleetLog log={[row({ name: undefined })]} theme={theme} maxLines={12} />);
  const f = lastFrame();
  assert.ok(!f.includes('unknown'), 'no literal "unknown"');
  assert.ok(f.includes('—'), 'shows the em-dash fallback');
  unmount();
});

// ── grapheme-safe name (0023/0024) ─────────────────────────────
test('name column does not split a multi-byte (emoji) name (0023/0024)', () => {
  const { lastFrame, unmount } = render(<FleetLog log={[row({ name: '😀😀😀' })]} theme={theme} maxLines={12} />);
  assert.ok(lastFrame().includes('😀😀😀'), 'short emoji name intact');
  unmount();
  // a name longer than the 20-cell column is sliced on grapheme boundaries.
  const long = '😀'.repeat(30);
  const r2 = render(<FleetLog log={[row({ name: long })]} theme={theme} maxLines={12} />);
  assert.ok(r2.lastFrame().includes('😀'.repeat(20)), 'sliced to 20 whole emoji, none split');
  r2.unmount();
});

// ── width-aware truncation (0021/0022) ─────────────────────────
test('row text budget is width-aware, not a fixed 90 (0021/0022)', () => {
  assert.equal(fleetLogTextBudget(0), 90, 'no width → legacy 90');
  assert.equal(fleetLogTextBudget(60), 20, 'narrow terminal → smaller budget');
  assert.equal(fleetLogTextBudget(200), 160, 'wide terminal → larger budget');
  assert.ok(fleetLogTextBudget(60) < fleetLogTextBudget(200), 'narrower width truncates more');
  assert.ok(fleetLogTextBudget(45) >= 20, 'floored at 20 so the column never vanishes');
});

// ── err tool prefix (0029/0030) ────────────────────────────────
test('err rows render their tool prefix (previously only tool-kind did) (0029/0030)', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={[row({ kind: 'err', tool: 'Bash', text: 'command failed', preview: 'command failed' })]} theme={theme} maxLines={12} />,
  );
  assert.ok(lastFrame().includes('Bash'), 'err row shows its tool prefix');
  unmount();
  // a tool-kind row still shows its prefix too.
  const r2 = render(<FleetLog log={[row({ kind: 'tool', tool: 'Read' })]} theme={theme} maxLines={12} />);
  assert.ok(r2.lastFrame().includes('Read'));
  r2.unmount();
});
