// tests/providers.contract.test.mjs — the provider registry is the one seam a
// slot backend plugs into (task 0420). Every consumer (Fleet, Settings'
// SUBSCRIPTIONS tab, New Session's subscription row, command-verb guards)
// reads only these fields, so the shape is pinned here before anything uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listProviders, getProvider, enabledProviders, cursorModeFor, cursorModeArgs,
  parseCursorStatus, PROVIDER_IDS,
} from '../server/providers/index.mjs';

const REQUIRED = ['id', 'label', 'short', 'bin', 'probeInstalled', 'probeAuth',
  'loginArgv', 'logoutArgv', 'permissionModes', 'capabilities'];

test('claude is listed first and cursor second — order drives every picker', () => {
  assert.deepEqual(listProviders().map(p => p.id), ['claude', 'cursor']);
  assert.deepEqual(PROVIDER_IDS, ['claude', 'cursor']);
});

test('every provider carries the full descriptor shape', () => {
  for (const p of listProviders()) {
    for (const k of REQUIRED) assert.ok(p[k] !== undefined, `${p.id}.${k} is present`);
    assert.equal(typeof p.bin(), 'string');
    assert.ok(Array.isArray(p.loginArgv) && Array.isArray(p.logoutArgv));
    assert.ok(Array.isArray(p.permissionModes) && p.permissionModes.length > 0);
  }
});

test('getProvider returns null for an unknown id, never a default', () => {
  assert.equal(getProvider('nope'), null);
  assert.equal(getProvider(undefined), null);
  assert.equal(getProvider('cursor').id, 'cursor');
});

test('claude keeps its existing permission modes in their existing order', () => {
  assert.deepEqual(getProvider('claude').permissionModes,
    ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']);
});

test('cursor uses its own mode names (decision D4)', () => {
  assert.deepEqual(getProvider('cursor').permissionModes,
    ['default', 'plan', 'ask', 'auto-review', 'force']);
});

test('a Claude default permission maps onto the nearest Cursor mode', () => {
  assert.equal(cursorModeFor('plan'), 'plan');
  assert.equal(cursorModeFor('auto'), 'auto-review');
  assert.equal(cursorModeFor('bypassPermissions'), 'force');
  assert.equal(cursorModeFor('acceptEdits'), 'default');
  assert.equal(cursorModeFor('dontAsk'), 'default');
  assert.equal(cursorModeFor(undefined), 'default');
  // A value that is already a Cursor mode passes through.
  assert.equal(cursorModeFor('ask'), 'ask');
});

test('each Cursor mode becomes discrete argv, never a shell string', () => {
  assert.deepEqual(cursorModeArgs('default'), []);
  assert.deepEqual(cursorModeArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(cursorModeArgs('ask'), ['--mode', 'ask']);
  assert.deepEqual(cursorModeArgs('auto-review'), ['--auto-review']);
  assert.deepEqual(cursorModeArgs('force'), ['--force']);
  assert.deepEqual(cursorModeArgs('garbage'), []);
});

test('claude is always enabled; cursor only when its subscription toggle is on', () => {
  assert.deepEqual(enabledProviders({}).map(p => p.id), ['claude']);
  assert.deepEqual(enabledProviders({ subscriptions_cursor_enabled: false }).map(p => p.id), ['claude']);
  assert.deepEqual(enabledProviders({ subscriptions_cursor_enabled: true }).map(p => p.id), ['claude', 'cursor']);
  assert.deepEqual(enabledProviders(undefined).map(p => p.id), ['claude']);
});

test('cursor capabilities say what a Cursor slot cannot do', () => {
  const c = getProvider('cursor').capabilities;
  assert.equal(c.update, false);
  assert.equal(c.compact, false);
  assert.equal(c.modelRefresh, false);
  assert.equal(c.backgroundSessions, false);
  const k = getProvider('claude').capabilities;
  for (const key of ['update', 'compact', 'modelRefresh', 'backgroundSessions', 'costMetered', 'tokensMetered']) {
    assert.equal(k[key], true, `claude.${key}`);
  }
});

// Real `cursor-agent status --format json` output captured 2026-09-22 (email
// replaced).
const STATUS_OK = JSON.stringify({
  status: 'authenticated', isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true,
  userInfo: { email: 'user@example.com', userId: 1, createdAt: '2025-01-16T23:21:16.836Z' },
});

test('parses a logged-in cursor status', () => {
  const r = parseCursorStatus(STATUS_OK);
  assert.equal(r.ok, true);
  assert.equal(r.email, 'user@example.com');
  assert.equal(r.method, 'cursor login');
});

test('a logged-out or unreadable cursor status is not ok and never throws', () => {
  assert.equal(parseCursorStatus(JSON.stringify({ isAuthenticated: false })).ok, false);
  const bad = parseCursorStatus('not json');
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  assert.equal(parseCursorStatus('').ok, false);
});

test('probeAuth uses the injected exec with argv form and resolves, even on failure', async () => {
  const calls = [];
  const exec = async (bin, args) => { calls.push([bin, args]); return STATUS_OK; };
  const r = await getProvider('cursor').probeAuth({ exec });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0][1], ['status', '--format', 'json']);

  const failing = async () => { throw new Error('ENOENT'); };
  const r2 = await getProvider('cursor').probeAuth({ exec: failing });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /ENOENT/);
});

test('probeInstalled reports the version or the failure', async () => {
  const ok = await getProvider('cursor').probeInstalled({ exec: async () => '2026.09.18-9a7762b\n' });
  assert.deepEqual(ok, { ok: true, version: '2026.09.18-9a7762b' });
  const no = await getProvider('cursor').probeInstalled({ exec: async () => { throw new Error('ENOENT'); } });
  assert.equal(no.ok, false);
});

test('CURSOR_AGENT_BIN overrides the binary name', () => {
  const prev = process.env.CURSOR_AGENT_BIN;
  process.env.CURSOR_AGENT_BIN = '/opt/x/cursor-agent';
  try { assert.equal(getProvider('cursor').bin(), '/opt/x/cursor-agent'); }
  finally { if (prev === undefined) delete process.env.CURSOR_AGENT_BIN; else process.env.CURSOR_AGENT_BIN = prev; }
});
