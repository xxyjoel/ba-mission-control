// tests/shell/shellKeys.test.js — unit test for 0313 acceptance criteria.
//
// Calls classifyShellKey with mock (input, key) objects.
// Does NOT drive real Ink bytes (that is 0314's job: shellKeys.realparser.test.jsx).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShellKey } from '../../tui/shell/shellKeys.js';

const ctrl = (letter) => ({ ctrl: true, input: letter });
const plain = () => ({});

describe('classifyShellKey', () => {
  it('returns EXIT for Ctrl+Q', () => {
    assert.strictEqual(classifyShellKey('q', { ctrl: true }), 'EXIT');
  });

  it('returns null for Ctrl+K (readline kill-line — must reach PTY)', () => {
    assert.strictEqual(classifyShellKey('k', { ctrl: true }), null);
  });

  it('returns null for Ctrl+U (readline kill-line-backward — must reach PTY)', () => {
    assert.strictEqual(classifyShellKey('u', { ctrl: true }), null);
  });

  it('returns null for Ctrl+J / newline (readline accept — must reach PTY)', () => {
    // Ink delivers Ctrl+J as input='\n' with no ctrl flag (raw LF).
    assert.strictEqual(classifyShellKey('\n', {}), null);
    // Also guard the {ctrl:true, input:'j'} shape just in case.
    assert.strictEqual(classifyShellKey('j', { ctrl: true }), null);
  });

  it('returns null for Ctrl+Y (scroll — not a shell chrome key here)', () => {
    assert.strictEqual(classifyShellKey('y', { ctrl: true }), null);
  });

  it('returns null for plain letter keys', () => {
    assert.strictEqual(classifyShellKey('a', {}), null);
    assert.strictEqual(classifyShellKey('q', {}), null); // plain q, not ctrl
  });

  it('returns null for Escape', () => {
    assert.strictEqual(classifyShellKey('', { escape: true }), null);
  });
});
