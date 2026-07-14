// tests/claudeBanner.test.mjs — the heuristic matcher that recognises claude's
// own "update available" banner so PtyPane can lift it out of the zoom body.
// Must catch the banner's common wordings WITHOUT swallowing ordinary prose
// that merely mentions the word "update".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchUpdateBanner } from '../tui/zoom/claudeBanner.js';

test('matches the common update-available wordings', () => {
  for (const s of [
    'Update available: 2.1.180 (current 2.1.176)',
    '✻ A new version of Claude Code is available',
    '✓ Update installed · restart to apply',
    'Restart to apply the update',
    'Run claude update to upgrade',
    'npm i -g @anthropic-ai/claude-code',
  ]) {
    assert.ok(matchUpdateBanner(s), `should match: ${s}`);
  }
});

test('captures a version token when present', () => {
  const hit = matchUpdateBanner('Update available: v2.1.180');
  assert.ok(hit);
  assert.equal(hit.version, '2.1.180');
});

test('returns null when no version is present', () => {
  const hit = matchUpdateBanner('A newer version is available');
  assert.ok(hit);
  assert.equal(hit.version, null);
});

test('does NOT match ordinary prose that merely says "update"', () => {
  for (const s of [
    'I will update the README after this change.',
    'Please update the function to handle nulls.',
    'updated the config and re-ran the tests',
    '',
    '   ',
  ]) {
    assert.equal(matchUpdateBanner(s), null, `should NOT match: ${JSON.stringify(s)}`);
  }
});

test('tolerates non-string input', () => {
  assert.equal(matchUpdateBanner(null), null);
  assert.equal(matchUpdateBanner(undefined), null);
  assert.equal(matchUpdateBanner(42), null);
});
