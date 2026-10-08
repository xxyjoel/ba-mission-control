// tests/zoom/ptyPane.footerModeLine.test.jsx — 0438.
//
// The bug: claude's mode line ("⏵⏵ accept edits on (shift+tab to cycle)")
// vanished in zoom. After a background auto-update claude shows
// "✓ Update installed · /restart to apply" at the top of its footer's right
// column — the SAME row as the mode text. matchUpdateBanner matched that row
// and PtyPane blanked the whole row, mode text included.
//
// The fix: rows below the composer's bottom rule (claude's footer) are never
// blanked. A notice there still raises the header chip (onClaudeUpdate).
//
// The rows come from a real capture (claude 2.1.294, mc's PtyAgent emulator,
// 110x26 zoom body): tests/fixtures/claude-modeline-2.1.294.json. The capture
// had no notice on screen; the test places it where claude's footer layout
// puts it — right-aligned on the mode row, pushing "◐ medium · /effort" down.

import React from 'react';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';
// renderAt, not ink-testing-library: that pins stdout to 100 columns, and the
// captured body is 110 wide — the mode row's right half would be cut off.
import { renderAt, tick, stripAnsi, THEME } from '../lib/render-size.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/claude-modeline-2.1.294.json', import.meta.url), 'utf8'));
const NOTICE = '✓ Update installed · /restart to apply';
const MODE_TEXT = {
  acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '⏸ plan mode on (shift+tab to cycle)',
  auto: '⏵⏵ auto mode on (shift+tab to cycle)',
  default: '⏸ manual mode on',
};

// Right-align `text` in a row of `cols`, after `left`.
const rightAlign = (left, text, cols) => left.padEnd(cols - 2 - [...text].length) + text;

// The captured rows with the notice on the mode row; the effort label it
// displaced moves to the row below (claude's right column is flex-end).
function withNoticeOnModeRow(run) {
  const lines = run.lines.slice();
  const modeRow = lines.findIndex((l) => l.includes(MODE_TEXT[run.mode]));
  assert.ok(modeRow > 0, `fixture has the ${run.mode} mode row`);
  const left = lines[modeRow].replace(/\s{3,}\S.*$/, '');
  const effort = lines[modeRow].slice(left.length).trim();
  lines.splice(modeRow, 1, rightAlign(left, NOTICE, run.cols), rightAlign('', effort, run.cols));
  return lines;
}

async function renderRun(run, lines) {
  const stub = makeStubAgent({ cols: run.cols, rows: run.rows });
  stub.term.write(lines.join('\r\n'));
  // Park the cursor in the composer, where claude keeps it.
  stub.term.write(`\x1b[${run.cursorY + 1};3H`);
  const updates = [];
  const r = renderAt(
    <PtyPane
      agent={stub.agent}
      width={run.cols}
      height={run.rows}
      focus={true}
      hideUpdateBanner={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      onClaudeUpdate={(b) => updates.push(b)}
      theme={THEME}
    />,
    { cols: run.cols + 10, rows: run.rows + 10 },
  );
  await tick();
  return { lastFrame: () => stripAnsi(r.lastFrame()), unmount: r.unmount, updates };
}

for (const run of FIXTURE.runs) {
  test(`0438: ${run.mode} mode line survives an update notice on its row`, async () => {
    const lines = withNoticeOnModeRow(run);
    const { lastFrame, unmount, updates } = await renderRun(run, lines);
    const frame = lastFrame();
    unmount();
    assert.ok(frame.includes(MODE_TEXT[run.mode]), `the ${run.mode} mode text must render`);
    assert.ok(updates.length > 0, 'the footer notice still raises the update chip');
  });
}

test('0438: a notice on the footer row below the mode line is not blanked either', async () => {
  const run = FIXTURE.runs.find((r) => r.mode === 'acceptEdits');
  const lines = run.lines.slice();
  const modeRow = lines.findIndex((l) => l.includes(MODE_TEXT.acceptEdits));
  lines[modeRow + 1] = rightAlign('', NOTICE, run.cols);
  const { lastFrame, unmount, updates } = await renderRun(run, lines);
  const frame = lastFrame();
  unmount();
  assert.ok(frame.includes(MODE_TEXT.acceptEdits));
  assert.ok(frame.includes('Update installed'), 'footer rows render as claude drew them');
  assert.ok(updates.length > 0);
});

test('0438: a notice in the body above the composer is still blanked', async () => {
  const run = FIXTURE.runs.find((r) => r.mode === 'plan');
  const lines = run.lines.slice();
  lines[3] = '  ' + NOTICE; // a blank body row above the composer's top rule
  const { lastFrame, unmount, updates } = await renderRun(run, lines);
  const frame = lastFrame();
  unmount();
  assert.ok(!frame.includes('Update installed'), 'the body notice is lifted out');
  assert.ok(frame.includes(MODE_TEXT.plan));
  assert.ok(updates.length > 0);
});
