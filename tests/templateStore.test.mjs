// tests/templateStore.test.mjs — covers the bundled defaults and the
// loader/lookup contract. Doesn't touch the real config file; we point
// MC_CONFIG_DIR at a tmpdir so the load path creates a clean defaults
// file.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// templateStore resolves its file through configDir.js, which prefers
// MC_CONFIG_DIR over HOME and caches it at module load (0436: isolating
// through HOME alone pinned the wrong assumption). Set the override BEFORE
// the first dynamic import; later `?fresh=N` imports reload templateStore
// but share the cached config dir.
let savedCfg;
let scratchCfg;
before(() => {
  savedCfg = process.env.MC_CONFIG_DIR;
  scratchCfg = mkdtempSync(join(tmpdir(), 'mc-tplstore-'));
  process.env.MC_CONFIG_DIR = scratchCfg;
});
after(() => {
  if (savedCfg === undefined) delete process.env.MC_CONFIG_DIR;
  else process.env.MC_CONFIG_DIR = savedCfg;
  try { rmSync(scratchCfg, { recursive: true, force: true }); } catch {}
});

test('templateStore: first load writes the bundled defaults to disk', async () => {
  const { loadTemplates } = await import('../tui/lib/templateStore.js?fresh=1');
  const t = loadTemplates();
  assert.ok(t.review, 'should ship a `review` template');
  assert.ok(t.explore, 'should ship an `explore` template');
  assert.ok(t['spec-then-implement'], 'should ship a `spec-then-implement` template');
  const file = join(scratchCfg, 'templates.json');
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
