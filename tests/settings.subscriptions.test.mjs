// tests/settings.subscriptions.test.mjs — task 0420: the SUBSCRIPTIONS tab is
// declared in SETTINGS_SCHEMA like every other tab, its keys go through
// SETTINGS_DEFAULTS + sanitizeSettings, and inserting it must not move any
// existing tab's number hotkey.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-settings-subs-'));
process.env.MC_CONFIG_DIR = sandbox;
const FILE = join(sandbox, 'settings.json');

const { SETTINGS_SCHEMA, SETTINGS_DEFAULTS, sanitizeSettings, loadSettings } =
  await import('../tui/lib/settings.js');
const { getProvider } = await import('../server/providers/index.mjs');

const section = (id) => SETTINGS_SCHEMA.find(s => s.id === id);
const item = (key) => SETTINGS_SCHEMA.flatMap(s => s.items || []).find(i => i.key === key);

test('the new subscription keys have the planned defaults', () => {
  assert.equal(SETTINGS_DEFAULTS.subscriptions_cursor_enabled, false);
  assert.equal(SETTINGS_DEFAULTS.defaultProvider, 'claude');
  assert.equal(SETTINGS_DEFAULTS.cursorDefaultModel, 'auto');
  assert.equal(SETTINGS_DEFAULTS.cursorDefaultMode, 'default');
  assert.equal(SETTINGS_DEFAULTS.cursorStatusHooks, false);
  assert.equal(SETTINGS_DEFAULTS.cursorAutoTrust, false);
  assert.equal(SETTINGS_DEFAULTS.cursorUsageSync, true);
});

test('SUBSCRIPTIONS sits immediately before NOTES, so tabs 1..7 keep their numbers', () => {
  const ids = SETTINGS_SCHEMA.map(s => s.id);
  assert.deepEqual(ids, ['general', 'layout', 'colors', 'alerts', 'safety', 'plugins', 'feedback', 'subscriptions', 'notes']);
  assert.equal(section('subscriptions').title, 'SUBSCRIPTIONS');
  // Every tab stays reachable from the single-digit /^[1-9]$/ hotkey.
  assert.ok(SETTINGS_SCHEMA.length <= 9, `${SETTINGS_SCHEMA.length} tabs — the 1-9 hotkey no longer reaches them all`);
});

test('the SUBSCRIPTIONS rows, in order', () => {
  const rows = section('subscriptions').items.map(i => [i.key, i.kind]);
  assert.deepEqual(rows, [
    ['sub_claude_status', 'action'],
    ['sub_cursor_status', 'action'],
    ['subscriptions_cursor_enabled', 'toggle'],
    ['cursorDefaultModel', 'cycle'],
    ['cursorDefaultMode', 'cycle'],
    ['cursorStatusHooks', 'toggle'],
    ['cursorUsageSync', 'toggle'],
    ['cursorAutoTrust', 'toggle'],
    ['defaultProvider', 'cycle'],
  ]);
  assert.match(item('cursorStatusHooks').desc, /Unused for now|hooks\.json/);
  assert.match(item('cursorUsageSync').desc, /claude-mc/);
  assert.match(item('cursorAutoTrust').desc, /--trust/);
});

test('cursor default model is a live function that always offers auto and no Claude ids', () => {
  const opts = item('cursorDefaultModel').options;
  assert.equal(typeof opts, 'function');
  const list = opts();
  assert.equal(list[0], 'auto');
  assert.ok(!list.includes('sonnet-4.6'), `no Claude model leaks into the Cursor cycler: ${list}`);
  assert.ok(list.every(id => !id.includes(':')), 'stored bare, without the cursor: namespace');
});

test('cursor default mode cycles the Cursor-native modes', () => {
  assert.deepEqual(item('cursorDefaultMode').options, getProvider('cursor').permissionModes);
});

test('default subscription cycles provider ids and labels them by provider label', () => {
  const it = item('defaultProvider');
  assert.deepEqual(it.options, ['claude', 'cursor']);
  assert.equal(it.format('claude'), 'Claude Code');
  assert.equal(it.format('cursor'), 'Cursor');
});

test('sanitizeSettings coerces the new keys', () => {
  const s = sanitizeSettings({
    subscriptions_cursor_enabled: 'false', cursorStatusHooks: 0, cursorAutoTrust: 1,
    cursorUsageSync: 'true', defaultProvider: 'openai', cursorDefaultModel: 42,
    cursorDefaultMode: 'yolo',
  });
  assert.equal(s.subscriptions_cursor_enabled, false);
  assert.equal(s.cursorStatusHooks, false);
  assert.equal(s.cursorAutoTrust, true);
  assert.equal(s.cursorUsageSync, true);
  assert.equal(s.defaultProvider, 'claude', 'an unknown provider id falls back to claude');
  assert.equal(s.cursorDefaultModel, 'auto');
  assert.equal(s.cursorDefaultMode, 'default');
  assert.equal(sanitizeSettings({ defaultProvider: 'cursor' }).defaultProvider, 'cursor');
  assert.equal(sanitizeSettings({ cursorDefaultModel: 'composer-2.5' }).cursorDefaultModel, 'composer-2.5');
});

test('status rows are display-only: sanitize never writes them into settings', () => {
  writeFileSync(FILE, JSON.stringify({}));
  const s = loadSettings();
  assert.ok(!('sub_claude_status' in s));
  assert.ok(!('sub_cursor_status' in s));
});
