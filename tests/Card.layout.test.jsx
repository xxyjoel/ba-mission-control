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
