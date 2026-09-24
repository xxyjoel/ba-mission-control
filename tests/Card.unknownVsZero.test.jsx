// tests/Card.unknownVsZero.test.jsx — 0409: a missing measurement must never
// render as a plausible number. The card is the densest surface in the app, so
// an unknown context limit drawn as an empty bar reads as "0% used", and a
// missing uptime drawn as 0s reads as "just started". Both are lies about data
// we do not have. Pin the distinction: unknown renders '?', a real zero renders 0.
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
  context: 12000, tokensIn: 100, tokensOut: 50, costSession: 0.01, spark: [0, 0, 0],
  tail: [], permissionMode: 'default', sessionId: 'uuid-1',
};
const draw = (agent) => render(
  <Card agent={{ ...base, ...agent }} width={56} theme={theme} threshold={100000} now={Date.now()} />,
).lastFrame();

test('an UNKNOWN model context limit shows ? and draws no bar', () => {
  // resolvedModel the catalog has never heard of — maxCtx is genuinely unknown.
  const f = draw({ model: 'not-a-real-id', resolvedModel: 'claude-invented-9' });
  assert.match(f, new RegExp('\\' + UNKNOWN + '%'), 'percentage reads as unknown');
  assert.doesNotMatch(f, /0%/, 'never claims 0% of an unknown limit');
});

test('a KNOWN model still draws its real percentage', () => {
  const f = draw({ model: 'sonnet-4.6', resolvedModel: 'claude-sonnet-4-6' });
  assert.match(f, /\d+%/, 'a real percentage is shown');
  assert.doesNotMatch(f, new RegExp('\\' + UNKNOWN + '%'), 'not marked unknown when it is known');
});

test('launch model auto still has a ctx denominator (not ?%)', () => {
  // Before resolveAgentModel, MODELS['auto'] was undefined → ctxKnown false → ?%.
  const f = draw({ model: 'auto', resolvedModel: null, context: 12000 });
  assert.match(f, /\d+%/, 'auto resolves to newest opus maxCtx');
  assert.doesNotMatch(f, new RegExp('\\' + UNKNOWN + '%'));
});

test('missing uptime renders unknown, not a plausible zero', () => {
  const withOut = draw({ model: 'sonnet-4.6', resolvedModel: 'claude-sonnet-4-6' });
  const withIn = draw({ model: 'sonnet-4.6', resolvedModel: 'claude-sonnet-4-6', spawnedAt: Date.now() - 3000 });
  assert.notEqual(withOut, withIn, 'a known uptime renders differently from an unknown one');
  assert.match(withOut, new RegExp('\\' + UNKNOWN), 'unknown uptime is marked');
});
