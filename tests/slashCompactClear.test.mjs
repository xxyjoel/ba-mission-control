// tests/slashCompactClear.test.mjs — verify /compact and /clear are in
// the slash-command catalog so the Zoom autocomplete dropdown surfaces
// them. The handler wiring is tested by the existing
// tests/Zoom.slash.test.jsx pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, matchSlash } from '../tui/lib/slashCommands.js';

test('slash catalog: /compact is registered', () => {
  const entry = SLASH_COMMANDS.find(c => c.name === '/compact');
  assert.ok(entry, '/compact must be in SLASH_COMMANDS');
  assert.match(entry.desc, /summar|context|kill|restart/i);
});

test('slash catalog: /clear is registered', () => {
  const entry = SLASH_COMMANDS.find(c => c.name === '/clear');
  assert.ok(entry, '/clear must be in SLASH_COMMANDS');
  assert.match(entry.desc, /kill|restart|fresh/i);
});

test('slash autocomplete: typing /c narrows to /cost /compact /clear', () => {
  const matches = matchSlash('/c');
  const names = matches.map(m => m.name);
  assert.ok(names.includes('/cost'));
  assert.ok(names.includes('/compact'));
  assert.ok(names.includes('/clear'));
});

test('slash autocomplete: typing /comp matches /compact + /compact-restart', () => {
  const matches = matchSlash('/comp');
  const names = matches.map(m => m.name);
  assert.ok(names.includes('/compact'));
  assert.ok(names.includes('/compact-restart'));
});

test('slash autocomplete: typing /cl narrows to /clear only', () => {
  const matches = matchSlash('/cl');
  // /close isn't in the catalog so /cl matches only /clear
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, '/clear');
});
