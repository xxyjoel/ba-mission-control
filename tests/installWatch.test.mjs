// tests/installWatch.test.mjs — 0428: notice a claude install with no timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOnPath, watchInstall } from '../tui/lib/installWatch.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('resolveOnPath: first PATH hit wins; a missing name is null', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-iw-'));
  const a = join(root, 'a'); const b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(b, 'claude'), ''); writeFileSync(join(a, 'claude'), '');
  assert.equal(resolveOnPath('claude', { pathEnv: `${a}:${b}` }), join(a, 'claude'));
  assert.equal(resolveOnPath('nope', { pathEnv: `${a}:${b}` }), null);
  assert.equal(resolveOnPath('relative/claude'), null, 'a relative path is never trusted');
  rmSync(root, { recursive: true, force: true });
});

test('watchInstall watches the link folder and the real target folder', () => {
  const dirs = [];
  const stop = watchInstall('claude', () => {}, {
    resolve: () => '/home/u/.local/bin/claude',
    realpath: () => '/home/u/.local/share/claude/versions/2.1.283',
    watch: (dir) => { dirs.push(dir); return { close() {}, on() {} }; },
  });
  assert.deepEqual(dirs, ['/home/u/.local/bin', '/home/u/.local/share/claude/versions']);
  stop();
});

test('watchInstall debounces a burst of events into one onChange, and re-arms', async () => {
  let cb; let armed = 0; let calls = 0;
  const stop = watchInstall('claude', () => { calls++; }, {
    debounceMs: 20,
    resolve: () => '/x/bin/claude',
    realpath: () => '/x/bin/claude',
    watch: (_d, _o, f) => { armed++; cb = f; return { close() {}, on() {} }; },
  });
  assert.equal(armed, 1);
  cb(); cb(); cb();
  await wait(60);
  assert.equal(calls, 1, 'one install, one check');
  assert.equal(armed, 2, 're-armed after the change');
  stop();
  cb(); await wait(60);
  assert.equal(calls, 1, 'nothing fires after stop()');
});

test('watchInstall never throws and never polls when nothing is watchable', () => {
  const stop = watchInstall('claude', () => { throw new Error('no'); }, {
    resolve: () => null, watch: () => { throw new Error('should not watch'); },
  });
  stop();
  const stop2 = watchInstall('claude', () => {}, {
    resolve: () => '/x/claude', realpath: () => '/x/claude',
    watch: () => { throw new Error('EPERM'); },
  });
  stop2();
});

test('watchInstall fires on a real link repoint (claude install)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-iw-'));
  const bin = join(root, 'bin'); const vers = join(root, 'versions');
  mkdirSync(bin); mkdirSync(vers);
  for (const v of ['1.0.0', '1.0.1']) { writeFileSync(join(vers, v), '#!/bin/sh\n'); chmodSync(join(vers, v), 0o755); }
  symlinkSync(join(vers, '1.0.0'), join(bin, 'claude'));
  let calls = 0;
  const stop = watchInstall('claude', () => { calls++; }, {
    debounceMs: 400,
    resolve: (b) => resolveOnPath(b, { pathEnv: bin }),
  });
  await wait(100);
  // Installers swap the link atomically: new link beside, then rename over.
  symlinkSync(join(vers, '1.0.1'), join(bin, 'claude.tmp'));
  renameSync(join(bin, 'claude.tmp'), join(bin, 'claude'));
  await wait(1500);
  stop();
  rmSync(root, { recursive: true, force: true });
  assert.equal(calls, 1);
});
