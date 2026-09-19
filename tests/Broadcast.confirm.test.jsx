// tests/Broadcast.confirm.test.jsx — 0408/I5. "Confirm before broadcast"
// (settings.broadcastConfirm, ON by default) existed as a toggle and did
// nothing — one Enter blasted every session. Now: with confirm on, the first
// Enter arms a "send to N sessions? ↵ again to confirm" line, the second
// Enter sends, and any edit to the text or target set disarms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0408-broadcast');
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: Broadcast } = await import('../tui/modals/Broadcast.jsx');
const { default: App } = await import('../tui/App.jsx');
const { THEMES } = await import('../tui/lib/themes.js');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const theme = THEMES['BlueArch'];
const agents = [
  { id: 'a1', slot: 1, status: 'idle', name: 'one' },
  { id: 'a2', slot: 2, status: 'idle', name: 'two' },
  { id: 'e3', slot: 3, status: 'empty' },
];

function mountModal({ confirm }) {
  const sent = [];
  const r = render(React.createElement(Broadcast, {
    agents, theme, confirm, rows: 40,
    onSend: (text, ids) => sent.push([text, ids]),
    onClose: () => {},
  }));
  return { ...r, sent };
}

test('I5: confirm on — first Enter arms, second Enter sends', async () => {
  const { stdin, lastFrame, sent, unmount } = mountModal({ confirm: true });
  await tick(); await tick();
  stdin.write('deploy now'); await tick();
  stdin.write('\r'); await tick(); await tick();
  assert.equal(sent.length, 0, 'first Enter must not send');
  assert.match(strip(lastFrame()), /send to 2 sessions\? .* again to confirm/, 'confirm line shows the target count');
  stdin.write('\r'); await tick(); await tick();
  assert.equal(sent.length, 1, 'second Enter sends');
  assert.equal(sent[0][0], 'deploy now');
  assert.deepEqual([...sent[0][1]].sort(), ['a1', 'a2']);
  unmount();
});

test('I5: editing the text after arming disarms — the next Enter re-arms instead of sending', async () => {
  const { stdin, lastFrame, sent, unmount } = mountModal({ confirm: true });
  await tick(); await tick();
  stdin.write('deploy'); await tick();
  stdin.write('\r'); await tick();               // arm
  assert.match(strip(lastFrame()), /again to confirm/);
  stdin.write(' later'); await tick();           // edit → disarm
  stdin.write('\r'); await tick(); await tick(); // re-arm, must NOT send
  assert.equal(sent.length, 0, 'an edit between Enters must reset the confirmation');
  assert.match(strip(lastFrame()), /again to confirm/);
  unmount();
});

test('I5: confirm off — a single Enter sends immediately (legacy behavior)', async () => {
  const { stdin, sent, unmount } = mountModal({ confirm: false });
  await tick(); await tick();
  stdin.write('go'); await tick();
  stdin.write('\r'); await tick(); await tick();
  assert.equal(sent.length, 1);
  unmount();
});

test('I5: App passes the default-on setting through — b, type, Enter does not broadcast until confirmed', async () => {
  const fleet = new FakeFleet([1, 2]);
  const { stdin, lastFrame, unmount } = render(React.createElement(App, {
    fleet, auth: { ok: true, plan: 'mock', account: 'test', source: 'env' },
  }));
  await tick(); await tick();
  stdin.write('b'); await tick(); await tick();
  assert.match(strip(lastFrame()), /BROADCAST/);
  stdin.write('ship it'); await tick();
  stdin.write('\r'); await tick(); await tick();
  assert.ok(!fleet.calls.some(c => c[0] === 'broadcast'), 'first Enter must not broadcast');
  assert.match(strip(lastFrame()), /again to confirm/);
  stdin.write('\r'); await tick(); await tick();
  const call = fleet.calls.find(c => c[0] === 'broadcast');
  assert.ok(call, 'second Enter broadcasts');
  assert.equal(call[2], 'ship it');
  unmount();
});
