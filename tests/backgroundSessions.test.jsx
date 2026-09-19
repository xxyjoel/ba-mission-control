// tests/backgroundSessions.test.jsx — the sessions claude runs outside the
// fleet must be visible, and "we could not look" must never render as "none".
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import BackgroundSessions from '../tui/modals/BackgroundSessions.jsx';
import Aggregate from '../tui/Aggregate.jsx';
import { THEMES } from '../tui/lib/themes.js';
import { staleBackgroundSessions, removeSession } from '../server/claudeSessions.mjs';

const theme = THEMES.bluearch || Object.values(THEMES)[0];
const DAY = 86400000;
const bg = (over = {}) => ({
  sessionId: '3a1d168c-7b90-4221-ab14-e6afb5d56f74', shortId: '3a1d168c',
  cwd: '/repos/forge', name: 'Check Forge status', state: 'blocked',
  status: null, pid: 1, startedAt: Date.now() - 9.8 * DAY, ...over,
});

// ── the list ────────────────────────────────────────────────────────────
test('lists a background session with its age, state and project', () => {
  const f = render(<BackgroundSessions background={[bg()]} theme={theme} width={90} />).lastFrame();
  assert.match(f, /3a1d168c/, 'the id is shown');
  assert.match(f, /9\.8d/, 'the age is shown');
  assert.match(f, /blocked/, 'the state is shown');
  assert.match(f, /forge/, 'the project is shown');
});

test('an unreadable list says unknown, never "none"', () => {
  const f = render(<BackgroundSessions background={null} theme={theme} width={90} />).lastFrame();
  assert.match(f, /unknown, not empty/i, 'it says it could not look');
  assert.doesNotMatch(f, /^None\./m, 'it must not claim there are none');
});

test('a genuinely empty list does say none', () => {
  const f = render(<BackgroundSessions background={[]} theme={theme} width={90} />).lastFrame();
  assert.match(f, /None\./, 'empty is empty');
});

// ── deleting a conversation takes two deliberate presses ────────────────
test('one X arms, a second X on the SAME row removes', async () => {
  const removed = [];
  const { stdin, lastFrame } = render(
    <BackgroundSessions background={[bg()]} theme={theme} width={90} onRemove={(id) => removed.push(id)} />,
  );
  stdin.write('X');
  await new Promise((r) => setTimeout(r, 40));
  assert.match(lastFrame(), /press X again/, 'the first press only arms');
  assert.equal(removed.length, 0, 'nothing removed yet');
  stdin.write('X');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(removed.length, 1, 'the second press removes');
  assert.equal(removed[0], bg().sessionId);
});

test('moving off the row disarms, so a stray X cannot delete', async () => {
  const removed = [];
  const rows = [bg(), bg({ sessionId: '93c118d4-3ae6-4dc0-bbcb-cd55273f3bee', shortId: '93c118d4' })];
  const { stdin, lastFrame } = render(
    <BackgroundSessions background={rows} theme={theme} width={90} onRemove={(id) => removed.push(id)} />,
  );
  stdin.write('X');                                   // arm row 1
  await new Promise((r) => setTimeout(r, 40));
  stdin.write('j');                                   // move to row 2
  await new Promise((r) => setTimeout(r, 40));
  assert.doesNotMatch(lastFrame(), /press X again/, 'moving disarmed it');
  stdin.write('X');                                   // this only ARMS row 2
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(removed.length, 0, 'no conversation was deleted by a single press');
});

// ── the always-visible indicator ────────────────────────────────────────
// Colour codes sit between the label and the number, so strip them before
// matching — otherwise a passing assertion depends on where Ink split its runs.
const stripAnsi = (t) => String(t || '').replace(/\u001b\[[0-9;]*m/g, '');
const agg = (background) => stripAnsi(render(
  <Aggregate agents={[]} fleetTpm={0} aggSpark={[0]} theme={theme} usage={null}
             fmtReset={() => ''} weekCost={0} background={background} />,
).lastFrame());

test('the fleet row shows how many sessions run outside the fleet', () => {
  assert.match(agg([bg(), bg()]), /bg\s*2/, 'the count is on screen');
});

test('the fleet row flags a stale one, and does not flag a working one', () => {
  assert.match(agg([bg()]), /9d idle/, 'a 9.8-day blocked session is called out');
  const working = agg([bg({ state: 'working', startedAt: Date.now() - 20 * DAY })]);
  assert.doesNotMatch(working, /idle/, 'a session that is working is not stale, however old');
});

test('the fleet row shows ? when the list could not be read', () => {
  const f = agg(null);
  assert.match(f, /bg\s*\?/, 'unknown is shown as unknown');
  assert.doesNotMatch(f, /bg\s*0/, 'never a confident zero');
});

// ── the helpers ─────────────────────────────────────────────────────────
test('staleBackgroundSessions returns null for an unknown list', () => {
  assert.equal(staleBackgroundSessions(null), null);
});

test('removeSession refuses an id of an unexpected shape, spawning nothing', async () => {
  const r = await removeSession('../../etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected shape/);
});
