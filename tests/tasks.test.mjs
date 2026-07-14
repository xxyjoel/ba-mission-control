// tests/tasks.test.mjs — pin the gh-issue fetcher's failure modes.
// We never want listIssuesForCwd to throw — it's called from a hotkey
// handler and a thrown error would crash the TUI. Instead, every
// failure path returns { ok: false, message: <one-liner> }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
