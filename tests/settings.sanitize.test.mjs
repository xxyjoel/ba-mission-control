// tests/settings.sanitize.test.mjs — 0408/I4 regression.
//
// settings.json is hand-editable and tryRead() used to merge raw JSON with
// no validation. Confirmed blast radius (probeC2.settings.jsx):
//   "repoParents": "~/src"        → boot crash (`.join is not a function`)
//   "toastDurationMs": "4000"     → TimeoutOverflowWarning loop, 161 frames/500ms
//   "tickRate": "fast"            → NaN interval → 266 snapshot calls/500ms
//   "syncModelsOnBoot": 0         → still ran boot discovery (`!== false`)
// Every key read off disk is now coerced and clamped against SETTINGS_SCHEMA
// (kind/min/max) and the type of its default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-settings-sane-'));
process.env.MC_CONFIG_DIR = sandbox;
const FILE = join(sandbox, 'settings.json');

const { loadSettings, sanitizeSettings, SETTINGS_DEFAULTS } =
  await import('../tui/lib/settings.js');

function loadWith(raw) {
  writeFileSync(FILE, JSON.stringify(raw));
  return loadSettings();
}

test('the three probeC2 crashers are neutralized at load', () => {
  const s = loadWith({
    repoParents: '~/src',        // crash: string where array expected
    toastDurationMs: '4000',     // toastloop: string number
    tickRate: 'fast',            // tickloop: NaN
  });
  assert.deepEqual(s.repoParents, [], 'non-array repoParents falls back to default []');
  assert.equal(s.toastDurationMs, 4000, 'numeric string coerced to a real number');
  assert.equal(typeof s.toastDurationMs, 'number');
  assert.equal(s.tickRate, SETTINGS_DEFAULTS.tickRate, 'NaN falls back to the default');
});

test('any falsy syncModelsOnBoot means OFF', () => {
  for (const v of [0, false, '', 'false', null]) {
    const s = loadWith({ syncModelsOnBoot: v });
    assert.equal(s.syncModelsOnBoot, false, `syncModelsOnBoot=${JSON.stringify(v)} → off`);
    // main.jsx gates on `!== false`, so the coerced value must be literal false.
    assert.notEqual(s.syncModelsOnBoot !== false, true);
  }
  assert.equal(loadWith({ syncModelsOnBoot: true }).syncModelsOnBoot, true);
});

test('numbers clamp to their schema min/max', () => {
  const s = loadWith({ maxSlots: 999, tickRate: 1, warnPct: 12000, fleetLogLines: -5 });
  assert.equal(s.maxSlots, 64, 'maxSlots clamped to schema max');
  assert.equal(s.tickRate, 200, 'tickRate clamped to schema min');
  assert.equal(s.warnPct, 99, 'warnPct clamped to schema max');
  assert.equal(s.fleetLogLines, 4, 'fleetLogLines clamped to schema min');
  // ctxThreshold has max:null — no upper clamp.
  assert.equal(loadWith({ ctxThreshold: 900000 }).ctxThreshold, 900000);
});

test('cycle keys must be a declared option; numeric options coerce from strings', () => {
  const s = loadWith({ gridCols: '4', density: 'ultra', defaultPermission: 'yolo', fleetLogMode: 'all' });
  assert.equal(s.gridCols, 4, 'string "4" matches numeric option 4');
  assert.equal(s.density, SETTINGS_DEFAULTS.density, 'unknown cycle value falls back');
  assert.equal(s.defaultPermission, SETTINGS_DEFAULTS.defaultPermission);
  assert.equal(s.fleetLogMode, 'all', 'valid cycle value kept');
});

test('repoParents keeps only non-empty strings', () => {
  const s = loadWith({ repoParents: ['/a', 3, '', null, '~/b'] });
  assert.deepEqual(s.repoParents, ['/a', '~/b']);
});

test('unknown keys pass through untouched (forward compatibility)', () => {
  const s = loadWith({ someFutureKey: { nested: true } });
  assert.deepEqual(s.someFutureKey, { nested: true });
});

test('sanitizeSettings never throws on garbage and returns default-shaped values', () => {
  const garbage = {};
  for (const k of Object.keys(SETTINGS_DEFAULTS)) garbage[k] = { evil: true };
  const s = sanitizeSettings({ ...SETTINGS_DEFAULTS, ...garbage });
  for (const [k, def] of Object.entries(SETTINGS_DEFAULTS)) {
    if (typeof def === 'boolean') assert.equal(typeof s[k], 'boolean', k);
    if (typeof def === 'number') assert.equal(Number.isFinite(s[k]), true, k);
    if (Array.isArray(def)) assert.ok(Array.isArray(s[k]), k);
  }
});
