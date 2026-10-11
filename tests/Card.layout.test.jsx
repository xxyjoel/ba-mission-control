// tests/Card.layout.test.jsx — the card must be a fixed 11-row × cardWidth
// box at every width, so the grid can't overlap. Regression guard for the
// "random box overlap" bug: long name/branch used to wrap the card taller
// (vertical overlap) or paint past its width (horizontal overlap).

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';
import { MIN_CARD_W } from '../tui/lib/gridLayout.js';

const theme = THEMES['BlueArch'];

// A worst-case agent: long name + long branch + every git chip + stuck.
function heavyAgent() {
  return {
    slot: 6, id: 'h', name: 'gtm-edp-ppa-insurance-really-long-name',
    model: 'opus-4.7', resolvedModel: 'claude-opus-4-7',
    branch: 'ops/db-recovery-incident-20-very-long-branch',
    dirty: 5, ahead: 4, behind: 2, status: 'working', stuckMin: 7,
    context: 150800, tokensIn: 8711500, tokensOut: 140200,
    costSession: 32.79, costWeek: 3401.24, spark: [1, 2, 3, 4, 5],
    activity: 'Bash: uv run --no-sync pytest -q', cwd: '/tmp',
    permissionMode: 'default',
    tail: [
      { kind: 'asst', preview: 'Cherry-pick clean. Now running tests to confirm no regression' },
      { kind: 'user', preview: 'sounds good' },
    ],
  };
}

function frameAt(width) {
  const el = React.createElement(
    Box, { width },
    React.createElement(Card, {
      agent: heavyAgent(), cardWidth: width, threshold: 200000, warnPct: 85,
      borderStyle: 'round', showTools: false, theme,
    }),
  );
  const { lastFrame } = render(el, { stdout: { columns: 240, rows: 40, write() {}, on() {}, off() {} } });
  return lastFrame();
}

const visW = (line) => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length;

// Cover the realistic grid column widths on common terminals (5-col → 1-col).
for (const width of [34, 40, 43, 50, 57, 86, 120]) {
  test(`Card layout: exactly 11 rows, no width overflow at cardWidth=${width}`, () => {
    const lines = frameAt(width).split('\n');
    assert.equal(lines.length, 11, `card must be 11 rows tall (was ${lines.length})`);
    const maxW = Math.max(...lines.map(visW));
    assert.ok(maxW <= width, `card must not exceed its width ${width} (was ${maxW})`);
  });
}

// ── 0459: every labelled row intact at narrow widths ─────────────────────
// The row-count check above passes while rows wrap INSIDE the card: at
// cardWidth 23 (the 5-col grid on a 120-col terminal under the old
// MIN_CARD_W=20) the tok/min and ctx rows wrapped onto two lines each and the
// fixed 11-row box clipped the model/branch row's tail and the vitals row off
// the bottom. So this pins each labelled row to ITS line, with its label and
// its key figure on that one line, for every width from the Card's own floor
// (20) up past the grid minimum.
function fullAgent() {
  const now = Date.now();
  return {
    ...heavyAgent(),
    cwd: '/nonexistent/mc-0459', // keep readProjectHealth() null
    sessionId: 'abcdef01-2345-6789-abcd-ef0123456789', otherSessions: 3,
    procCpu: 99, procMemKb: 512000, lastTokRate: 12345,
    sessionStartedAt: now - 3_600_000, spawnedAt: now - 3_600_000, stateSince: now - 60_000,
    turnCount: 120, messageCount: 340,
    todos: [
      { content: 'a', status: 'completed', activeForm: 'doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'wiring the retry handler' },
    ],
  };
}

function fullFrameAt(width) {
  const el = React.createElement(
    Box, { width },
    React.createElement(Card, {
      agent: fullAgent(), cardWidth: width, threshold: 200000, warnPct: 70,
      borderStyle: 'round', showTools: false, theme,
    }),
  );
  const { lastFrame } = render(el, { stdout: { columns: 240, rows: 40, write() {}, on() {}, off() {} } });
  return lastFrame().replace(/\x1b\[[0-9;]*m/g, '');
}

// [line index inside the 11-row frame, what must be on it, row name]
const ROWS_0459 = [
  [1, /^│ \[6\] .*● WORKING/,      'title: slot tag + full status word'],
  [2, /^│ OPUS .*⎇ \S/,           'model/branch: model label + branch'],
  [3, /^│ ctx .*150\.8k/,         'ctx: label + measured tokens'],
  [4, /^│ tok\/min 12\.3k/,        'tok/min: label + rate'],
  [6, /^│ ▸ 1\/2/,                 'triage: marker + burndown count'],
  [7, /^│ ↳ \S/,                   'current item'],
  [8, /^│ ⟳120\b.*●1m │$/,         'vitals: turns + state age at right edge'],
  [9, /^│ \$32\.79 ses/,           'foot: session cost + label'],
];

for (let width = 20; width <= 43; width++) {
  test(`0459 Card layout: every labelled row intact at cardWidth=${width}`, () => {
    const lines = fullFrameAt(width).split('\n');
    assert.equal(lines.length, 11, `card must be 11 rows tall (was ${lines.length})`);
    for (const line of lines) {
      assert.ok(visW(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
    }
    for (const [i, re, what] of ROWS_0459) {
      assert.match(lines[i], re, `${what} — line ${i} at width ${width}:\n${lines.join('\n')}`);
    }
    // From the grid's minimum card width up, nothing that carries a figure is
    // dropped to make room: the STUCK minutes, the ctx bar, the proc readout,
    // the ✉ count, both token totals.
    if (width >= MIN_CARD_W) {
      const f = lines.join('\n');
      assert.match(lines[1], /STUCK 7m/, `STUCK minutes at ${width}:\n${f}`);
      assert.match(lines[2], /\+5 ↑4 ↓2 │$/, `git chips at ${width}:\n${f}`);
      assert.match(lines[3], /^│ ctx [█▏▎▍▌▋▊▉│·]{14} 150\.8k 15%/, `full ctx bar at ${width}:\n${f}`);
      assert.match(lines[4], /99% 500M │$/, `proc readout at ${width}:\n${f}`);
      assert.match(lines[8], /340✉/, `msgs count at ${width}:\n${f}`);
      assert.match(lines[9], /8\.7M↓ 140\.2k↑ │$/, `token totals at ${width}:\n${f}`);
    }
  });
}

// 0459 review: two rows could read wrongly once squeezed. (1) The title's
// short STUCK form sat flush against the ctx% chip (`· 20% STUCK`, read as
// "20% stuck") while the STUCK minutes were the part dropped. (2) A branch
// cut to its 3-cell floor ran into the git chips (`fe…+12345`, `ma…●`).
const heavyWith = (over) => ({ ...heavyAgent(), ...over });
function frameOf(agent, width) {
  const el = React.createElement(
    Box, { width },
    React.createElement(Card, {
      agent, cardWidth: width, threshold: 200000, warnPct: 70,
      borderStyle: 'round', showTools: false, theme,
    }),
  );
  const { lastFrame } = render(el, { stdout: { columns: 240, rows: 40, write() {}, on() {}, off() {} } });
  return lastFrame().replace(/\x1b\[[0-9;]*m/g, '').split('\n');
}

const SQUEEZE_0459 = [
  heavyAgent(),
  heavyWith({ stuckMin: 125, context: 190000 }),
  heavyWith({ branch: 'feature/a-very-long-branch-name', dirty: 12345, ahead: 999, behind: 0 }),
  heavyWith({ model: 'mystery-9', resolvedModel: 'mystery-9', branch: 'main-long-branch', dirty: 0, ahead: 0, behind: 0 }),
  fullAgent(),
];

for (let width = 20; width <= 60; width++) {
  test(`0459 Card layout: squeezed title and branch rows stay readable at cardWidth=${width}`, () => {
    for (const agent of SQUEEZE_0459) {
      const lines = frameOf(agent, width);
      const f = lines.join('\n');
      // STUCK always carries its ` · ` separator, and a cut-down STUCK (no
      // minutes) never shares the row with the ctx% chip.
      if (/STUCK/.test(lines[1])) {
        assert.match(lines[1], / · STUCK/, `STUCK separator at ${width}:\n${f}`);
        if (!/STUCK \d+m/.test(lines[1])) {
          assert.doesNotMatch(lines[1], /· \d+%/, `ctx% kept over STUCK minutes at ${width}:\n${f}`);
        }
      }
      // The name never runs into the status glyph.
      assert.match(lines[1], /^│ \[6\] (\S.* )?● /, `name touches status at ${width}:\n${f}`);
      // Whatever right-hand git chip is shown, a space sits before it.
      assert.doesNotMatch(lines[2], /[^\s](\+\d+|●|\?)( ↑\d+)?( ↓\d+)? +│$/, `branch touches git chips at ${width}:\n${f}`);
    }
  });
}
