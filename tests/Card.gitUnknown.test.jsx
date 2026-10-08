// tests/Card.gitUnknown.test.jsx — 0452: the Card must not draw a green "clean"
// dot for git state it does not have. Contract (server/git.mjs):
//   dirty === null      → git read failed → UNKNOWN ('?')
//   isRepo === false    → not a repo      → no git chips at all
//   dirty === 0         → a real clean tree → green dot (unchanged)
// Only an explicit null is unknown; an absent field keeps the old rendering.
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';
import { UNKNOWN } from '../tui/lib/format.js';

const theme = THEMES.bluearch || Object.values(THEMES)[0];
const base = {
  id: 's1', slot: 1, status: 'idle', name: 'repo', branch: 'main', cwd: '/tmp',
  model: 'sonnet-4.6', resolvedModel: 'claude-sonnet-4-6', spawnedAt: Date.now() - 3000,
  context: 12000, tokensIn: 100, tokensOut: 50, costSession: 0.01, spark: [0, 0, 0],
  tail: [], permissionMode: 'default', sessionId: 'uuid-1',
};
const metaRow = (agent) => {
  const f = render(
    <Card agent={{ ...base, ...agent }} width={56} theme={theme} threshold={100000} now={Date.now()} />,
  ).lastFrame();
  return f.split('\n').find((l) => l.includes('⎇'));
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a real clean tree still shows the clean dot', () => {
  const row = metaRow({ dirty: 0, ahead: 0, behind: 0, isRepo: true });
  assert.match(row, /●/);
});

test('a failed git read (dirty null) shows unknown, not the clean dot', () => {
  const row = metaRow({ dirty: null, ahead: null, behind: null });
  assert.doesNotMatch(row, /●/, 'no clean dot for an unknown count');
  assert.match(row, new RegExp(esc(UNKNOWN) + '\\s*│\\s*$'), 'unknown marker at the chip position');
});

test('a non-repo cwd shows no git chips at all', () => {
  const row = metaRow({ isRepo: false, dirty: null, ahead: null, behind: null });
  assert.doesNotMatch(row, /●/, 'no clean dot for a non-repo');
  assert.doesNotMatch(row, new RegExp(esc(UNKNOWN) + '\\s*│\\s*$'), 'no unknown marker either');
});

test('a dirty tree still shows its count and ahead/behind', () => {
  const row = metaRow({ dirty: 3, ahead: 2, behind: 1, isRepo: true });
  assert.match(row, /\+3 ↑2 ↓1/);
});
