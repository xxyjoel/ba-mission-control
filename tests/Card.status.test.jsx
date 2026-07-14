// tests/Card.status.test.jsx — Card status-row chips + activity line.
//   0017 activity line is truncated, never overruns during streaming
//   0018 STUCK chip appears with stuckMin>0 and disappears at 0
//   0019 APPROVE? (approval-kind awaiting prompt) wins over INPUT? (waiting)

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];

function makeAgent(over = {}) {
  return {
    slot: 1, id: 'test-1', name: 'test', model: 'sonnet-4.6',
    branch: 'main', cwd: '/tmp', dirty: 0, ahead: 0, behind: 0,
    status: 'working', context: 1000, tokensIn: 100, tokensOut: 50,
    costSession: 0.01, costWeek: 0, spark: [1, 1, 1, 1, 1, 1, 1, 1],
    activity: 'doing things', sessionId: 'aaa-bbb-ccc',
    permissionMode: 'default', stuckMin: 0, tail: [], ...over,
  };
}
const draw = (agent) => render(
  <Card agent={agent} focused={false} threshold={150000} warnPct={85} borderStyle="rounded" theme={theme} />,
);

test('activity line is truncated and never overruns during streaming (0017)', () => {
  const { lastFrame, unmount } = draw(makeAgent({ activity: 'y'.repeat(500), status: 'working' }));
  const longestRun = (lastFrame().match(/y+/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
  // activity = trunc(humanize(...), 40) → at most ~40 cells, never 500.
  assert.ok(longestRun <= 41, `activity truncated to ~40 (longest run ${longestRun})`);
  unmount();
});

test('STUCK chip shows when stuckMin>0 and is gone at 0 (0018)', () => {
  const stuck = draw(makeAgent({ stuckMin: 7, status: 'working' }));
  assert.ok(stuck.lastFrame().includes('STUCK 7m'), 'shows STUCK 7m');
  stuck.unmount();
  const ok = draw(makeAgent({ stuckMin: 0, status: 'working' }));
  assert.ok(!ok.lastFrame().includes('STUCK'), 'no STUCK chip at 0');
  ok.unmount();
});

test('APPROVE? wins over INPUT? when an approval prompt is pending (0019)', () => {
  const agent = makeAgent({
    status: 'waiting',
    tail: [{ kind: 'asst', text: 'proceed?', preview: 'proceed?', ts: 1, awaitingPrompt: { kind: 'approval' } }],
  });
  const { lastFrame, unmount } = draw(agent);
  const f = lastFrame();
  assert.ok(f.includes('APPROVE?'), 'shows the louder APPROVE? marker');
  assert.ok(!f.includes('INPUT?'), 'INPUT? is suppressed when approval is pending');
  unmount();
});

test('plain waiting (no approval prompt) shows INPUT?, not APPROVE? (0019 control)', () => {
  const { lastFrame, unmount } = draw(makeAgent({ status: 'waiting', tail: [] }));
  const f = lastFrame();
  assert.ok(f.includes('INPUT?'), 'plain waiting → INPUT?');
  assert.ok(!f.includes('APPROVE?'));
  unmount();
});
