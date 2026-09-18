// tests/FleetLog.budget.test.jsx — the log renders EXACTLY the rows it is
// budgeted, and says so when the terminal cannot honour the Settings count.
//
// It used to render `Math.max(4, maxLines)`, overriding its caller's budget
// upward. On a short terminal that pushed the whole frame past the last screen
// row, which is what makes the view tear and scroll.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import FleetLog, { deriveFleetLog } from '../tui/FleetLog.jsx';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// 20 log entries, one per line, with findable text.
const LOG = Array.from({ length: 20 }, (_, i) => ({
  ts: 1000 + i, kind: 'asst', text: `entry${String(i).padStart(2, '0')}`,
  agentId: 's1', slot: 1, name: 'repo-1',
}));

function rowsOf(frame) {
  // The header is row 0; count the body rows that carry an entry.
  return strip(frame).split('\n').filter((l) => /entry\d\d/.test(l)).length;
}

test('renders exactly maxLines rows, never a floor of 4', () => {
  for (const maxLines of [1, 2, 3, 4, 7, 12, 20]) {
    const { lastFrame, unmount } = render(
      <FleetLog log={LOG} theme={THEME} maxLines={maxLines} width={120} />,
    );
    assert.equal(rowsOf(lastFrame()), maxLines, `maxLines=${maxLines} rendered the wrong row count`);
    unmount();
  }
});

test('maxLines=0 renders no entry rows at all', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={0} width={120} />,
  );
  assert.equal(rowsOf(lastFrame()), 0);
  unmount();
});

test('shows the newest entries, not the oldest', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={3} width={120} />,
  );
  const frame = strip(lastFrame());
  assert.match(frame, /entry19/);
  assert.match(frame, /entry17/);
  assert.doesNotMatch(frame, /entry16/);
  unmount();
});

test('says so when the terminal cannot honour the Settings line count', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={8} requestedLines={30} width={120} />,
  );
  assert.match(strip(lastFrame()), /8\/30 lines \(terminal height\)/,
    'a silent clamp is what made "I set 30 and get 8" look like a bug');
  unmount();
});

test('stays quiet when the setting IS honoured', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={12} requestedLines={12} width={120} />,
  );
  assert.doesNotMatch(strip(lastFrame()), /lines \(terminal height\)/);
  unmount();
});

test('deriveFleetLog still hands over a window at least as large as asked', () => {
  const agents = [{ id: 's1', slot: 1, name: 'r', status: 'idle', tail: LOG }];
  assert.equal(deriveFleetLog(agents, 5, 'all').length, 5);
  assert.equal(deriveFleetLog(agents, 40, 'all').length, 20, 'capped by what exists');
});
