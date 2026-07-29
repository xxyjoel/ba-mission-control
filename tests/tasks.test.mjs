// tests/tasks.test.mjs — pin the gh-issue fetcher's failure modes.
// We never want listIssuesForCwd to throw — it's called from a hotkey
// handler and a thrown error would crash the TUI. Instead, every
// failure path returns { ok: false, message: <one-liner> }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listIssuesForCwd } from '../tui/lib/tasks.js';

test('tasks: no cwd → ok:false with message', async () => {
  const r = await listIssuesForCwd(null);
  assert.equal(r.ok, false);
  assert.match(r.message, /cwd/);
});

test('tasks: cwd that is not a git repo → ok:false (gh fails gracefully)', async () => {
  const r = await listIssuesForCwd('/tmp');
  assert.equal(r.ok, false);
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
});

test('tasks: returns ok:true with issues array when gh succeeds', async () => {
  // Run against the project repo; if gh isn't installed or auth is
  // missing, the test should still return an ok:false structure (not
  // throw). We assert the SHAPE, not the contents.
  const r = await listIssuesForCwd(process.cwd());
  assert.ok(typeof r === 'object');
  assert.ok('ok' in r);
  if (r.ok) {
    assert.ok(Array.isArray(r.issues));
    for (const it of r.issues) {
      assert.ok(typeof it.number === 'number');
      assert.ok(typeof it.title === 'string');
    }
  } else {
    assert.ok(typeof r.message === 'string');
  }
});

test('tasks: a HANGING gh is bounded by the hard backstop — resolves fast, never hangs the caller', async () => {
  // Regression for the CI hang: a real `gh` whose grandchild held the stdout pipe
  // kept execFile's callback from ever firing (~9 min blocked). Point the fetcher
  // at a binary that ignores its args and sleeps forever; the backstop must kill it
  // and resolve ok:false well under the node --test-timeout.
  const dir = mkdtempSync(join(tmpdir(), 'mc-gh-hang-'));
  const fake = join(dir, 'hang.sh');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 600\n');
  chmodSync(fake, 0o755);
  try {
    const t0 = Date.now();
    const r = await listIssuesForCwd(process.cwd(), { bin: fake, hardTimeoutMs: 300 });
    const dt = Date.now() - t0;
    assert.equal(r.ok, false, 'a hang must surface as ok:false, not throw or hang');
    assert.ok(dt < 3000, `backstop must resolve quickly; took ${dt}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
