// tests/Zoom.derivedStatus.test.jsx — 0417: zoom and the card must print the
// same status word.
//
// Reported repeatedly: "says WORKING in zoom, says IDLE in the fleet view".
// The cause was two different variables. The card renders
// fleet.snapshot() -> toJSON().status, which is derived from the hook feed,
// the approval scrape and the freshness gates. Zoom rendered
// fleet.agentById().status — the LIVE instance, where that field is only the
// connector's opinion (ptyAgent.mjs:1161 feeds it in as `connectorStatus`).
// The derived value is never written back, so the two disagreed exactly when
// the derivation overrode the connector.
import './lib/force-color.js';
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Zoom from '../tui/modals/Zoom.jsx';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
  magenta: 'magenta', white: 'white',
};
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

// Stands in for the LIVE PtyAgent: carries the raw connector status.
const live = (over = {}) => ({
  id: 'a1', slot: 11, name: 'ba-mission-control', status: 'idle',
  branch: 'main', cwd: '/repo', context: 1000, tokensIn: 10, tokensOut: 5,
  costSession: 0.01, spark: [], tail: [], todos: [], model: 'opus-4.8',
  spawnedAt: Date.now() - 60000, stateSince: Date.now() - 1000,
  ...over,
});

function word(agent, derived) {
  const { lastFrame, unmount } = render(
    <Zoom agent={agent} derived={derived} threshold={100000} theme={THEME}
      width={100} height={30} weekCost={0} />,
  );
  const f = strip(lastFrame());
  unmount();
  return f;
}

test('0417: zoom prints the DERIVED status, not the live connector field', () => {
  // The exact reported shape: connector says idle, the derivation says working.
  const f = word(live({ status: 'idle' }), { status: 'working' });
  assert.match(f, /WORKING/, 'zoom must show what the card shows');
  assert.doesNotMatch(f, /\bIDLE\b/, 'the raw connector value must not reach the header');
});

test('0417: the divergence is fixed in both directions', () => {
  const f = word(live({ status: 'working' }), { status: 'idle' });
  assert.match(f, /IDLE/, 'a derived idle wins over a stale connector working');
  assert.doesNotMatch(f, /WORKING/);
});

test('0417: a waiting derivation still reads NEEDS INPUT', () => {
  const f = word(live({ status: 'idle' }), { status: 'waiting' });
  assert.match(f, /NEEDS INPUT/);
});

test('0417: with no snapshot the agent field is still used', () => {
  // The legacy Agent path and every existing test pass a plain object as
  // `agent` and nothing as `derived`; that must keep working.
  const f = word(live({ status: 'working' }), undefined);
  assert.match(f, /WORKING/);
});
