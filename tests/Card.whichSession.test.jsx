// tests/Card.whichSession.test.jsx — 0414: a card must say WHICH conversation
// it is showing. On 2026-09-19 three live sessions sat in one folder, the card
// showed one of them, and the user typed a long list of requirements into a
// different one. Nothing on screen distinguished them.
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES.bluearch || Object.values(THEMES)[0];
const base = {
  id: 's1', slot: 13, status: 'idle', name: 'stonks', branch: 'main', cwd: '/repo/stonks',
  context: 12000, tokensIn: 100, tokensOut: 50, costSession: 0.01, spark: [0, 0, 0],
  tail: [], permissionMode: 'default',
  model: 'opus-4.8', resolvedModel: 'claude-opus-4-8',
  sessionId: 'add052b8-1517-4f0a-b6a5-70abbd6abb8d',
};
// cardWidth is the prop Card actually budgets against; `width` is ignored.
const W = 64;
const draw = (agent) => render(
  <Box width={W}><Card agent={{ ...base, ...agent }} cardWidth={W} theme={theme} threshold={100000} now={Date.now()} /></Box>,
).lastFrame();

test('the card shows the short id of the session it is attached to', () => {
  assert.match(draw({}), /add052b8/, 'the eight characters claude also prints');
});

test('other live conversations in the same folder are marked', () => {
  assert.match(draw({ otherSessions: 2 }), /!2/, 'two others in this folder');
});

test('a folder with no other conversation draws no mark', () => {
  assert.doesNotMatch(draw({ otherSessions: 0 }), /!\d/);
});

test('an unreadable session list draws no mark rather than claiming none', () => {
  // null means we could not look. Drawing nothing is right; drawing a zero
  // would claim there is only one conversation here.
  assert.doesNotMatch(draw({ otherSessions: null }), /!\d/);
  assert.doesNotMatch(draw({}), /!\d/);
});

test('the id and the mark do not push the row past the card width', () => {
  const f = draw({ otherSessions: 3, branch: 'ops/db-recovery-incident-2026' });
  for (const line of f.split('\n')) {
    assert.ok(line.length <= W, `row overflows the card: ${JSON.stringify(line)}`);
  }
});
