// tests/slashCommands.test.mjs — prefix matcher behind the Zoom dropdown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, matchSlash } from '../tui/lib/slashCommands.js';

test('matchSlash: empty / non-slash input returns no matches', () => {
  assert.deepEqual(matchSlash(''), []);
  assert.deepEqual(matchSlash('hello'), []);
  assert.deepEqual(matchSlash(null), []);
  assert.deepEqual(matchSlash(undefined), []);
});

test('matchSlash: bare "/" returns the full catalog', () => {
  const m = matchSlash('/');
  assert.equal(m.length, SLASH_COMMANDS.length);
});

test('matchSlash: prefix narrows the result list', () => {
  const m = matchSlash('/p');
  assert.ok(m.length >= 2, 'should match at least /perm and /pause');
  for (const cmd of m) {
    assert.ok(cmd.name.toLowerCase().startsWith('/p'));
  }
});

test('matchSlash: exact name still appears in results', () => {
  const m = matchSlash('/help');
  assert.ok(m.find((c) => c.name === '/help'), '/help should match itself');
});

test('matchSlash: case-insensitive', () => {
  const lower = matchSlash('/p');
  const upper = matchSlash('/P');
  assert.deepEqual(lower.map((c) => c.name), upper.map((c) => c.name));
});

test('matchSlash: ignores trailing args (matches by first token only)', () => {
  // The dropdown should keep showing /perm even as the user types args.
  const m = matchSlash('/perm plan');
  assert.ok(m.find((c) => c.name === '/perm'), '/perm should match with args');
});
