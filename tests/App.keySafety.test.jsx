// tests/App.keySafety.test.jsx — 0408/I1 (+ the toast-sanitize sliver of S3).
//
// The kill chord used to accept lowercase 'k': with vim keys on, an "up"
// press on the top row fell through the no-op nav and ARMED — a second
// press killed the session. 'a' approved (a billed, authorising turn) on
// ANY live session. 'p' SIGSTOPped silently. All three are now safe:
// uppercase-K-only chord, approve gated on status==='waiting', pause toasts.
//
// Evidence before the fix: scratchpad probeA.dictation.test.jsx A4/A5/A6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Sandbox the config dir BEFORE App (→ configDir.js) is imported.
const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0408-keysafety');
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const mount = (fleet, auth = AUTH) =>
  render(React.createElement(App, { fleet, auth }));

test('I1: lowercase k twice on a single live card does NOT arm and does NOT kill', async () => {
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('k'); await tick();
  const frame1 = strip(lastFrame());
  assert.doesNotMatch(frame1, /press K .*again to kill/, 'lowercase k must not arm the kill');
  stdin.write('k'); await tick(); await tick();
  assert.ok(!fleet.calls.some(c => c[0] === 'kill'), 'lowercase k twice must not kill');
  unmount();
});

test('I1: with six cards and focus at the top row, repeated vim-up k presses never kill', async () => {
  const fleet = new FakeFleet([1, 2, 3, 4, 5, 6]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('6'); await tick();
  for (let i = 0; i < 3; i++) { stdin.write('k'); await tick(); }
  await tick();
  assert.ok(!fleet.calls.some(c => c[0] === 'kill'), 'k-k-k from slot 6 must never kill anything');
  assert.doesNotMatch(strip(lastFrame()), /press K .*again to kill/, 'no arm state either');
  unmount();
});

test('I1: uppercase K twice still arms then kills (the chord itself is intact)', async () => {
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('K'); await tick();
  assert.match(strip(lastFrame()), /press K \(shift\+k\) again to kill slot 1/, 'first K arms with the uppercase hint');
  stdin.write('K'); await tick(); await tick();
  assert.ok(fleet.calls.some(c => c[0] === 'kill' && c[1] === 's1-fake'), 'second K kills');
  unmount();
});

test('I1: a (approve) on a non-waiting session warns and sends nothing', async () => {
  const fleet = new FakeFleet([1]); // status idle
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('a'); await tick(); await tick();
  assert.ok(!fleet.calls.some(c => c[0] === 'approve'), 'approve must not fire on an idle session');
  assert.match(strip(lastFrame()), /approve only applies when waiting/, 'warn toast explains the gate');
  unmount();
});

test('I1: a (approve) on a WAITING session still approves', async () => {
  const fleet = new FakeFleet({ 1: 'waiting' });
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('a'); await tick(); await tick();
  assert.ok(fleet.calls.some(c => c[0] === 'approve' && c[1] === 1), 'approve fires when waiting');
  assert.match(strip(lastFrame()), /approve → slot 1/);
  unmount();
});

test('I1: :approve verb follows the same waiting gate', async () => {
  const fleet = new FakeFleet([1]); // idle
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write(':'); await tick();
  stdin.write('approve'); await tick();
  stdin.write('\r'); await tick(); await tick();
  assert.ok(!fleet.calls.some(c => c[0] === 'approve'));
  assert.match(strip(lastFrame()), /approve only applies when waiting/);
  unmount();
});

test('I1: p pauses WITH a toast (it used to be silent)', async () => {
  const fleet = new FakeFleet([1]);
  const { stdin, lastFrame, unmount } = mount(fleet);
  await tick(); await tick();
  stdin.write('p'); await tick(); await tick();
  assert.ok(fleet.calls.some(c => c[0] === 'pause' && c[1] === 1), 'pause fires');
  assert.match(strip(lastFrame()), /paused slot 1/, 'and says so');
  unmount();
});

test('S3 sliver: toast text is sanitized at push time (no raw escape sequences reach the frame)', async () => {
  const fleet = new FakeFleet([1]);
  // The boot toast renders authSummary(auth) — feed it an email carrying an
  // OSC-52 clipboard write. humanize() must strip it before it is painted.
  const evil = { ok: true, email: 'evil\x1b]52;c;aGVsbG8=\x07user@example.com', method: 'oauth' };
  const { lastFrame, unmount } = mount(fleet, evil);
  await tick(); await tick();
  const raw = lastFrame() || '';
  assert.ok(!raw.includes('\x1b]52'), 'OSC-52 sequence must not reach the terminal');
  assert.match(strip(raw), /user@example\.com/, 'the harmless remainder still shows');
  unmount();
});

test('R5 sliver: a multi-line toast collapses to ONE row (the strip budgets one row per toast)', async () => {
  const fleet = new FakeFleet([1]);
  const evil = { ok: true, email: 'line-one\nline-two\nline-three@example.com', method: 'oauth' };
  const { lastFrame, unmount } = mount(fleet, evil);
  await tick(); await tick();
  const frame = strip(lastFrame());
  // Toast rows carry '●' outside any card border ('┃' rows are card chrome).
  const toastRows = frame.split('\n').filter(l => /●/.test(l) && !/[┃│╔╗]/.test(l));
  assert.equal(toastRows.length, 1, `expected one toast row, got:\n${toastRows.join('\n')}`);
  assert.match(toastRows[0], /line-one line-two line-three@example\.com/, 'newlines collapsed to spaces');
  unmount();
});
