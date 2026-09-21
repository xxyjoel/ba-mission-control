// tests/Card.triage.test.jsx — 0408 D2/M4 on the fleet card.
//
//   D2: the triage verb read `agent.status` alone, so a slot showing
//       `IDLE · bg WORKING` (background agents fanned out, foreground turn
//       idle — e7e28fa keeps status idle during fan-out) told the operator
//       `needs a nudge →`. Nudging a busy slot interrupts it; the verb must be
//       the working-branch `check back`.
//   M4: a session cost computed from an INHERITED pricing row
//       (models.js estimatedPricing) rendered identically to a verified one.

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
    { content: 'c', status: 'pending' },
  ],
  ...over,
});

function frameFor(a) {
  const { lastFrame, unmount } = render(
    <Card agent={a} focused={false} threshold={100000} warnPct={85}
      borderStyle="rounded" theme={THEME} cardWidth={56} />,
  );
  const f = strip(lastFrame());
  unmount();
  return f;
}

test('D2: idle with background agents running reads "check back", not "needs a nudge"', () => {
  const f = frameFor(agent({ bgCount: 3, bgStatus: 'working' }));
  // 0418: the status row carries ONE status word. Background work is listed in
  // the body row instead, so nothing named "bg" appears beside the status.
  assert.doesNotMatch(f, /bg/i, 'no second status word on the title row');
  // This fixture sets bgCount/bgStatus but no activeSubagents — the
  // hook-clock shape, where the server knows work is live but cannot count it.
  // The body says so without inventing a number.
  assert.match(f, /⋔ background agents running/, 'background work is listed in the body');
  assert.match(f, /check back/, 'the working-branch verb');
  assert.doesNotMatch(f, /needs a nudge/, 'must not tell the operator to interrupt a busy slot');
});

test('D2: idle with bg agents and ALL todos done still says check back, not ready to review', () => {
  const f = frameFor(agent({
    bgCount: 2, bgStatus: 'working',
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
  }));
  assert.match(f, /check back/);
  assert.doesNotMatch(f, /ready to review/, 'the session is not harvestable while bg agents run');
});

test('D2: idle WITHOUT background agents keeps the existing verbs', () => {
  assert.match(frameFor(agent()), /needs a nudge/);
  assert.match(frameFor(agent({
    todos: [{ content: 'a', status: 'completed' }],
  })), /ready to review/);
});

test('M4: estimatedPricing model marks the session cost with ~', () => {
  const f = frameFor(agent({ model: 'fable-5.1' }));
  assert.match(f, /~\$0\.42 ses/, 'estimated cost must carry the ~ prefix');
});

test('M4: verified pricing renders the cost with no ~', () => {
  const f = frameFor(agent({ model: 'sonnet-4.6' }));
  assert.match(f, /\$0\.42 ses/);
  assert.doesNotMatch(f, /~\$/);
});
