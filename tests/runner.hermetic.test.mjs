// tests/runner.hermetic.test.mjs — 0436: prove scripts/run-tests.mjs hands
// every test file a throwaway HOME / MC_CONFIG_DIR / XDG_STATE_HOME under
// os.tmpdir(), none of which resolves back into the user's real home.
//
// The runner exports MC_REAL_HOME (from os.userInfo(), not $HOME). Its absence
// means this file was run with bare `node --test`, outside the sandbox — that
// is a failure, not a skip, so a regression in the runner can't hide here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

const real = (p) => (existsSync(p) ? realpathSync(p) : p);
const inside = (child, parent) => {
  const rel = relative(real(parent), real(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

const REAL_HOME = process.env.MC_REAL_HOME;

test('runner: MC_REAL_HOME is set (tests must run via npm test / scripts/run-tests.mjs)', () => {
  assert.ok(REAL_HOME,
    'MC_REAL_HOME is missing — this file was not run by scripts/run-tests.mjs. '
    + 'Run `npm test` or `node scripts/run-tests.mjs <file>`.');
});

for (const name of ['HOME', 'MC_CONFIG_DIR', 'XDG_STATE_HOME']) {
  test(`runner: ${name} is a temp dir, not the real home`, () => {
    assert.ok(REAL_HOME, 'MC_REAL_HOME missing — not run via scripts/run-tests.mjs');
    const v = process.env[name];
    assert.ok(v, `${name} is not set`);
    assert.ok(inside(v, tmpdir()), `${name}=${v} is not inside os.tmpdir() (${tmpdir()})`);
    for (const realDir of [
      REAL_HOME,
      join(REAL_HOME, '.config', 'claude-mc'),
      join(REAL_HOME, '.claude'),
      join(REAL_HOME, '.local', 'state'),
    ]) {
      assert.ok(!inside(v, realDir), `${name}=${v} is inside the real ${realDir}`);
    }
  });
}

test('runner: os.homedir() follows the sandboxed HOME', () => {
  assert.ok(REAL_HOME, 'MC_REAL_HOME missing — not run via scripts/run-tests.mjs');
  // Paths built from homedir() (~/.claude/projects, ~/.local/state, …) are
  // isolated only through HOME; make sure node honours it.
  assert.equal(real(homedir()), real(process.env.HOME));
  assert.notEqual(real(homedir()), real(REAL_HOME));
});
