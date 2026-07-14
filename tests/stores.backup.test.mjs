// tests/stores.backup.test.mjs — verify the .bak rollback pattern
// applied to costStore and settings. Same shape as sessionStore.backup
// .test.mjs; pinned separately so a regression in one store doesn't
// drag down a multi-test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Inject MC_CONFIG_DIR before importing the stores so they pick up the
// override at module-time.
const sandbox = mkdtempSync(join(tmpdir(), 'mc-stores-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { loadSettings, saveSettings } = await import('../tui/lib/settings.js');
const { CostStore } = await import('../tui/lib/costStore.js');

const SETTINGS_PATH = join(sandbox, 'settings.json');
const SETTINGS_BAK  = SETTINGS_PATH + '.bak';
const COSTS_PATH    = join(sandbox, 'costs-week.json');
const COSTS_BAK     = COSTS_PATH + '.bak';

test('settings: corrupted main file falls back to .bak', async (t) => {
  t.after(() => {
    try { rmSync(SETTINGS_PATH, { force: true }); } catch {}
    try { rmSync(SETTINGS_BAK, { force: true }); } catch {}
  });
  saveSettings({ theme: 'BlueArch', gridCols: 4 });
  saveSettings({ theme: 'Tokyo Night', gridCols: 5 });
  assert.ok(existsSync(SETTINGS_BAK), '.bak exists after second save');
  writeFileSync(SETTINGS_PATH, 'corrupt {{{');
  const recovered = loadSettings();
  // .bak holds the FIRST save (theme=BlueArch) — that's the prior
  // good state before the second write copied main → bak.
  assert.equal(recovered.theme, 'BlueArch');
  assert.equal(recovered.gridCols, 4);
});

test('settings: corrupted main + no .bak returns defaults', async (t) => {
  t.after(() => {
    try { rmSync(SETTINGS_PATH, { force: true }); } catch {}
    try { rmSync(SETTINGS_BAK, { force: true }); } catch {}
  });
  writeFileSync(SETTINGS_PATH, 'garbage');
  const recovered = loadSettings();
  // The default theme is BlueArch — but the more important assertion
  // is that we get a non-empty object with the expected shape.
  assert.ok(typeof recovered.theme === 'string');
  assert.ok(typeof recovered.gridCols === 'number');
});

test('settings: atomic write — no stale .tmp on success', async (t) => {
  t.after(() => {
    try { rmSync(SETTINGS_PATH, { force: true }); } catch {}
    try { rmSync(SETTINGS_BAK, { force: true }); } catch {}
    try { rmSync(SETTINGS_PATH + '.tmp', { force: true }); } catch {}
  });
  saveSettings({ theme: 'BlueArch' });
  assert.ok(existsSync(SETTINGS_PATH));
  assert.ok(!existsSync(SETTINGS_PATH + '.tmp'));
});

test('costStore: corrupted main file falls back to .bak', async (t) => {
  t.after(() => {
    try { rmSync(COSTS_PATH, { force: true }); } catch {}
    try { rmSync(COSTS_BAK, { force: true }); } catch {}
  });
  // CostStore.update() auto-persists when dirty, so a single call
  // produces the main file. Two distinct stores ensure the .bak gets
  // a chance to rotate.
  const store1 = new CostStore();
  store1.update([{ id: 'a1', status: 'idle', costSession: 0.5 }]);
  assert.ok(existsSync(COSTS_PATH), 'main file must exist after first update');
  const store2 = new CostStore();
  store2.update([{ id: 'a2', status: 'idle', costSession: 1.5 }]);
  assert.ok(existsSync(COSTS_BAK), '.bak created on second update');
  // Corrupt main
  writeFileSync(COSTS_PATH, 'not json');
  const recovered = new CostStore();
  // Should have recovered from .bak (which holds the FIRST save). The
  // total cost from first save was 0.5; not zero (which would mean
  // empty fallback).
  assert.ok(recovered.weekCost() > 0, 'recovered week cost from .bak > 0');
});

test('costStore: atomic write — no stale .tmp on success', async (t) => {
  t.after(() => {
    try { rmSync(COSTS_PATH, { force: true }); } catch {}
    try { rmSync(COSTS_BAK, { force: true }); } catch {}
    try { rmSync(COSTS_PATH + '.tmp', { force: true }); } catch {}
  });
  const store = new CostStore();
  store.update([{ id: 'a1', status: 'idle', costSession: 0.25 }]);
  assert.ok(existsSync(COSTS_PATH));
  assert.ok(!existsSync(COSTS_PATH + '.tmp'));
});

test('cleanup: sandbox dir removed', async () => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});
