// tests/Card.sessionAge.test.jsx — 0409: the ⧗ hourglass must measure the
// CONVERSATION, not the agent object.
//
// spawnedAt is stamped in the agent constructor, so it survives an
// auto-restart and a changeModel (same instance reused) but NOT a resume or a
// Mission Control restart — fleet.resume() calls launch(), which does
// `new PtyAgent(...)`. Observed 2026-09-19: seven slots relaunched from a
// saved set all read the same sub-second uptime, for conversations days apart.
//
// Contract: render sessionStartedAt (epoch ms of the first record in the
// session transcript, set by sessionFileTailer), fall back to spawnedAt when
// it is null, and render UNKNOWN when neither is present — never a plausible
// zero (the 0409 guarantee pinned by Card.unknownVsZero.test.jsx).
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';
import { UNKNOWN } from '../tui/lib/format.js';

const theme = THEMES.bluearch || Object.values(THEMES)[0];
const base = {
  id: 's1', slot: 1, status: 'idle', name: 'repo', branch: 'main', cwd: '/tmp',
  context: 12000, tokensIn: 100, tokensOut: 50, costSession: 0.01, spark: [0, 0, 0],
  tail: [], permissionMode: 'default', sessionId: 'uuid-1',
  model: 'sonnet-4.6', resolvedModel: 'claude-sonnet-4-6',
};
// cardWidth must clear 44 or the vitals row drops the hourglass entirely
// (Card.jsx gates it on innerW >= 40). The outer Box is what actually
// constrains the render — cardWidth alone is only Card's own text budget.
const W = 56;
const draw = (agent) => render(
  <Box width={W}><Card agent={{ ...base, ...agent }} cardWidth={W} theme={theme} threshold={100000} now={Date.now()} /></Box>,
).lastFrame();

// The hourglass reading only — stateAge sits on the same row behind its own
// status glyph, and both are durations.
function uptimeOf(frame) {
  const m = frame.replace(/\x1b\[[0-9;]*m/g, '').match(/⧗(\S+)/);
  return m ? m[1] : null;
}

const DAY = 24 * 60 * 60 * 1000;

test('a conversation that began days ago reads days, not the agent object age', () => {
  const now = Date.now();
  // The exact shape of the bug: the process relaunched 90 seconds ago to
  // resume a conversation that is three days old.
  const f = draw({ sessionStartedAt: now - 3 * DAY, spawnedAt: now - 90_000 });
  const up = uptimeOf(f);
  assert.ok(up, 'the hourglass renders');
  // fmtDurShort tops out at hours, so three days is 72h.
  const hours = Number(up.match(/^(\d+)h/)?.[1] ?? 0);
  assert.ok(hours >= 71, `three days of conversation reads as ~72h, got ${up}`);
  assert.notEqual(up, '1m', 'the 90s-old process must not be what the card reports');
});

test('two sessions relaunched together still read their own ages', () => {
  // The seven-slots-one-value symptom: same spawnedAt, different transcripts.
  const now = Date.now();
  const spawnedAt = now - 1000;
  const young = uptimeOf(draw({ spawnedAt, sessionStartedAt: now - 5 * 60_000 }));
  const old = uptimeOf(draw({ spawnedAt, sessionStartedAt: now - 2 * DAY }));
  assert.notEqual(young, old, 'cards launched in the same second must not report one age');
  assert.equal(young, '5m');
});

test('no transcript timestamp falls back to the spawn time', () => {
  // A brand-new session has no transcript yet, and the legacy Agent path never
  // gets one. spawnedAt is then the best reading available.
  const f = draw({ spawnedAt: Date.now() - 3000, sessionStartedAt: null });
  assert.equal(uptimeOf(f), '3s');
});

test('neither timestamp renders unknown, not a plausible zero', () => {
  // 0409 guarantee, extended to the new field: a missing measurement never
  // renders as a number the operator could believe.
  const f = draw({ spawnedAt: undefined, sessionStartedAt: undefined });
  assert.equal(uptimeOf(f), UNKNOWN, 'unknown age is marked, not drawn as 0s');
  assert.doesNotMatch(f, /⧗0s/);
});

test('the conversation age does not widen the card past its budget', () => {
  // 72h00m is the longest reading the hourglass can produce for a realistic
  // session; the vitals row must still fit.
  const f = draw({ sessionStartedAt: Date.now() - 30 * DAY, turnCount: 999, messageCount: 999 });
  for (const line of f.split('\n')) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(plain.length <= W, `row overflows the card: ${JSON.stringify(plain)}`);
  }
});

// The card can only read what the snapshot carries. sessionFileTailer sets
// agent.sessionStartedAt; both agent classes must ship it through toJSON or
// the fix above is inert — and Agent must carry it too, because
// tests/ptyAgent.test.mjs pins PtyAgent.toJSON as a superset of Agent's.
test('both agent classes ship sessionStartedAt through toJSON', async () => {
  const { PtyAgent } = await import('../server/ptyAgent.mjs');
  const { Agent } = await import('../server/agent.mjs');
  const args = {
    slot: 1, id: 's1-age', cwd: '/tmp/fake-cwd', model: 'sonnet-4.6',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn: () => { throw new Error('not spawned in this test'); },
  };
  const p = new PtyAgent(args);
  const a = new Agent(args);
  // Unset until the tailer reads the transcript — null, never a stand-in now().
  assert.equal(p.toJSON().sessionStartedAt, null);
  assert.equal(a.toJSON().sessionStartedAt, null);
  // What sessionFileTailer.primeSessionStartedAt() does.
  const began = Date.now() - 3 * DAY;
  p.sessionStartedAt = began;
  assert.equal(p.toJSON().sessionStartedAt, began, 'the card reads this value');
  assert.notEqual(p.toJSON().spawnedAt, began, 'spawnedAt stays the object clock');
});
