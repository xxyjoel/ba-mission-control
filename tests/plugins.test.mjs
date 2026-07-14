// tests/plugins.test.mjs — registry + defaults + project memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGINS, pluginByKey, isPluginEnabled, applyPluginDefaults } from '../tui/lib/plugins.js';
import { memoryPathFor, readProjectMemory, appendMemoryNote, injectMemoryIntoPrompt, MEMORY_INJECTION_SEPARATOR } from '../tui/lib/projectMemory.js';

// ── PLUGINS registry ────────────────────────────────────────

test('plugins: registry has at least one entry per layer 1/2/3', () => {
  const layers = new Set(PLUGINS.map(p => p.layer));
  assert.ok(layers.has(1));
  assert.ok(layers.has(2));
  assert.ok(layers.has(3));
});

test('plugins: every entry has the required fields', () => {
  for (const p of PLUGINS) {
    assert.ok(p.key && typeof p.key === 'string', `${p.key}: key`);
    assert.ok(p.label && typeof p.label === 'string', `${p.key}: label`);
    assert.ok([1, 2, 3].includes(p.layer), `${p.key}: layer`);
    assert.equal(typeof p.default, 'boolean', `${p.key}: default`);
    assert.ok(p.desc, `${p.key}: desc`);
    assert.ok(p.help, `${p.key}: help`);
  }
});

test('plugins: pluginByKey returns the entry; unknown returns null', () => {
  assert.ok(pluginByKey('plugin_compactRestart'));
  assert.equal(pluginByKey('plugin_nope'), null);
});

test('plugins: isPluginEnabled honors settings, falls back to default', () => {
  assert.equal(isPluginEnabled({ plugin_compactRestart: true }, 'plugin_compactRestart'), true);
  assert.equal(isPluginEnabled({ plugin_compactRestart: false }, 'plugin_compactRestart'), false);
  // Missing key → default
  const def = pluginByKey('plugin_compactRestart').default;
  assert.equal(isPluginEnabled({}, 'plugin_compactRestart'), def);
});

test('plugins: applyPluginDefaults fills missing keys without overwriting existing', () => {
  const settings = { plugin_compactRestart: false };
  applyPluginDefaults(settings);
  // Untouched
  assert.equal(settings.plugin_compactRestart, false);
  // Now has all the others
  for (const p of PLUGINS) {
    assert.equal(typeof settings[p.key], 'boolean', `${p.key} populated`);
  }
});

// ── projectMemory ───────────────────────────────────────────

test('projectMemory: memoryPathFor returns the canonical path', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mc-mem-'));
  try {
    const p = memoryPathFor(sandbox);
    assert.ok(p.endsWith(join('.mc', 'MEMORY.md')));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('projectMemory: readProjectMemory returns null when no file', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mc-mem-'));
  try {
    assert.equal(readProjectMemory(sandbox), null);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('projectMemory: appendMemoryNote creates dir+file with header on first call', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mc-mem-'));
  try {
    const r = appendMemoryNote(sandbox, 'use the existing fleet helpers');
    assert.equal(r.ok, true);
    assert.ok(existsSync(r.path));
    const body = readFileSync(r.path, 'utf8');
    assert.match(body, /# mc · project memory/);
    assert.match(body, /use the existing fleet helpers/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('projectMemory: second appendMemoryNote appends bullet without re-adding header', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mc-mem-'));
  try {
    appendMemoryNote(sandbox, 'first');
    appendMemoryNote(sandbox, 'second');
    const body = readFileSync(memoryPathFor(sandbox), 'utf8');
    const headers = body.match(/# mc · project memory/g);
    assert.equal(headers.length, 1, 'header appears exactly once');
    assert.match(body, /first/);
    assert.match(body, /second/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('projectMemory: injectMemoryIntoPrompt wraps the body with separators', () => {
  const wrapped = injectMemoryIntoPrompt('please refactor', 'we use Ink + tsx');
  assert.ok(wrapped.startsWith(MEMORY_INJECTION_SEPARATOR));
  assert.match(wrapped, /we use Ink \+ tsx/);
  assert.match(wrapped, /please refactor/);
});

test('projectMemory: injectMemoryIntoPrompt is idempotent', () => {
  const wrappedOnce = injectMemoryIntoPrompt('please refactor', 'memory body');
  const wrappedTwice = injectMemoryIntoPrompt(wrappedOnce, 'memory body');
  assert.equal(wrappedOnce, wrappedTwice);
});

test('projectMemory: injectMemoryIntoPrompt returns prompt unchanged when no memory', () => {
  assert.equal(injectMemoryIntoPrompt('hi', null), 'hi');
  assert.equal(injectMemoryIntoPrompt('hi', ''), 'hi');
});
