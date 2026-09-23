// tests/App.subscriptions.test.jsx — task 0420, App's routing between
// Settings → SUBSCRIPTIONS, the Connect (login) modal and New Session.
//
// App takes injectable `providers` and `loginSpawn` props so these tests run
// fake probes and a fake PTY; no claude or cursor-agent process is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CFG = mkdtempSync(join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0420-app-'));
process.env.MC_CONFIG_DIR = CFG;
process.env.REPO_PARENTS = mkdtempSync(join(tmpdir(), 'mc-0420-repos-'));

const React = await import('react');
const { render } = await import('ink');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');

class Stdout extends EventEmitter {
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows; this.last = ''; }
  write = (f) => { this.last = f; };
}
class Stderr extends EventEmitter { write = () => {}; }
class Stdin extends EventEmitter {
  isTTY = true; data = null;
  write = (d) => { this.data = d; this.emit('readable'); this.emit('data', d); };
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read = () => { const d = this.data; this.data = null; return d; };
}

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };

function fakeProvider(id, auth) {
  const p = {
    id, label: id === 'claude' ? 'Claude Code' : 'Cursor', short: id,
    bin: () => (id === 'claude' ? 'claude' : 'cursor-agent'),
    loginArgv: id === 'claude' ? ['auth', 'login'] : ['login'],
    logoutArgv: ['logout'], permissionModes: ['default'], capabilities: {},
    calls: 0,
    async probeInstalled() { return { ok: true, version: '1' }; },
    async probeAuth() { p.calls++; return typeof auth === 'function' ? auth() : auth; },
  };
  return p;
}

function writeSettings(obj) { writeFileSync(join(CFG, 'settings.json'), JSON.stringify(obj)); }

async function boot(props) {
  const stdout = new Stdout(120, 40), stdin = new Stdin(), stderr = new Stderr();
  const inst = render(React.createElement(App, { fleet: new FakeFleet([]), auth: AUTH, ...props }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  await tick(); await tick();
  return {
    frame: () => strip(stdout.last),
    press: async (...ks) => { for (const k of ks) { stdin.write(k); await tick(); } await tick(60); },
    unmount: async () => { inst.unmount(); await tick(10); },
  };
}

test('only Claude enabled: New Session has no subscription row and Cursor is never probed', async () => {
  writeSettings({ subscriptions_cursor_enabled: false });
  const cursor = fakeProvider('cursor', { ok: true, email: 'c@x' });
  const app = await boot({ providers: [fakeProvider('claude', { ok: true }), cursor] });
  await app.press('n');
  assert.match(app.frame(), /NEW SESSION/);
  assert.doesNotMatch(app.frame(), /subscription ◀/);
  assert.equal(cursor.calls, 0);
  await app.unmount();
});

test('Cursor enabled + connected: the probe runs lazily on New Session and the row appears', async () => {
  writeSettings({ subscriptions_cursor_enabled: true, defaultProvider: 'cursor', cursorDefaultModel: 'auto' });
  const cursor = fakeProvider('cursor', { ok: true, email: 'c@x' });
  const app = await boot({ providers: [fakeProvider('claude', { ok: true }), cursor] });
  assert.equal(cursor.calls, 0, 'never probed at boot');
  await app.press('n');
  await tick(60);
  const f = app.frame();
  assert.match(f, /subscription ◀ Cursor ▶/, 'initialProvider = settings.defaultProvider');
  assert.match(f, /model ◀ auto ▶/, 'cursor default model = cursor:<cursorDefaultModel>, shown without the namespace');
  assert.equal(cursor.calls, 1);
  // Reopening uses the cached result — no second probe.
  await app.press('\x1b');
  await app.press('n');
  assert.equal(cursor.calls, 1);
  await app.unmount();
});

test('Cursor enabled but not connected: treated as unavailable, no subscription row', async () => {
  writeSettings({ subscriptions_cursor_enabled: true });
  const cursor = fakeProvider('cursor', { ok: false });
  const app = await boot({ providers: [fakeProvider('claude', { ok: true }), cursor] });
  await app.press('n');
  await tick(60);
  assert.doesNotMatch(app.frame(), /subscription ◀/);
  await app.unmount();
});

test('Connect opens the login PTY; on exit Settings returns on SUBSCRIPTIONS and re-probes', async () => {
  writeSettings({});
  let authed = false;
  const cursor = fakeProvider('cursor', () => ({ ok: authed, email: authed ? 'c@x' : null }));
  const rec = { calls: [], exit: null };
  const loginSpawn = (file, args) => {
    rec.calls.push([file, args]);
    return { pid: 1, onData() { return { dispose() {} }; }, onExit(cb) { rec.exit = cb; return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
  };
  const connected = [];
  const app = await boot({ providers: [fakeProvider('claude', { ok: true }), cursor], loginSpawn, onProviderConnected: (id) => connected.push(id) });
  await app.press(',', '8');
  await tick(60);
  assert.match(app.frame(), /Cursor\s+○ not connected\s+↵ connect/);
  await app.press('j', '\r');
  assert.deepEqual(rec.calls, [['cursor-agent', ['login']]]);
  assert.match(app.frame(), /connect Cursor · cursor-agent login/);
  authed = true;
  rec.exit({ exitCode: 0 });
  await tick(100);
  const f = app.frame();
  assert.match(f, /SETTINGS/);
  assert.match(f, /Cursor\s+● connected · c@x/, 're-probed on return');
  assert.deepEqual(connected, ['cursor']);
  await app.unmount();
});

test('Settings discovering Cursor already connected auto-enables it for New Session', async () => {
  writeSettings({ subscriptions_cursor_enabled: false });
  const cursor = fakeProvider('cursor', { ok: true, email: 'c@x' });
  const app = await boot({ providers: [fakeProvider('claude', { ok: true }), cursor] });
  await app.press(',', '8');
  await tick(80);
  assert.match(app.frame(), /Cursor\s+● connected/);
  await app.press('\x1b'); // close settings
  await app.press('n');
  await tick(80);
  assert.match(app.frame(), /subscription ◀/, 'New Session offers Cursor after connect probe auto-enabled it');
  await app.unmount();
});
