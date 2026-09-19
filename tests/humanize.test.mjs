// tests/humanize.test.mjs — verifies the tier-2 preview sanitizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanize } from '../tui/lib/format.js';
import { homedir } from 'node:os';

test('null / undefined / empty become empty string', () => {
  assert.equal(humanize(null), '');
  assert.equal(humanize(undefined), '');
  assert.equal(humanize(''), '');
});

test('plain text passes through unchanged', () => {
  assert.equal(humanize('Found 3 matches'), 'Found 3 matches');
});

test('strips ANSI color codes', () => {
  const input = '\x1b[31mERROR\x1b[0m: file not found';
  assert.equal(humanize(input), 'ERROR: file not found');
});

test('strips multiple ANSI sequences', () => {
  const input = '\x1b[1;33mBOLD\x1b[0m and \x1b[4munderline\x1b[24m';
  assert.equal(humanize(input), 'BOLD and underline');
});

test('replaces $HOME with ~', () => {
  const home = homedir();
  const input = `Reading ${home}/Documents/file.txt`;
  assert.equal(humanize(input), 'Reading ~/Documents/file.txt');
});

test('collapses paths longer than 60 chars to …/leaf', () => {
  const input = '/very/deeply/nested/folder/with/many/segments/that/totals/over/sixty/characters/leaf.txt';
  const out = humanize(input);
  assert.match(out, /^…\/leaf\.txt$/);
});

test('leaves short paths unchanged', () => {
  const input = '/etc/hosts';
  assert.equal(humanize(input), '/etc/hosts');
});

test('shortens canonical UUIDs', () => {
  const input = 'session=ffa11b43-877c-42dc-bb05-0bec83279c9d started';
  assert.equal(humanize(input), 'session=ffa11b43… started');
});

test('shortens multiple UUIDs in one line', () => {
  const input = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890 -> ffa11b43-877c-42dc-bb05-0bec83279c9d';
  assert.equal(humanize(input), 'a1b2c3d4… -> ffa11b43…');
});

test('collapses long JSON objects to {…}', () => {
  const input = 'input={"command":"npm run build && npm test","cwd":"/some/path","timeout":30000}';
  const out = humanize(input);
  assert.match(out, /\{…\}/);
  assert.ok(!out.includes('npm run build'));
});

test('collapses long JSON arrays to […]', () => {
  const input = 'allowedPrompts=["one item","second item","third item","fourth item"]';
  const out = humanize(input);
  assert.match(out, /\[…\]/);
});

test('leaves short JSON unchanged', () => {
  const input = 'opts={"a":1}';
  assert.equal(humanize(input), 'opts={"a":1}');
});

test('strips OSC-52 clipboard-write sequence (BEL-terminated)', () => {
  // A file claude Read()s could carry \x1b]52;c;<base64>\x07 to write the
  // user's clipboard from the non-zoomed fleet view. Must not survive.
  const input = 'ok\x1b]52;c;ZXZpbA==\x07done';
  const out = humanize(input);
  assert.equal(out, 'okdone');
  assert.ok(!out.includes('52;'), 'OSC payload must be gone');
  assert.ok(!out.includes('\x1b'), 'no ESC byte may remain');
});

test('strips OSC window-title sequence (ST-terminated)', () => {
  const input = 'a\x1b]0;pwned-title\x1b\\b';
  assert.equal(humanize(input), 'ab');
});

test('strips OSC with no terminator (truncated preview)', () => {
  // Previews are length-bounded; an OSC-52 may be cut before its BEL/ST.
  const input = 'safe\x1b]52;c;dGFpbA';
  assert.equal(humanize(input), 'safe');
});

test('strips a lone ESC at end of string (truncated escape)', () => {
  assert.equal(humanize('done\x1b'), 'done');
});

test('strips ESC-introduced sequences, consuming the sequence final', () => {
  // ESC + a printable final IS a complete escape sequence — a terminal
  // consumes the final byte, and so does the sanitizer (safer: no escape
  // can leak by hiding its final char behind the ESC).
  assert.equal(humanize('a\x1b(0b'), 'ab');        // designate charset (nF)
  assert.equal(humanize('m\x1b=n'), 'mn');         // application keypad (Fp)
  assert.equal(humanize('r\x1bcs'), 'rs');         // RIS reset (Fs)
});

test('strips C0 control bytes incl. BEL, NUL, DEL; CR and tab collapse to a space (0408/R5)', () => {
  const input = 'a\rb\x07c\x00d\x7fe\tf';
  // BEL/NUL/DEL stripped outright; CR and tab are line-layout characters, so
  // they become one space each (every humanize() consumer is a one-row slot —
  // a literal newline was an unbudgeted frame row, a tab an 8-cell jump).
  assert.equal(humanize(input), 'a bcde f');
});

test('collapses newline/tab RUNS to a single space (0408/R5)', () => {
  // The \n itself becomes one space; pre-existing literal indent spaces stay
  // (spaces cost cells, not rows — only \r\n\t grow a one-row slot).
  assert.equal(humanize('cd /tmp && \\\n  npm test && \\\n  echo done'),
    'cd /tmp && \\   npm test && \\   echo done');
  assert.equal(humanize('a\r\n\t\nb'), 'a b');
  assert.equal(humanize('one\ntwo'), 'one two');
});

test('strips 8-bit C1 controls — CSI U+009B, OSC U+009D, NEL U+0085 (0408/S3)', () => {
  // xterm.js parses U+009B as CSI and U+009D as OSC with NO ESC byte, so the
  // 7-bit strippers never fired and the payload reached the host terminal.
  assert.equal(humanize('a2Jb'), 'ab', 'C1 CSI: params + final are part of the sequence');
  assert.equal(humanize('a31mRED'), 'aRED');
  assert.equal(humanize('a52;c;aGVsbG8=b'), 'ab', 'C1 OSC consumed through ST');
  assert.equal(humanize('a52;c;aGVsbG8=\x07b'), 'ab', 'C1 OSC consumed through BEL');
  assert.equal(humanize('a52;c;aGVsbG8='), 'a', 'unterminated C1 OSC consumed to end');
  assert.equal(humanize('ab'), 'ab', 'stray C1 (NEL) swept');
  assert.equal(humanize('aq#0;2;0;0;0~~b'), 'ab', 'C1 DCS payload consumed');
});

test('strips 7-bit DCS payload, not just its introducer (0408/S3)', () => {
  // The old ESCSEQ stripper ate ESC-P but left the sixel body as printable
  // garbage: "aq#0;2;0;0;0#0~~b".
  assert.equal(humanize('a\x1bPq#0;2;0;0;0#0~~\x1b\\b'), 'ab');
});

test('strips a combined OSC-52 + bare-ESC + CR payload (acceptance)', () => {
  const input = 'before\x1b]52;c;ZA==\x07\x1b[31m\rmid\x1bxafter';
  const out = humanize(input);
  assert.equal(out, 'before midafter'); // the CR collapses to one space (0408/R5)
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out), 'no control bytes remain');
});

test('idempotent across the broadened stripper', () => {
  const messy = 'a\x1b]52;c;ZA==\x07\rb\x1b[1mc\x1bx2J52;c;ZA==\x07d\ne';
  const once = humanize(messy);
  assert.equal(humanize(once), once);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(once));
});

test('idempotent: humanize(humanize(x)) === humanize(x)', () => {
  const messy = [
    '\x1b[31m',
    homedir(), '/Library/CloudStorage/very/deep/path/to/some/very/deeply/nested/file.txt',
    ' session=ffa11b43-877c-42dc-bb05-0bec83279c9d ',
    'input={"command":"big payload with lots of content","timeout":30000}',
    '\x1b[0m',
  ].join('');
  const once = humanize(messy);
  const twice = humanize(once);
  assert.equal(once, twice, 'second pass must produce same output');
});

test('handles non-string input gracefully', () => {
  assert.equal(humanize(42), '42');
  assert.equal(humanize(true), 'true');
});
