// tests/Card.stats.test.jsx — the stats-only card (2026-07-06 redesign).
// The tile no longer renders session text; it shows TODO progress, session
// vitals, and a dedicated health row. These pin that new contract. The
// fixed-11-row / no-overflow invariant lives in Card.layout.test.jsx.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];

function makeAgent(over = {}) {
  return {
    slot: 1, id: 'test-1', name: 'test', model: 'sonnet-4.6',
    branch: 'main', cwd: '/tmp/no-health-here', dirty: 0, ahead: 0, behind: 0,
    status: 'working',
    context: 1000, tokensIn: 100, tokensOut: 50,
    costSession: 0.01, costWeek: 0,
    spark: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    sessionId: 'aaa-bbb-ccc', permissionMode: 'default',
    turnCount: 12, messageCount: 340,
    spawnedAt: Date.now() - 5000, stateSince: Date.now() - 3000,
    todos: [], tail: [],
    ...over,
  };
}

function frameOf(agent, props = {}) {
  const { lastFrame, unmount } = render(
    <Card agent={agent} focused={false} threshold={150000} warnPct={85}
      borderStyle="rounded" theme={theme} cardWidth={56} {...props} />
  );
  const f = lastFrame() || '';
  unmount();
  return f;
}

test('card stats: no session tail/activity text is rendered', () => {
  const agent = makeAgent({
    activity: 'streaming assistant text here',
    tail: [{ kind: 'asst', text: 'SECRET-TAIL-LINE', preview: 'SECRET-TAIL-LINE', ts: 1 }],
  });
  const frame = frameOf(agent);
  assert.doesNotMatch(frame, /SECRET-TAIL-LINE/, 'tail text must not render');
  assert.doesNotMatch(frame, /streaming assistant text/, 'activity text must not render');
});

test('card stats: TODO progress shows done/total + in-progress item', () => {
  const agent = makeAgent({
    todos: [
      { content: 'a', status: 'completed', activeForm: 'doing a' },
      { content: 'b', status: 'completed', activeForm: 'doing b' },
      { content: 'wire the retry handler', status: 'in_progress', activeForm: 'wiring the retry handler' },
      { content: 'd', status: 'pending', activeForm: 'doing d' },
    ],
  });
  const frame = frameOf(agent);
  assert.match(frame, /2\/4/, 'shows completed/total');
  assert.match(frame, /wiring the retry handler/, 'shows the in-progress activeForm');
});

test('card stats: empty TODO list keeps the triage + item rows present (no reflow)', () => {
  const frame = frameOf(makeAgent({ todos: [] }));
  assert.match(frame, /▸ /, 'triage row marker present');
  assert.match(frame, /↳ —/, 'current-item placeholder keeps the row present');
});

test('card stats: vitals show turn count and message count', () => {
  const frame = frameOf(makeAgent({ turnCount: 12, messageCount: 340 }));
  assert.match(frame, /⟳12/, 'turn count chip');
  assert.match(frame, /340/, 'message count chip');
});

test('card stats: no health dot when project has no benchmark data', () => {
  // /tmp/no-health-here has no .project-health → readProjectHealth returns null,
  // so the vitals row simply omits the ●score dot (no placeholder text now).
  const frame = frameOf(makeAgent());
  assert.doesNotMatch(frame, /●\d+[↑↓·→]/, 'no health score dot rendered');
  assert.match(frame, /⟳/, 'vitals row still renders');
});

test('card stats: untrusted health verdict text never reaches the TTY (score dot only)', () => {
  // The verdict STRING in .project-health/history.jsonl is untrusted. Post-0256
  // the card renders health as a numeric ●score dot only — the verdict word is
  // not rendered anywhere, so an escape payload in it cannot reach the terminal.
  const dir = mkdtempSync(join(tmpdir(), 'mc-health-'));
  try {
    mkdirSync(join(dir, '.project-health'));
    writeFileSync(
      join(dir, '.project-health', 'history.jsonl'),
      JSON.stringify({ composite: 77, verdict: '\x1b[31mHEALTHY\x1b[0m — converging', timestamp: 1 }) + '\n',
    );
    const frame = frameOf(makeAgent({ cwd: dir }));
    assert.doesNotMatch(frame, /\x1b\[31m/, 'raw CSI escape must not reach the frame');
    assert.doesNotMatch(frame, /HEALTHY/, 'the verdict word is no longer rendered on the card');
    assert.match(frame, /77/, 'the numeric health score dot renders');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
