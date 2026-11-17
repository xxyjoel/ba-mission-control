// tests/Card.shellJobs.test.jsx — 0483: running background shell jobs show
// on the card's ↳ row, never as a second status word (0418), and keep an
// idle slot from being advertised as needing a nudge.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Card from '../tui/Card.jsx';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

const agent = (over = {}) => ({
  id: 'a1', slot: 1, name: 'repo-1', model: 'sonnet-4.6', status: 'idle',
  branch: 'main', dirty: 0, ahead: 0, behind: 0, context: 10000,
  tokensIn: 100, tokensOut: 50, costSession: 0.42,
  spawnedAt: Date.now() - 60000, stateSince: Date.now() - 1000,
  turnCount: 3, messageCount: 10, tail: [], spark: [],
  todos: [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress', activeForm: 'doing b' },
  ],
  ...over,
});

const job = (label, mins) => ({ id: `bjob${mins}`, label, elapsedMs: mins * 60_000 });

function frameFor(a, cardWidth = 56) {
  const { lastFrame, unmount } = render(
    <Card agent={a} focused={false} threshold={100000} warnPct={85}
      borderStyle="rounded" theme={THEME} cardWidth={cardWidth} />,
  );
  const f = strip(lastFrame());
  unmount();
  return f;
}

test('one job: its label on the ↳ row, status stays IDLE, verb is check back', () => {
  const f = frameFor(agent({ shellJobs: [job('Link people to deals', 36)] }));
  // 0487: the age comes before the label, so a narrow card cuts the label.
  assert.match(f, /↳ job 36m: Link people to deals/);
  assert.match(f, /IDLE/);
  assert.doesNotMatch(f, /IDLE\s*·/, 'no second status word on the title row (0418)');
  assert.match(f, /check back/);
  assert.doesNotMatch(f, /needs a nudge/, 'an idle slot with a running job must not ask for a nudge');
  assert.doesNotMatch(f, /doing b/, 'the job takes the ↳ row from the todo');
});

test('several jobs: a count and the oldest age', () => {
  const f = frameFor(agent({ shellJobs: [job('a', 36), job('b', 26)] }));
  assert.match(f, /↳ 2 jobs · oldest 36m/);
});

test('an unnamed job (seen only as a process) shows its age, and days past 24 hours', () => {
  // 0484/0487: slot 3, 2026-11-17 — two loops a finished sub-agent left
  // running for 2 days 18 hours. mc showed IDLE and nothing else.
  const two = [{ id: 'pid:6295', label: null, elapsedMs: (66 * 60 + 12) * 60_000 },
    { id: 'pid:12876', label: null, elapsedMs: (66 * 60 + 10) * 60_000 }];
  const f = frameFor(agent({ shellJobs: two, todos: [] }));
  assert.match(f, /↳ 2 jobs · oldest 2d18h/);
  assert.match(f, /check back/);
  assert.doesNotMatch(f, /your turn/, 'a slot with jobs running is not ready');
  assert.match(frameFor(agent({ shellJobs: [two[0]], todos: [] })), /↳ 1 job · 2d18h/);
});

test('jobs and background agents together: both counts fit on the row', () => {
  const f = frameFor(agent({
    shellJobs: [job('a', 36), job('b', 26)],
    activeSubagents: [{ label: 'review the diff', type: 'agent', elapsedMs: 1000 }],
    bgCount: 1, bgStatus: 'working',
  }), 34);
  assert.match(f, /⋔1 agent · 2 jobs · 36m/);
});

test('no jobs: the row is unchanged', () => {
  const f = frameFor(agent({ shellJobs: [] }));
  assert.match(f, /↳ doing b/);
  assert.match(f, /needs a nudge/);
});

test('a label with terminal escapes is cleaned before it is drawn (0181)', () => {
  const f = frameFor(agent({ shellJobs: [job('evil\x1b[2Jlabel', 1)] }));
  assert.doesNotMatch(f, /\x1b\[2J/);
  assert.match(f, /job 1m: evil/);
});
