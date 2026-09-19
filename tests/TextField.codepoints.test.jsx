// tests/TextField.codepoints.test.jsx — 0408/I7. Cursor math stepped by
// UTF-16 code UNIT, so an emoji (two units, one surrogate pair) got cut in
// half: Backspace after "a😀" left "a\ud83d", and ←-then-type inserted
// between the halves. All motion and edits now step by CODE POINT.
// Evidence before the fix: scratchpad probeE.textfield.test.jsx.
//
// Also pins the 0408/I6 maxRows window: a multi-line value renders at most
// maxRows rows, the window following the caret.

import React, { useState } from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import TextField from '../tui/lib/TextField.jsx';

const strip = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function H({ initial, log, maxRows }) {
  const [v, setV] = useState(initial);
  return <TextField value={v} onChange={(n) => { log.push(n); setV(n); }} onSubmit={(s) => log.push('SUBMIT:' + s)} maxRows={maxRows} />;
}

test('I7: Backspace after an emoji deletes the WHOLE emoji, never half a pair', async () => {
  const log = [];
  const { stdin, unmount } = render(<H initial={'a😀'} log={log} />);
  await tick(); await tick();
  stdin.write('\x7f'); await tick(); await tick();
  assert.equal(log.at(-1), 'a', `expected "a", got ${JSON.stringify(log.at(-1))}`);
  assert.ok(!lone(log.at(-1)), 'no lone surrogate');
  unmount();
});

test('I7: ← then typing lands BEFORE the emoji, not inside the pair', async () => {
  const log = [];
  const { stdin, unmount } = render(<H initial={'a😀'} log={log} />);
  await tick(); await tick();
  stdin.write('\x1b[D'); await tick();   // left arrow: one code point left
  stdin.write('x'); await tick(); await tick();
  assert.equal(log.at(-1), 'ax😀', `expected "ax😀", got ${JSON.stringify(log.at(-1))}`);
  assert.ok(!lone(log.at(-1)));
  unmount();
});

test('I7: two backspaces after "a😀" empty the field cleanly', async () => {
  const log = [];
  const { stdin, unmount } = render(<H initial={'a😀'} log={log} />);
  await tick(); await tick();
  stdin.write('\x7f'); await tick();
  stdin.write('\x7f'); await tick(); await tick();
  assert.equal(log.at(-1), '');
  unmount();
});

test('I7: CJK (one code unit per char) still deletes one character at a time', async () => {
  const log = [];
  const { stdin, unmount } = render(<H initial={'日本語'} log={log} />);
  await tick(); await tick();
  stdin.write('\x7f'); await tick(); await tick();
  assert.equal(log.at(-1), '日本');
  unmount();
});

test('I6: maxRows caps the rendered rows and the window follows the caret', async () => {
  const log = [];
  const value = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const { lastFrame, unmount } = render(<H initial={value} log={log} maxRows={3} />);
  await tick(); await tick();
  const frame = strip(lastFrame());
  const rows = frame.split('\n');
  assert.ok(rows.length <= 3, `expected ≤3 rows, got ${rows.length}:\n${frame}`);
  assert.match(frame, /line 10/, 'caret row (end of value) is visible');
  assert.doesNotMatch(frame, /line 1\b/, 'early rows scrolled out of the window');
  unmount();
});

test('I6: without maxRows every line still renders (no behavior change for uncapped callers)', async () => {
  const log = [];
  const value = 'one\ntwo\nthree';
  const { lastFrame, unmount } = render(<H initial={value} log={log} />);
  await tick(); await tick();
  const frame = strip(lastFrame());
  for (const w of ['one', 'two', 'three']) assert.match(frame, new RegExp(w));
  unmount();
});
