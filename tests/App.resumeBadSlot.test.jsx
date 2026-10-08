// tests/App.resumeBadSlot.test.jsx — 0455. `:resume <bad slot>` used to drop
// the invalid token and fall into the bare-verb branch: it SIGCONTed the
// focused session or restored the focused slot (default 1) and toasted
// success. Now any invalid argument warns with the valid range and does
// nothing. Bare `:resume` is covered by App.resumeRouting.test.jsx.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0455-resume-bad-slot');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;
after(() => rmSync(CFG, { recursive: true, force: true }));

const React = await import('react');
const { render } = await import('ink-testing-library');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const mount = (fleet) => render(React.createElement(App, { fleet, auth: AUTH }));
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

// A saved record for slot 1 — the slot the old fallback acted on.
function seedSlot1() {
  writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({
    version: 2, savedAt: Date.now(), openSlots: [], history: [],
    bySlot: {
      1: {
        slot: 1, name: 'saved-repo', cwd: '/tmp', branch: 'main',
        model: 'claude-sonnet-4-6', permissionMode: 'default',
        sessionId: '11111111-2222-3333-4444-555555555555',
        lastSeen: Date.now(), live: false,
      },
    },
  }, null, 2));
}

const ACTIONS = new Set(['resume(SIGCONT)', 'resumeFromRecord', 'launch']);

for (const bad of ['99', 'abc', '0', '25']) {
  test(`0455: ":resume ${bad}" on an empty fleet warns and restores nothing`, async () => {
    seedSlot1();
    const fleet = new FakeFleet([]);
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, `resume ${bad}`);
    const ts = toasts(lastFrame());
    assert.ok(!fleet.calls.some(c => ACTIONS.has(c[0])), `nothing launched; calls: ${JSON.stringify(fleet.calls)}`);
    assert.ok(ts.some(t => t.includes(bad) && /1-10/.test(t)), `range warning naming "${bad}"; got ${JSON.stringify(ts)}`);
    assert.ok(!ts.some(t => /resumed slot/.test(t)), `no success toast; got ${JSON.stringify(ts)}`);
    unmount();
  });

  test(`0455: ":resume ${bad}" with live focused slot 1 does not SIGCONT it`, async () => {
    const fleet = new FakeFleet([1]);
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, `resume ${bad}`);
    const ts = toasts(lastFrame());
    assert.ok(!fleet.calls.some(c => ACTIONS.has(c[0])), `nothing resumed; calls: ${JSON.stringify(fleet.calls)}`);
    assert.ok(ts.some(t => t.includes(bad) && /1-10/.test(t)), `range warning; got ${JSON.stringify(ts)}`);
    unmount();
  });
}

for (const line of ['resume 1 99', 'resume 1,99']) {
  test(`0455: a mixed list ":${line}" warns about 99 and launches nothing`, async () => {
    seedSlot1();
    const fleet = new FakeFleet([]);
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, line);
    const ts = toasts(lastFrame());
    assert.ok(!fleet.calls.some(c => ACTIONS.has(c[0])), `calls: ${JSON.stringify(fleet.calls)}`);
    assert.ok(ts.some(t => /99/.test(t) && /1-10/.test(t)), `got ${JSON.stringify(ts)}`);
    unmount();
  });
}
