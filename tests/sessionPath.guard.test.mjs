// tests/sessionPath.guard.test.mjs — 0181: claudeSessionPath must reject a
// non-UUID sessionId before path-joining, so a tampered/`--resume` id read
// off disk can't traverse out of ~/.claude/projects/<cwd>/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { claudeSessionPath } from '../server/sessionFileTailer.mjs';

const CWD = '/Users/me/project';

test('accepts a canonical UUID sessionId', () => {
  const id = 'ffa11b43-877c-42dc-bb05-0bec83279c9d';
  const p = claudeSessionPath({ cwd: CWD, sessionId: id });
  assert.ok(p.startsWith(homedir()));
  assert.ok(p.endsWith(`${id}.jsonl`));
});

test('rejects path-traversal sessionId', () => {
  assert.throws(
    () => claudeSessionPath({ cwd: CWD, sessionId: '../../../../etc/passwd' }),
    /sessionId/i,
  );
});

test('rejects a sessionId with a slash or dot segment', () => {
  assert.throws(() => claudeSessionPath({ cwd: CWD, sessionId: 'a/b' }), /sessionId/i);
  assert.throws(() => claudeSessionPath({ cwd: CWD, sessionId: '..' }), /sessionId/i);
});

test('rejects empty / null / non-string sessionId', () => {
  assert.throws(() => claudeSessionPath({ cwd: CWD, sessionId: '' }), /sessionId/i);
  assert.throws(() => claudeSessionPath({ cwd: CWD, sessionId: null }), /sessionId/i);
  assert.throws(() => claudeSessionPath({ cwd: CWD, sessionId: 42 }), /sessionId/i);
});

test('rejects an almost-UUID with an extra suffix', () => {
  assert.throws(
    () => claudeSessionPath({ cwd: CWD, sessionId: 'ffa11b43-877c-42dc-bb05-0bec83279c9d/..' }),
    /sessionId/i,
  );
});
