// tests/ptyAgent.bottomContentRows.test.mjs — 0404.
//
// Sessions now run their claude at the zoom body geometry (e.g. 214x40) for
// their whole life instead of 80x24. That broke a hidden assumption in the
// permission-prompt and active-turn scanners: they read the bottom 12 rows of
// the BUFFER, and claude renders inline — below its composer sit however many
// rows the transcript has not reached yet. Measured on a real 40-row session,
// 9 of the bottom 10 buffer rows were blank, so a fixed bottom-12 window saw
// 2 rows of content and the prompt's anchors fell outside it. The card would
// have silently stopped showing NEEDS INPUT — the worst kind of regression in
// the subsystem the user has been chasing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/headless';
import { bottomContentRows, detectApprovalPrompt, detectWorking } from '../server/ptyAgent.mjs';

const { Terminal } = xtermPkg.default || xtermPkg;

// claude's permission prompt, as the detectors' triple-anchor expects it.
const PROMPT = [
  'Bash(npm test)',
  '  npm test',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. Yes, and don\'t ask again',
  '  3. No, and tell Claude what to do differently',
];

// xterm's write() is asynchronous — the parser flushes on its own schedule, so
// every test has to await the write callback before reading the buffer.
function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

async function termWith(lines, { cols = 214, rows = 40 } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  await write(term, lines.join('\r\n'));
  return term;
}

test('bottomContentRows skips claude\'s trailing blank rows', async () => {
  // 7 prompt rows written into a 40-row terminal → 33 blank rows below them.
  const term = await termWith(PROMPT);
  const rows = bottomContentRows(term, 12);
  assert.equal(rows.length, PROMPT.length, 'every written row, no blanks');
  assert.equal(rows.at(-1), PROMPT.at(-1), 'last row is claude\'s last written row, not a blank');
  assert.ok(rows.includes('Do you want to proceed?'));
  assert.ok(rows.some((r) => r.includes('1. Yes')));
});

test('0404: the permission prompt is still detected on a tall PTY', async () => {
  for (const rows of [24, 36, 40, 60]) {
    const term = await termWith(PROMPT, { rows });
    assert.equal(
      detectApprovalPrompt(bottomContentRows(term, 12)), true,
      `approval prompt missed at ${rows} rows — the card would never show NEEDS INPUT`,
    );
  }
});

test('0404: a fixed bottom-of-buffer window WOULD have missed it (pins the regression)', async () => {
  const term = await termWith(PROMPT, { rows: 40 });
  const buf = term.buffer.active;
  const naive = [];
  for (let y = Math.max(0, buf.length - 12); y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line) naive.push(line.translateToString(true));
  }
  assert.equal(
    detectApprovalPrompt(naive), false,
    'if this now passes, claude stopped leaving blank rows below its composer and this '
    + 'test no longer pins anything — re-measure before deleting it',
  );
});

test('0404: the active-turn hint is still detected on a tall PTY', async () => {
  const lines = ['thinking…', '  ✳ Frobnicating (esc to interrupt · ctrl+t to hide todos)'];
  for (const rows of [24, 40, 60]) {
    const term = await termWith(lines, { rows });
    assert.equal(detectWorking(bottomContentRows(term, 12)), true, `missed at ${rows} rows`);
  }
});

test('bottomContentRows returns at most `want` rows, oldest-first', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `row${String(i).padStart(2, '0')}`);
  const term = await termWith(many, { rows: 40 });
  const rows = bottomContentRows(term, 12);
  assert.equal(rows.length, 12);
  assert.equal(rows[0], 'row28');
  assert.equal(rows.at(-1), 'row39');
});

test('bottomContentRows is safe on an empty, blank or missing terminal', () => {
  assert.deepEqual(bottomContentRows(null, 12), []);
  assert.deepEqual(bottomContentRows({}, 12), []);
  const blank = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  assert.deepEqual(bottomContentRows(blank, 12), [], 'an all-blank screen yields no rows');
  assert.equal(detectApprovalPrompt(bottomContentRows(blank, 12)), false);
});

test('bottomContentRows does not walk the whole scrollback looking for content', async () => {
  // 5000 lines of history, then a screenful of blanks: the walk must give up
  // within one screen + want, not translate 5000 lines on every frame.
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 5000 });
  await write(term, Array.from({ length: 500 }, (_, i) => `old${i}`).join('\r\n'));
  await write(term, '\r\n'.repeat(60));   // push the content well above the screen
  const t0 = process.hrtime.bigint();
  const rows = bottomContentRows(term, 12);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  assert.ok(rows.length <= 12);
  assert.ok(us < 5000, `took ${us.toFixed(0)}µs — too slow for a per-frame read`);
});
