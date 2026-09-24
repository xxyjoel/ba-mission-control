// tests/Aggregate.subscriptions.test.jsx — per-subscription Aggregate (0420).
// Claude-only keeps the classic single line. Multi-sub is one row per
// provider with no blended Claude+Cursor tok/cost total.
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Aggregate from '../tui/Aggregate.jsx';
import Header from '../tui/Header.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES.bluearch || Object.values(THEMES)[0];
const stripAnsi = (t) => String(t || '').replace(/\u001b\[[0-9;]*m/g, '');
// Default ink harness is ~80 cols — these strips need room for week bar + chips.
const WIDE = { columns: 160, rows: 24 };

const usage = {
  fiveHour: { usedPct: 42, resetsAt: Date.now() + 3600_000 },
  sevenDay: { usedPct: 18, resetsAt: Date.now() + 86400_000 },
};
const fmtReset = () => '1h';

const agent = (over = {}) => ({
  id: 'a1', slot: 1, status: 'idle', provider: 'claude',
  tokensIn: 1000, tokensOut: 200, costSession: 1.5, context: 0,
  ...over,
});

const renderAgg = (props) => stripAnsi(render(
  <Aggregate
    agents={[]}
    fleetTpm={0}
    aggSpark={[0]}
    theme={theme}
    usage={null}
    fmtReset={fmtReset}
    weekCost={0}
    {...props}
  />,
  WIDE,
).lastFrame());

test('Claude-only Aggregate keeps classic tok·in / cost·session cells (not per-sub rows)', () => {
  const f = renderAgg({
    agents: [agent()],
    usage,
    weekCost: 12.5,
    providers: [{ id: 'claude', short: 'CC' }],
  });
  assert.match(f, /tok·in/, 'classic tok·in label');
  assert.match(f, /cost·session/, 'classic cost·session');
  assert.match(f, /cost·week/, 'classic week cell');
  assert.doesNotMatch(f, /\bclaude\s+plan/, 'no multi-sub "claude · plan" segment');
  assert.doesNotMatch(f, /\bcursor\b/, 'no cursor segment when only claude');
});

test('Claude plan chips render on the per-sub claude row', () => {
  const f = renderAgg({
    agents: [agent({ costSession: 1 })],
    usage,
    providers: [
      { id: 'claude', short: 'CC' },
      { id: 'cursor', short: 'CUR' },
    ],
  });
  assert.match(f, /5h 42%/, 'plan % on claude row');
  assert.match(f, /7d 18%/, '7d on claude row');
  assert.match(f, /5h 42%\s+↻/, 'space before reset glyph');
  assert.match(f, /◆\s*claude/, 'green active marker on claude row');
});

test('two connected providers → per-sub rows, no blended tok·in line', () => {
  const f = renderAgg({
    agents: [
      agent({ tokensIn: 1000, tokensOut: 100, costSession: 2 }),
      agent({ id: 'a2', slot: 2, provider: 'cursor', tokensIn: null, tokensOut: null, costSession: null }),
    ],
    usage,
    weekCost: 40,
    providers: [
      { id: 'claude', short: 'CC' },
      { id: 'cursor', short: 'CUR' },
    ],
    cursorUsageSync: false,
  });
  assert.match(f, /claude/, 'claude segment labeled');
  assert.match(f, /cursor/, 'cursor segment labeled');
  assert.match(f, /◆\s*claude/, 'active marker on claude');
  assert.match(f, /◆\s*cursor/, 'active marker on cursor');
  assert.match(f, /5h 42%/, 'claude plan stays on claude segment');
  assert.match(f, /sync off/, 'cursor honest about missing sync');
  assert.match(f, /\$-\.--/, 'cursor unknown cost is unmeasured, not $0.00');
  assert.doesNotMatch(f, /tok·in/, 'no classic blended tok·in cell');
  assert.doesNotMatch(f, /fleet/, 'no blended fleet tpm when multi-sub');
  // Must not invent Claude windows for Cursor.
  assert.doesNotMatch(f, /cursor[^\n]*5h/, 'cursor segment has no 5h chip');
});

test('Cursor null tokens stay unmeasured on the cursor segment', () => {
  const f = renderAgg({
    agents: [
      agent({ provider: 'cursor', tokensIn: null, tokensOut: null, costSession: null, status: 'working' }),
    ],
    providers: [
      { id: 'claude', short: 'CC' },
      { id: 'cursor', short: 'CUR' },
    ],
    cursorUsageSync: true,
  });
  assert.match(f, /plan —/, 'sync on but no period-% yet → plan —');
  assert.match(f, /\$-\.--/, 'null cost stays unmeasured');
  assert.match(f, /-\s*↓/, 'null tokensIn → unmeasured arrow');
});

test('enabled-but-not-yet-ok Cursor still gets an Aggregate row', () => {
  const f = renderAgg({
    agents: [],
    usage,
    providers: [
      { id: 'claude', short: 'CC', ok: true, detail: 'max' },
      { id: 'cursor', short: 'CUR', ok: false, detail: 'not signed in' },
    ],
  });
  assert.match(f, /◆\s*claude/, 'claude connected marker');
  assert.match(f, /max/, 'claude connection detail');
  assert.match(f, /cursor/, 'cursor row present while disconnected');
  assert.match(f, /✕\s*cursor|not signed in/, 'cursor shows disconnected');
});

test('Header multi-sub says all sessions (no CC/CUR chips)', () => {
  const f = stripAnsi(render(
    <Header
      agents={[agent(), agent({ id: 'a2', slot: 2, provider: 'cursor' })]}
      threshold={160000}
      nowStr="12:00"
      sessionStr="1m"
      theme={theme}
      auth={{ ok: true, email: 'j@x.com', subscription: 'max' }}
      subscriptions={[
        { id: 'claude', short: 'CC', ok: true, detail: 'max' },
        { id: 'cursor', short: 'CUR', ok: true, detail: 'c@x.com' },
      ]}
    />,
    WIDE,
  ).lastFrame());
  assert.match(f, /all sessions/, 'fleet label');
  assert.match(f, /session\s+1m/, 'session timer early');
  assert.match(f, /UTC\s+12:00/, 'UTC clock early');
  assert.doesNotMatch(f, /\bCC\b/, 'no CC chip on header');
  assert.doesNotMatch(f, /\bCUR\b/, 'no CUR chip on header');
});

test('Header Claude-only keeps legacy path (no short CC/CUR chips)', () => {
  const f = stripAnsi(render(
    <Header
      agents={[agent()]}
      threshold={160000}
      nowStr="12:00"
      sessionStr="1m"
      theme={theme}
      auth={{ ok: true, email: 'joel@example.com', subscription: 'max' }}
      subscriptions={[{ id: 'claude', short: 'CC', ok: true, detail: 'max' }]}
    />,
    WIDE,
  ).lastFrame());
  assert.match(f, /sessions/, 'ops strip present');
  assert.doesNotMatch(f, /all sessions/, 'single-sub keeps N sessions wording');
  assert.doesNotMatch(f, /\bCC\b/, 'single-sub does not switch to short chips');
  assert.doesNotMatch(f, /\bCUR\b/, 'no cursor chip when only claude');
});

test('Header hides ctx≥ counter when no live sessions', () => {
  const f = stripAnsi(render(
    <Header
      agents={[]}
      threshold={600000}
      nowStr="12:00"
      sessionStr="1m"
      theme={theme}
      auth={{ ok: true, email: 'j@x.com' }}
    />,
    WIDE,
  ).lastFrame());
  assert.doesNotMatch(f, /ctx≥/, 'no empty 0/0 ctx counter');
  assert.doesNotMatch(f, /over /, 'old over label gone');
});
