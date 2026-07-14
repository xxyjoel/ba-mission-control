// tests/detectPrompt.test.mjs — pin down the assistant-text → structured
// prompt classifier. These cover current behavior; lettered-option cases
// are added incrementally as the parser learns them (step 3 of plan).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt } from '../server/agent.mjs';

test('returns null for empty / whitespace input', () => {
  assert.equal(detectPrompt(''), null);
  assert.equal(detectPrompt('   '), null);
  assert.equal(detectPrompt(null), null);
  assert.equal(detectPrompt(undefined), null);
});

test('returns null for plain prose with no question', () => {
  const text = 'Here is some plain text about the codebase.\nNo question, no list.';
  assert.equal(detectPrompt(text), null);
});

test('single-select: numbered list with question mark', () => {
  const text = [
    'Which approach do you prefer?',
    '1. Add a new column with default',
    '2. Backfill via separate migration',
    '3. Both — column + backfill',
  ].join('\n') + '\n?';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].num, 1);
  assert.equal(result.options[0].text, 'Add a new column with default');
  assert.equal(result.options[2].text, 'Both — column + backfill');
  assert.equal(result.total, 3);
});

test('single-select: numbered with paren style (1) 2) 3))', () => {
  const text = [
    'Pick one:',
    '1) First option',
    '2) Second option',
    '3) Third option',
  ].join('\n');
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 3);
});

test('multi-select: checkbox markdown wins over numbered when both present', () => {
  const text = [
    'Which features should we ship? Choose any:',
    '- [ ] Feature A',
    '- [ ] Feature B',
    '- [ ] Feature C',
  ].join('\n');
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'multi-select');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].preChecked, false);
});

test('multi-select: respects pre-checked state', () => {
  const text = [
    'Which apply?',
    '- [x] Already on',
    '- [ ] Not yet',
    '- [X] Also on',
  ].join('\n');
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'multi-select');
  assert.equal(result.options[0].preChecked, true);
  assert.equal(result.options[1].preChecked, false);
  assert.equal(result.options[2].preChecked, true);
});

test('caps options at 9; total reflects original count', () => {
  const lines = ['Choose one:'];
  for (let i = 1; i <= 12; i++) lines.push(`${i}. Option ${i}`);
  const result = detectPrompt(lines.join('\n'));
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 9);
  assert.equal(result.total, 12);
});

test('binary: question with proceed/continue trigger', () => {
  assert.equal(detectPrompt('Should I proceed?')?.kind, 'binary');
  assert.equal(detectPrompt('Want me to continue with the migration?')?.kind, 'binary');
  assert.equal(detectPrompt('OK to confirm?')?.kind, 'binary');
  assert.equal(detectPrompt('y/n?')?.kind, 'binary');
});

test('null: question without binary trigger and no list', () => {
  // "What's the time?" — has '?' but no proceed/continue/etc trigger.
  assert.equal(detectPrompt("What's the time?"), null);
});

test('single-select requires ≥2 list items', () => {
  const text = 'Pick one:\n1. Only choice';
  assert.equal(detectPrompt(text), null);
});

test('list without question/select cue does not trigger', () => {
  // Two numbered items but neither '?' nor any of {which, select, choose, pick, prefer, option}.
  const text = 'Recap:\n1. Did the thing\n2. Did the other thing\nDone.';
  assert.equal(detectPrompt(text), null);
});

test('select cue alone (without question mark) triggers single-select', () => {
  const text = 'Choose one of the following.\n1. Foo\n2. Bar';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
});

// ── Lettered prompt detection (step 3 of plan) ────────────────────────
// The screenshot scenario the user hit: assistant responds with
// "**Option A — ...**", "**Option B — ...**", "**Option C — ...**"
// (bold-wrapped lettered options). detectPrompt must classify this as
// single-select with labels preserved so chips render [A] [B] [C] and
// letter keys can dispatch.

test('lettered: bold "**Option A — ...**" style (screenshot scenario)', () => {
  const text = [
    'Here are three options, ordered by effort:',
    '',
    '**Option A — Fix the image path fallback bug** *(30 min, zero risk)*',
    '',
    '**Option B — Add a `--dry-run` pre-flight mode** *(medium, ~1 day)*',
    '',
    '**Option C — Promote to a structured `substack oneoff` CLI command** *(largest, ~2-3 days)*',
    '',
    'Which option would you prefer?',
  ].join('\n');
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select', 'should detect as single-select, not binary');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].label, 'A');
  assert.equal(result.options[1].label, 'B');
  assert.equal(result.options[2].label, 'C');
  // num is the letter index — A=1, B=2, C=3 — so digit shortcuts still work.
  assert.equal(result.options[0].num, 1);
  assert.equal(result.options[2].num, 3);
  // Body text strips bold markers and Option-marker prefix.
  assert.match(result.options[0].text, /Fix the image path/);
  assert.ok(!result.options[0].text.includes('**'));
});

test('lettered: bare "A. foo" style', () => {
  const text = 'Pick one:\nA. First\nB. Second\nC. Third';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].label, 'A');
  assert.equal(result.options[1].label, 'B');
  assert.equal(result.options[1].text, 'Second');
});

test('lettered: paren style "(a) foo" — lowercase normalized', () => {
  const text = 'Choose one:\n(a) First\n(b) Second';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 2);
  // Lowercase normalized to uppercase label.
  assert.equal(result.options[0].label, 'A');
  assert.equal(result.options[1].label, 'B');
});

test('lettered: bold standalone letter "**A:** foo"', () => {
  const text = 'Which?\n**A:** First option\n**B:** Second option';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0].label, 'A');
  assert.equal(result.options[0].text, 'First option');
});

test('priority: numbered wins over lettered if both present', () => {
  // Hypothetical: assistant produces both 1. 2. and A. B. — numbered
  // wins because that's the more explicit convention.
  const text = 'Pick:\n1. Numeric one\n2. Numeric two\nA. Lettered one\nB. Lettered two';
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'single-select');
  assert.equal(result.options[0].num, 1);
  // No label on numeric — the numbered path doesn't set it.
  assert.equal(result.options[0].label, undefined);
});

test('priority: checkboxes still win over lettered', () => {
  const text = [
    'Pick any:',
    '- [ ] One',
    '- [ ] Two',
    'Or alternatively:',
    'A. Three',
    'B. Four',
  ].join('\n');
  const result = detectPrompt(text);
  assert.equal(result?.kind, 'multi-select');
});

test('lettered requires question or select cue (no false positives)', () => {
  // "A. foo / B. bar" with no question mark and no select cue → null.
  const text = 'A. foo\nB. bar';
  assert.equal(detectPrompt(text), null);
});

test('lettered: skips proper noun starts that look like a list item', () => {
  // Lines starting with "A. " or "B. " etc. must have a *single* letter
  // followed by . / ) — common English sentences don't fit that shape,
  // but middle-initials would. We still require ≥2 such lines + a cue.
  const text = 'I met Dr. A. Smith and Dr. B. Jones at the meeting.';
  // This is one line with abbreviations; even if patterns match per line
  // they appear on the same line so they don't accumulate. Result: null.
  assert.equal(detectPrompt(text), null);
});
