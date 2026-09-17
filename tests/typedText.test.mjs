// tests/typedText.test.mjs — 0389. What counts as typed text.
//
// Dictation does not arrive one character at a time. macOS speech-to-text
// hands the terminal a whole phrase in one write, and an embedded CR or C0
// control byte arrives INSIDE that text run — Ink only splits out the control
// bytes it recognises as keys. Untreated, those bytes land in the value: a
// bare CR inside a broadcast message, a control character in a session path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTypedText } from '../tui/lib/typedText.js';

test('a plain dictated phrase passes through untouched', () => {
  const phrase = 'please add a retry with exponential backoff';
  assert.equal(normalizeTypedText(phrase), phrase);
  assert.equal(normalizeTypedText(phrase, { allowNewlines: true }), phrase);
});

test('CR and CRLF become LF on a multi-line surface', () => {
  assert.equal(normalizeTypedText('a\rb', { allowNewlines: true }), 'a\nb');
  assert.equal(normalizeTypedText('a\r\nb', { allowNewlines: true }), 'a\nb');
  assert.equal(normalizeTypedText('a\nb', { allowNewlines: true }), 'a\nb');
});

test('line breaks collapse to one space on a single-line surface', () => {
  assert.equal(normalizeTypedText('a\rb'), 'a b');
  assert.equal(normalizeTypedText('a\r\nb'), 'a b');
  assert.equal(normalizeTypedText('a\nb'), 'a b');
  assert.equal(normalizeTypedText('a\n\n\nb'), 'a b', 'a run of breaks is one gap, not three');
});

test('control bytes are dropped, printable text is kept', () => {
  assert.equal(normalizeTypedText('ok\u0000\u0001 x'), 'ok x');
  assert.equal(normalizeTypedText('tab\there'), 'tabhere', 'a real Tab arrives as key.tab, not as text');
  assert.equal(normalizeTypedText('del\x7fhere'), 'delhere');
  assert.equal(normalizeTypedText('esc\x1b[Ahere'), 'esc[Ahere');
  assert.equal(normalizeTypedText('\u0000\u0001\x7f'), '', 'nothing printable survives');
});

test('LF survives the control strip when newlines are allowed', () => {
  assert.equal(normalizeTypedText('a\nb', { allowNewlines: true }), 'a\nb');
});

test('non-strings and empty input yield the empty string', () => {
  for (const bad of [null, undefined, 0, 42, {}, [], true, '']) {
    assert.equal(normalizeTypedText(bad), '', `mishandled ${JSON.stringify(bad)}`);
  }
});

test('unicode and emoji are not mangled', () => {
  assert.equal(normalizeTypedText('naïve café — 日本語 🎧'), 'naïve café — 日本語 🎧');
});
