// tests/lib/format.test.mjs — pure-function coverage for tui/lib/format.js
// rendering primitives. Closes harden tasks 0011/0012 (fmtK), 0103 (fmtMoney),
// 0104 (fmtDuration), 0105 (barCells): the code was already correct, these are
// the previously-missing tests that pin the acceptance criteria.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtK, fmtMoney, fmtDuration, barCells, bar, sparkLine, trunc } from '../../tui/lib/format.js';

// ── fmtK (0011/0012) ───────────────────────────────────────────
test('fmtK: preserves negative sign and formats absolute magnitude', () => {
  assert.equal(fmtK(-1500), '-1.5k');
  assert.equal(fmtK(-999), '-999');
  assert.equal(fmtK(-12000), '-12.0k');
});

test('fmtK: positive thousands get one-decimal k suffix', () => {
  assert.equal(fmtK(1500), '1.5k');
  assert.equal(fmtK(999), '999');
  assert.equal(fmtK(0), '0');
});

test('fmtK: NaN / Infinity / null / undefined are sane (0)', () => {
  assert.equal(fmtK(NaN), '0');
  assert.equal(fmtK(Infinity), '0');
  assert.equal(fmtK(-Infinity), '0');
  assert.equal(fmtK(null), '0');
  assert.equal(fmtK(undefined), '0');
});

// ── fmtMoney (0103) ────────────────────────────────────────────
test('fmtMoney: always returns $N.NN (two decimals)', () => {
  assert.equal(fmtMoney(1.5), '$1.50');
  assert.equal(fmtMoney(0), '$0.00');
  assert.equal(fmtMoney(1234.5), '$1234.50');
  assert.match(fmtMoney(0.1 + 0.2), /^\$\d+\.\d{2}$/); // float noise still 2dp
});

test('fmtMoney: null / undefined coerce to $0.00', () => {
  assert.equal(fmtMoney(null), '$0.00');
  assert.equal(fmtMoney(undefined), '$0.00');
});

// ── fmtDuration (0104) ─────────────────────────────────────────
test('fmtDuration: HH:MM:SS zero-padded', () => {
  assert.equal(fmtDuration(0), '00:00:00');
  assert.equal(fmtDuration(3661 * 1000), '01:01:01');
  assert.equal(fmtDuration(59 * 1000), '00:00:59');
});

test('fmtDuration: >100h sessions render without breaking (hours grow, m/s stay 2-wide)', () => {
  const out = fmtDuration(100 * 3600 * 1000 + 2 * 60 * 1000 + 3 * 1000);
  assert.equal(out, '100:02:03');
  assert.match(out, /^\d{3,}:\d{2}:\d{2}$/);
});

// ── barCells (0105) ────────────────────────────────────────────
test('barCells: value 0 / 1 / >1 always yield exactly width cells', () => {
  for (const value of [0, 0.5, 1, 2, -1]) {
    assert.equal(barCells({ value, width: 10 }).length, 10, `width for value=${value}`);
  }
});

test('barCells: value=0 is all empty, value>=1 is all full', () => {
  const empty = barCells({ value: 0, width: 8 });
  assert.ok(empty.every((c) => c.kind === 'empty'), 'all empty at 0');
  const full = barCells({ value: 1, width: 8 });
  assert.ok(full.every((c) => c.kind === 'full'), 'all full at 1');
  const over = barCells({ value: 5, width: 8 });   // clamped to 1
  assert.ok(over.every((c) => c.kind === 'full'), 'clamped over-1 to full');
});

test('barCells: threshold marker lands within bounds', () => {
  const cells = barCells({ value: 0.2, width: 10, threshFrac: 0.8 });
  assert.equal(cells.length, 10);
  assert.equal(cells.filter((c) => c.kind === 'thresh').length, 1);
});

// ── supporting primitives (bar / sparkLine empty cases) ────────
test('bar: clamps value to [0,1] and never exceeds width', () => {
  const b = bar(2, 10);
  assert.ok(b.full <= 10);
  assert.equal(bar(-1, 10).full, 0);
});

test('sparkLine: empty / null / undefined input returns empty string', () => {
  assert.equal(sparkLine([], 14), '');
  assert.equal(sparkLine(null, 14), '');
  assert.equal(sparkLine(undefined, 14), '');
});

test('sparkLine: all-zero input renders nothing, not a flat low row (0106)', () => {
  assert.equal(sparkLine([0, 0, 0, 0], 14), '');
  assert.equal(sparkLine([0, 0, null, undefined], 14), '');
  // any nonzero sample ⇒ a real sparkline
  assert.notEqual(sparkLine([0, 0, 5, 0], 14), '');
});

// ── trunc grapheme-safety (0009/0010) ──────────────────────────
test('trunc: ASCII behavior unchanged (slice + ellipsis)', () => {
  assert.equal(trunc('hello world', 5), 'hell…');
  assert.equal(trunc('short', 10), 'short');
  assert.equal(trunc(null, 5), '');
});

test('trunc: never slices through a surrogate-pair emoji (0009)', () => {
  // 3 emoji = 6 UTF-16 code units but 3 graphemes; width 4 fits all 3.
  assert.equal(trunc('😀😀😀', 4), '😀😀😀');
  // width 2 ⇒ 1 grapheme + ellipsis. The OLD code-unit slice produced a lone
  // high-surrogate '\ud83d…'; grapheme-safe trunc yields a clean '😀…'.
  const out = trunc('😀😀😀', 2);
  assert.equal(out, '😀…');
  assert.ok(!/[\ud800-\udfff]/.test(out.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), 'no lone surrogate left');
});

test('trunc: keeps a ZWJ / combining grapheme cluster intact', () => {
  const fam = '👨‍👩‍👧'; // family emoji = one grapheme via ZWJ
  // fits in width 2 (1 grapheme) — returned whole, not cut mid-cluster.
  assert.equal(trunc(fam + 'x', 2), fam + 'x');
});
