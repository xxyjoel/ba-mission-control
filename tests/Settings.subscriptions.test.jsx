// tests/Settings.subscriptions.test.jsx — task 0420, the SUBSCRIPTIONS tab.
//
// Two things are pinned here:
//   1. Seamless: every pre-existing tab renders the frame captured before 0420
//      (tests/fixtures/ui-baseline-0420.mjs). The only intended difference is
//      the footer's tab count (`1–8 jump` → `1–9 jump`), because a ninth tab
//      now exists. NOTES keeps its body and moves from key 8 to key 9.
//   2. The new tab: auth probes run once, when the tab is first opened (never
//      for other tabs), through injected fake providers — no real CLI runs.
import '../tests/lib/force-color.js';
import React, { useState } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mc-settings-subs-ui-'));

const { render } = await import('ink-testing-library');
const { default: Settings } = await import('../tui/modals/Settings.jsx');
const { THEMES } = await import('../tui/lib/themes.js');
const { SETTINGS_DEFAULTS } = await import('../tui/lib/settings.js');
const { applyPluginDefaults } = await import('../tui/lib/plugins.js');
const BASE = await import('./fixtures/ui-baseline-0420.mjs');

const theme = THEMES['BlueArch'];
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const defaults = () => applyPluginDefaults({ ...SETTINGS_DEFAULTS });

function fakeProvider(id, { installed = true, auth = { ok: true, email: `${id}@example.com`, plan: null } } = {}) {
  const p = {
    id,
    label: id === 'claude' ? 'Claude Code' : 'Cursor',
    short: id === 'claude' ? 'CC' : 'CUR',
    bin: () => (id === 'claude' ? 'claude' : 'cursor-agent'),
    loginArgv: id === 'claude' ? ['auth', 'login'] : ['login'],
    logoutArgv: id === 'claude' ? ['auth', 'logout'] : ['logout'],
    permissionModes: ['default'],
    capabilities: {},
    calls: { installed: 0, auth: 0 },
    async probeInstalled() { p.calls.installed++; return installed ? { ok: true, version: '1.0' } : { ok: false, error: 'ENOENT' }; },
    async probeAuth() { p.calls.auth++; return typeof auth === 'function' ? auth() : auth; },
  };
  return p;
}

function fakes(cursor = {}) {
  return [
    fakeProvider('claude', { auth: { ok: true, email: 'joel@example.com', plan: 'max' } }),
    fakeProvider('cursor', cursor),
  ];
}

// Stateful host so toggles actually re-render, and every write is recorded.
function Host({ initial, writes, ...props }) {
  const [settings, setS] = useState(initial);
  return <Settings settings={settings} setSettings={(s) => { writes.push(s); setS(s); }} onClose={() => {}} theme={theme} width={92} {...props} />;
}

async function open(props = {}, keys = []) {
  const writes = [];
  const inst = render(<Host initial={props.initial || defaults()} writes={writes} rows={props.rows ?? 40} {...props} />);
  await tick();
  for (const k of keys) { inst.stdin.write(k); await tick(); }
  return { ...inst, writes };
}

const withNineTabs = (frame) => {
  const re = /1–8((?:\x1b\[[0-9;]*m)*) jump/;
  assert.match(frame, re, 'baseline footer carries the tab count');
  return frame.replace(re, '1–9$1 jump');
};

// Body-only compare: the tab strip now scrolls to keep the active label fully
// visible (NOTES was clipping to "NOT"), so byte-identical strip frames are
// no longer the gate. Strip the tab row and still demand the body match.
function bodyAfterTabs(frame) {
  const lines = String(frame || '').split('\n');
  // Row with `[1] GENERAL` (or a scrolled window starting later) is the strip.
  const i = lines.findIndex((l) => /\[\d+\]\s+[A-Z]/.test(strip(l)));
  if (i < 0) return frame;
  return lines.slice(i + 1).join('\n');
}

for (const rows of [40, 24]) {
  for (let t = 1; t <= 7; t++) {
    test(`seamless: tab ${t} at ${rows} rows keeps the pre-0420 body (tab strip may scroll)`, async () => {
      const providers = fakes();
      const { lastFrame, unmount } = await open({ providers, rows }, [String(t)]);
      const got = bodyAfterTabs(lastFrame());
      const want = bodyAfterTabs(withNineTabs(BASE[`settings_r${rows}_tab${t}`]));
      assert.equal(got, want);
      assert.equal(providers[0].calls.auth + providers[1].calls.auth, 0, 'no auth probe outside SUBSCRIPTIONS');
      unmount();
    });
  }
  test(`seamless: NOTES at ${rows} rows moved to key 9 with an unchanged body`, async () => {
    const { lastFrame, unmount } = await open({ providers: fakes(), rows }, ['9']);
    const got = bodyAfterTabs(lastFrame());
    const want = bodyAfterTabs(withNineTabs(BASE[`settings_r${rows}_tab8`]));
    assert.equal(got, want);
    assert.match(strip(lastFrame()), /\[9\] NOTES/, 'active NOTES label is fully visible');
    unmount();
  });
}

test('tab strip: active NOTES is fully visible (not clipped to NOT)', async () => {
  const { lastFrame, unmount } = await open({ providers: fakes(), rows: 40 }, ['9']);
  const f = strip(lastFrame());
  assert.match(f, /\[9\] NOTES/);
  assert.doesNotMatch(f, /\[9\] NOT(?:\s|$)/);
  unmount();
});

test('tab strip: active SUBSCRIPTIONS is fully visible', async () => {
  const { lastFrame, unmount } = await open({ providers: fakes(), rows: 40 }, ['8']);
  assert.match(strip(lastFrame()), /\[8\] SUBSCRIPTIONS/);
  unmount();
});

test('seamless: opening Settings never probes auth (boot and other tabs stay fast)', async () => {
  const providers = fakes();
  const { unmount } = await open({ providers }, ['1', '2', '\t', '\t', 'j', 'k']);
  await tick(60);
  assert.equal(providers[0].calls.auth + providers[1].calls.auth, 0);
  assert.equal(providers[0].calls.installed + providers[1].calls.installed, 0);
  unmount();
});

test('the footer names all nine tabs and key 8 reaches SUBSCRIPTIONS', async () => {
  const { lastFrame, unmount } = await open({ providers: fakes() }, ['8']);
  const f = strip(lastFrame());
  assert.match(f, /1–9 jump/);
  assert.match(f, /Claude Code/);
  assert.match(f, /Default subscription/);
  unmount();
});

test('status rows show checking… until the probe resolves', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const providers = fakes({ auth: () => gate.then(() => ({ ok: true, email: 'c@example.com', plan: null })) });
  const { lastFrame, unmount } = await open({ providers }, ['8']);
  assert.match(strip(lastFrame()), /Cursor\s+◌ checking…/);
  release();
  await tick(60);
  assert.match(strip(lastFrame()), /Cursor\s+● connected · c@example\.com\s+↵ disconnect/);
  unmount();
});

test('connected state: account, plan and a disconnect action', async () => {
  const providers = fakes({ auth: { ok: true, email: 'c@example.com', plan: 'pro' } });
  const { lastFrame, unmount } = await open({ providers }, ['8']);
  await tick(60);
  const f = strip(lastFrame());
  assert.match(f, /▶ Claude Code\s+● connected · joel@example\.com · max/);
  assert.match(f, /Cursor\s+● connected · c@example\.com · pro\s+↵ disconnect/);
  unmount();
});

test('not-connected state offers ↵ connect', async () => {
  const providers = fakes({ auth: { ok: false, email: null, plan: null, error: 'not logged in' } });
  const { lastFrame, unmount } = await open({ providers }, ['8']);
  await tick(60);
  assert.match(strip(lastFrame()), /Cursor\s+○ not connected\s+↵ connect/);
  unmount();
});

test('not-installed state names the missing binary and skips the auth probe', async () => {
  const providers = fakes({ installed: false });
  const { lastFrame, unmount } = await open({ providers }, ['8']);
  await tick(60);
  assert.match(strip(lastFrame()), /Cursor\s+○ not installed — install cursor-agent/);
  assert.equal(providers[1].calls.auth, 0);
  unmount();
});

test('probes run once per open: leaving and re-entering the tab does not re-probe', async () => {
  const providers = fakes();
  const { unmount } = await open({ providers }, ['8', '1', '8', '\t', '\t']);
  await tick(60);
  assert.equal(providers[0].calls.auth, 1);
  assert.equal(providers[1].calls.auth, 1);
  unmount();
});

test('probe results are reported upward so App can cache them', async () => {
  const seen = [];
  const { unmount } = await open({ providers: fakes(), onProbed: (id, st) => seen.push([id, st.state]) }, ['8']);
  await tick(60);
  assert.deepEqual(seen.sort(), [['claude', 'connected'], ['cursor', 'connected']]);
  unmount();
});

test('enabling Cursor while it is not installed does not flip the toggle', async () => {
  const r = await open({ providers: fakes({ installed: false }) }, ['8']);
  await tick(60);
  for (const k of ['j', 'j', ' ', '\x1b[C']) { r.stdin.write(k); await tick(); }
  assert.equal(r.writes.filter(w => w.subscriptions_cursor_enabled === true).length, 0);
  const f = strip(r.lastFrame());
  assert.match(f, /Cursor · enabled\s+\[ \] off/);
  assert.match(f, /install cursor-agent/);
  r.unmount();
});

test('enabling Cursor when installed flips the toggle', async () => {
  const r = await open({ providers: fakes({ auth: { ok: false } }) }, ['8']);
  await tick(60);
  for (const k of ['j', 'j', ' ']) { r.stdin.write(k); await tick(); }
  assert.equal(r.writes.at(-1).subscriptions_cursor_enabled, true);
  assert.match(strip(r.lastFrame()), /Cursor · enabled\s+\[●\] on/);
  r.unmount();
});

test('↵ on a not-connected Cursor row asks App to connect; ←/→ do nothing', async () => {
  const connects = [];
  const r = await open({ providers: fakes({ auth: { ok: false } }), onConnect: (id) => connects.push(id) }, ['8']);
  await tick(60);
  for (const k of ['j', '\x1b[C', '\x1b[D']) { r.stdin.write(k); await tick(); }
  assert.deepEqual(connects, []);
  assert.equal(r.writes.length, 0, 'arrows on an action row write nothing');
  r.stdin.write('\r'); await tick();
  assert.deepEqual(connects, ['cursor']);
  r.unmount();
});

test('↵ on a not-connected Claude row connects claude too', async () => {
  const connects = [];
  const providers = [fakeProvider('claude', { auth: { ok: false } }), fakeProvider('cursor')];
  const r = await open({ providers, onConnect: (id) => connects.push(id) }, ['8']);
  await tick(60);
  r.stdin.write(' '); await tick();
  assert.deepEqual(connects, ['claude']);
  r.unmount();
});

test('disconnect confirms y/n, runs logout argv, reports, and re-probes', async () => {
  let authed = true;
  const providers = fakes({ auth: () => ({ ok: authed, email: authed ? 'c@example.com' : null, plan: null }) });
  const logouts = [];
  const disconnected = [];
  const runLogout = async (p) => { logouts.push([p.bin(), p.logoutArgv]); authed = false; };
  const r = await open({ providers, runLogout, onDisconnected: (id) => disconnected.push(id) }, ['8']);
  await tick(60);
  r.stdin.write('j'); await tick();
  r.stdin.write('\r'); await tick();
  assert.match(strip(r.lastFrame()), /disconnect Cursor\? y\/n/);
  // n cancels without running anything.
  r.stdin.write('n'); await tick();
  assert.deepEqual(logouts, []);
  assert.doesNotMatch(strip(r.lastFrame()), /disconnect Cursor\?/);
  // Ask again and accept.
  r.stdin.write('\r'); await tick();
  r.stdin.write('y'); await tick(80);
  assert.deepEqual(logouts, [['cursor-agent', ['logout']]]);
  assert.deepEqual(disconnected, ['cursor']);
  assert.equal(providers[1].calls.auth, 2, 're-probed after logout');
  assert.match(strip(r.lastFrame()), /Cursor\s+○ not connected\s+↵ connect/);
  r.unmount();
});

test('esc during a disconnect confirm cancels the confirm and keeps Settings open', async () => {
  let closed = false;
  const r = await open({ providers: fakes(), onClose: () => { closed = true; } }, ['8']);
  await tick(60);
  for (const k of ['j', '\r']) { r.stdin.write(k); await tick(); }
  r.stdin.write('\x1b'); await tick(60);
  assert.equal(closed, false);
  assert.doesNotMatch(strip(r.lastFrame()), /disconnect Cursor\?/);
  r.unmount();
});

test('initialTab opens straight onto SUBSCRIPTIONS and probes (the return-from-login path)', async () => {
  const providers = fakes();
  const r = await open({ providers, initialTab: 'subscriptions' });
  await tick(60);
  assert.match(strip(r.lastFrame()), /Cursor\s+● connected/);
  assert.equal(providers[1].calls.auth, 1);
  r.unmount();
});

test('default subscription shows the provider label and cycles ids', async () => {
  const r = await open({ providers: fakes() }, ['8']);
  await tick(60);
  for (let i = 0; i < 8; i++) { r.stdin.write('j'); await tick(); }
  assert.match(strip(r.lastFrame()), /▶ Default subscription\s+◀ Claude Code ▶/);
  r.stdin.write('\x1b[C'); await tick();
  assert.equal(r.writes.at(-1).defaultProvider, 'cursor');
  assert.match(strip(r.lastFrame()), /Default subscription\s+◀ Cursor ▶/);
  r.unmount();
});

test('80×24: SUBSCRIPTIONS fits the modal budget and the last row is reachable', async () => {
  // App chrome around the modal is 5 rows (0408/I6 math), so the modal gets 19.
  const r = await open({ providers: fakes(), rows: 24 }, ['8']);
  await tick(60);
  assert.ok(strip(r.lastFrame()).split('\n').length <= 19, strip(r.lastFrame()));
  for (let i = 0; i < 8; i++) { r.stdin.write('j'); await tick(); }
  const f = strip(r.lastFrame());
  assert.ok(f.split('\n').length <= 19, f);
  assert.match(f, /▶ Default subscription/);
  r.unmount();
});
