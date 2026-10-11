// tests/git.nullOnFailure.test.mjs — 0452: a failed git read must come back as
// null (unknown), never as 0. Before 0452 dirtyCount/aheadBehind returned 0 and
// {0,0} on failure, which the Card then drew as a green "clean" dot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyCount, aheadBehind, fullStatus } from '../server/git.mjs';

// Keep git from walking up into whatever repo the temp dir happens to sit in.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-0452-git-')));
process.env.GIT_CEILING_DIRECTORIES = dirname(root);

const nonRepo = mkdtempSync(join(root, 'plain-'));
const repo = mkdtempSync(join(root, 'repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });

test('dirtyCount on a non-repo is null, not 0', async () => {
  assert.equal(await dirtyCount(nonRepo), null);
});

test('aheadBehind with no upstream is null, not {0,0}', async () => {
  assert.deepEqual(await aheadBehind(repo, 'main'), { ahead: null, behind: null });
});

test('fullStatus on a non-repo reports unknown counts, not zeros', async () => {
  const st = await fullStatus(nonRepo);
  assert.equal(st.isRepo, false);
  assert.equal(st.dirty, null);
  assert.equal(st.ahead, null);
  assert.equal(st.behind, null);
});

test('a clean repo still counts 0 and a dirty one counts its files', async () => {
  assert.equal(await dirtyCount(repo), 0, 'empty porcelain output is a real clean 0');
  writeFileSync(join(repo, 'a.txt'), 'x');
  assert.equal(await dirtyCount(repo), 1);
  const st = await fullStatus(repo);
  assert.equal(st.isRepo, true);
  assert.equal(st.dirty, 1);
});
