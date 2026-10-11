// tests/plugins.projectMemoryDefault.test.mjs — 0461: .mc/MEMORY.md is only
// injected into the first prompt when the user opts in. A fresh install (no
// settings.json) and a saved file without the key must NOT inject; a saved
// explicit true must still inject.
//
// Runs under scripts/run-tests.mjs, which gives this file its own throwaway
// MC_CONFIG_DIR / HOME, so writing settings.json here never touches the real one.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings } from '../tui/lib/settings.js';
import { getConfigDir } from '../tui/lib/configDir.js';
import { pluginByKey, isPluginEnabled } from '../tui/lib/plugins.js';
import { readProjectMemory, injectMemoryIntoPrompt, MEMORY_DIR_NAME, MEMORY_FILE_NAME } from '../tui/lib/projectMemory.js';

const MEMORY_TEXT = 'secret-ish project note 0461';
const settingsFile = join(getConfigDir(), 'settings.json');

// Mirrors the first-prompt gate in App.jsx (launch handler, "Layer-2 memory").
function firstPrompt(settings, cwd, prompt) {
  let finalPrompt = prompt;
  if (isPluginEnabled(settings, 'plugin_projectMemory')) {
    const mem = readProjectMemory(cwd);
    if (mem) finalPrompt = injectMemoryIntoPrompt(finalPrompt, mem);
  }
  return finalPrompt;
}

function repoWithMemory() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-0461-'));
  mkdirSync(join(dir, MEMORY_DIR_NAME), { recursive: true });
  writeFileSync(join(dir, MEMORY_DIR_NAME, MEMORY_FILE_NAME), MEMORY_TEXT + '\n');
  return dir;
}

function writeSettings(obj) {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(obj));
}

beforeEach(() => {
  rmSync(settingsFile, { force: true });
  rmSync(settingsFile + '.bak', { force: true });
});

test('0461: plugin_projectMemory is declared off by default', () => {
  assert.equal(pluginByKey('plugin_projectMemory').default, false);
});

test('0461: fresh install (no settings.json) does not inject .mc/MEMORY.md', () => {
  const repo = repoWithMemory();
  try {
    const settings = loadSettings();
    assert.equal(settings.plugin_projectMemory, false);
    const out = firstPrompt(settings, repo, 'hello');
    assert.equal(out, 'hello');
    assert.ok(!out.includes(MEMORY_TEXT));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('0461: saved settings without the key do not inject', () => {
  writeSettings({ theme: 'default' });
  const repo = repoWithMemory();
  try {
    const out = firstPrompt(loadSettings(), repo, 'hello');
    assert.equal(out, 'hello');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('0461: a saved explicit true is respected and still injects', () => {
  writeSettings({ plugin_projectMemory: true });
  const repo = repoWithMemory();
  try {
    const settings = loadSettings();
    assert.equal(settings.plugin_projectMemory, true);
    const out = firstPrompt(settings, repo, 'hello');
    assert.ok(out.includes(MEMORY_TEXT));
    assert.ok(out.includes('hello'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('0461: a saved explicit false stays false', () => {
  writeSettings({ plugin_projectMemory: false });
  assert.equal(loadSettings().plugin_projectMemory, false);
});

// 0461 (review): firstPrompt() above is a copy of the App.jsx gate. Pin the
// copy to the real launch path so a change there fails here instead of
// leaving this file testing stale logic.
test('0461: App.jsx launch path still gates injection on plugin_projectMemory', () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tui', 'App.jsx'), 'utf8');
  assert.match(appSrc, /if \(isPluginEnabled\(settings, 'plugin_projectMemory'\) && finalPrompt\) \{\s*const memBody = readProjectMemory\(repoPath\);/);
  assert.match(appSrc, /finalPrompt = injectMemoryIntoPrompt\(finalPrompt, memBody\);/);
});
