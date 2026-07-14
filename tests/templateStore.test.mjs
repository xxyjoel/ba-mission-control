// tests/templateStore.test.mjs — covers the bundled defaults and the
// loader/lookup contract. Doesn't touch the real config file; we point
// HOME at a tmpdir per-test so the load path creates a clean defaults
// file each time.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// templateStore reads HOME at module-load time (via homedir()), so we
// must override the env var BEFORE the dynamic import. Each test
// imports fresh under a fresh HOME.
let savedHome;
let scratchHome;
before(() => {
  savedHome = process.env.HOME;
  scratchHome = mkdtempSync(join(tmpdir(), 'mc-tplstore-'));
  process.env.HOME = scratchHome;
});
after(() => {
  process.env.HOME = savedHome;
  try { rmSync(scratchHome, { recursive: true, force: true }); } catch {}
});

test('templateStore: first load writes the bundled defaults to disk', async () => {
  const { loadTemplates } = await import('../tui/lib/templateStore.js?fresh=1');
  const t = loadTemplates();
  assert.ok(t.review, 'should ship a `review` template');
  assert.ok(t.explore, 'should ship an `explore` template');
  assert.ok(t['spec-then-implement'], 'should ship a `spec-then-implement` template');
  const file = join(scratchHome, '.config', 'claude-mc', 'templates.json');
  assert.ok(existsSync(file), 'defaults should be persisted on first load');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), Object.keys(t).sort());
});

test('templateStore: listTemplates returns name, description, count', async () => {
  const { listTemplates } = await import('../tui/lib/templateStore.js?fresh=2');
  const list = listTemplates();
  assert.ok(list.length >= 3);
  for (const entry of list) {
    assert.ok(entry.name, 'each entry has a name');
    assert.ok(typeof entry.description === 'string');
    assert.ok(typeof entry.count === 'number' && entry.count > 0);
  }
});

test('templateStore: getTemplate is case-insensitive', async () => {
  const { getTemplate } = await import('../tui/lib/templateStore.js?fresh=3');
  assert.ok(getTemplate('review'));
  assert.ok(getTemplate('REVIEW'));
  assert.ok(getTemplate('Review'));
  assert.equal(getTemplate('does-not-exist'), null);
});

test('templateStore: each template session has model + permissionMode + prompt', async () => {
  const { loadTemplates } = await import('../tui/lib/templateStore.js?fresh=4');
  const all = loadTemplates();
  for (const [name, t] of Object.entries(all)) {
    for (const s of t.sessions) {
      assert.ok(s.model, `[${name}] every session needs a model`);
      assert.ok(s.permissionMode, `[${name}] every session needs a permissionMode`);
      assert.ok(s.prompt, `[${name}] every session needs a prompt`);
    }
  }
});
