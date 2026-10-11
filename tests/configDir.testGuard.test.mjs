// tests/configDir.testGuard.test.mjs — 0436 paired test. Under `node --test`
// (NODE_TEST_CONTEXT set) with no MC_CONFIG_DIR, configDir.js used to resolve
// to the real ~/.config/claude-mc; it must now throw and name `npm test`.
// configDir caches at module load, so each case runs in a fresh child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(join(here, '..', 'tui', 'lib', 'configDir.js')).href;
const script = `import(${JSON.stringify(modUrl)}).then((m) => { process.stdout.write(m.getConfigDir()); })`;

function run(envPatch) {
  const env = { ...process.env, ...envPatch };
  for (const [k, v] of Object.entries(envPatch)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

test('configDir: throws under node --test when MC_CONFIG_DIR is unset', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cfgguard-'));
  try {
    const r = run({ NODE_TEST_CONTEXT: 'child-v8', MC_CONFIG_DIR: undefined, HOME: home });
    assert.notEqual(r.status, 0, `expected a throw, got stdout=${r.stdout}`);
    assert.match(r.stderr, /npm test/);
    assert.equal(r.stdout, '');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('configDir: MC_CONFIG_DIR wins under node --test', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'mc-cfgguard-'));
  try {
    const r = run({ NODE_TEST_CONTEXT: 'child-v8', MC_CONFIG_DIR: cfg });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, cfg);
  } finally { rmSync(cfg, { recursive: true, force: true }); }
});

test('configDir: outside tests, no override still means ~/.config/claude-mc', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-cfgguard-'));
  try {
    const r = run({ NODE_TEST_CONTEXT: undefined, MC_CONFIG_DIR: undefined, HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, join(home, '.config', 'claude-mc'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
