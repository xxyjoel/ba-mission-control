// tests/statusFile.test.mjs — 0205: statusFilePath UUID guard + stable MC-owned path
//
// Pins the path contract for server/statusFile.mjs (task 0204).
// The module does not exist yet — these tests MUST fail until 0204 ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { statusFilePath } from '../server/statusFile.mjs';

const VALID_UUID = 'ffa11b43-877c-42dc-bb05-0bec83279c9d';

test('valid UUID yields a path under the MC state dir ending in <sid>.ndjson', () => {
  const p = statusFilePath({ sessionId: VALID_UUID });
  // Must be an absolute path under a dedicated MC-owned state directory —
  // NOT under ~/.claude/projects (which is claude's transcript space).
  assert.ok(typeof p === 'string' && p.length > 0, 'returns a non-empty string');
  assert.ok(p.startsWith('/'), 'path is absolute');
  assert.ok(p.endsWith(`${VALID_UUID}.ndjson`), `path ends with <sid>.ndjson — got: ${p}`);
  // Must live somewhere under home (e.g. ~/.local/state/claude-mc/status/)
  assert.ok(p.startsWith(homedir()), `path is under home dir — got: ${p}`);
});

test('path is NOT under ~/.claude/projects (no collision with claude transcripts)', () => {
  const p = statusFilePath({ sessionId: VALID_UUID });
  const claudeProjects = `${homedir()}/.claude/projects`;
  assert.ok(
    !p.startsWith(claudeProjects),
    `path must not be under ${claudeProjects} — got: ${p}`,
  );
});

test('deterministic: same sessionId always yields the same path', () => {
  const p1 = statusFilePath({ sessionId: VALID_UUID });
  const p2 = statusFilePath({ sessionId: VALID_UUID });
  assert.equal(p1, p2, 'same input must produce same output');
});

test('different sessionIds yield different paths', () => {
  const other = 'aabbccdd-1234-5678-abcd-000000000000';
  const p1 = statusFilePath({ sessionId: VALID_UUID });
  const p2 = statusFilePath({ sessionId: other });
  assert.notEqual(p1, p2, 'different session ids must map to different paths');
});

test('rejects non-UUID sessionId (path traversal attempt)', () => {
  assert.throws(
    () => statusFilePath({ sessionId: '../../../../etc/passwd' }),
    /sessionId/i,
  );
});

test('rejects sessionId with slash or dot segment', () => {
  assert.throws(() => statusFilePath({ sessionId: 'a/b' }), /sessionId/i);
  assert.throws(() => statusFilePath({ sessionId: '..' }), /sessionId/i);
});

test('rejects empty / null / non-string sessionId', () => {
  assert.throws(() => statusFilePath({ sessionId: '' }), /sessionId/i);
  assert.throws(() => statusFilePath({ sessionId: null }), /sessionId/i);
  assert.throws(() => statusFilePath({ sessionId: 42 }), /sessionId/i);
});

test('rejects an almost-UUID with a trailing suffix', () => {
  assert.throws(
    () => statusFilePath({ sessionId: `${VALID_UUID}/..` }),
    /sessionId/i,
  );
});
