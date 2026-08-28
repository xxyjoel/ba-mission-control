// tests/hookInstall.test.mjs — 0391: the hook emitter lives at a stable path.
//
// Sessions bake the emitter's absolute path into hook settings at launch, so
// the path must survive the install moving or vanishing. The load-bearing
// assertion is #3: the COPIED emitter executes from the stable dir — its
// '../statusFile.mjs' relative import must resolve against the copied pair,
// not the install tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableEmitterPath, STABLE_DIR } from '../server/hookInstall.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

test('stableEmitterPath: installs the pair under the state dir and memoizes', () => {
  const p = stableEmitterPath();
  assert.equal(p, join(STABLE_DIR, 'hooks', 'emit-status.mjs'));
  assert.ok(existsSync(p), 'emitter copy exists');
  assert.ok(existsSync(join(STABLE_DIR, 'statusFile.mjs')), 'statusFile dependency copied');
  assert.equal(stableEmitterPath(), p, 'memoized');
});

test('stable copies match the source files byte-for-byte', () => {
  stableEmitterPath();
  const srcDir = join(import.meta.dirname, '..', 'server');
  assert.equal(
    readFileSync(join(STABLE_DIR, 'hooks', 'emit-status.mjs'), 'utf8'),
    readFileSync(join(srcDir, 'hooks', 'emit-status.mjs'), 'utf8'));
  assert.equal(
    readFileSync(join(STABLE_DIR, 'statusFile.mjs'), 'utf8'),
    readFileSync(join(srcDir, 'statusFile.mjs'), 'utf8'));
});

test('the copied emitter EXECUTES from the stable dir (relative import resolves)', () => {
  const p = stableEmitterPath();
  const sid = randomUUID();
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'AskUserQuestion',
  });
  execFileSync(process.execPath, [p], { input: payload, timeout: 10_000 });
  const out = statusFilePath({ sessionId: sid });
  try {
    assert.ok(existsSync(out), 'emitter wrote the ndjson status file');
    const rec = JSON.parse(readFileSync(out, 'utf8').trim().split('\n').at(-1));
    assert.equal(rec.event, 'PostToolUse');
    assert.equal(rec.tool_name, 'AskUserQuestion');
    assert.equal(rec.session_id, sid);
  } finally {
    try { rmSync(out); } catch {}
  }
});
