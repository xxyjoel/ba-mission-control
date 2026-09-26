// tests/zoom/ptyPane.composerBanner.test.jsx — 0429.
//
// The bug: typing a long prompt in zoom, the row ABOVE the cursor vanished and
// came back only when the cursor moved onto it. Cause: the update-banner
// suppression (claudeBanner.js) ran on every row except the cursor row, and
// the owner's own prose matched it — "the update command would, after we have
// already installed…" is `update … installed`. Same bug class as 0366, which
// tightened the regex; a regex alone cannot tell prose from a banner.
//
// The fix: never suppress a row inside claude's composer. The screen below is
// a live capture (claude 2.1.283, 120 cols, 2026-09-26): the composer sits
// between two full-width `─` rules, with the cursor on its last row.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
};

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const RULE = '─'.repeat(120);
const PROSE = '❯ so i make sure im understadning you correctly - the update command would, after we have already installed a new';

function renderPane(stub) {
  return render(
    <PtyPane
      agent={stub.agent}
      width={120}
      height={12}
      focus={true}
      hideUpdateBanner={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
  );
}

test('0429: prose inside the composer is never hidden as an update banner', async () => {
  const stub = makeStubAgent({ cols: 120, rows: 12 });
  stub.term.write([
    ' Claude Code v2.1.283',
    '',
    RULE,
    PROSE,
    '  cladue code version, update an existing but old session',
    RULE,
    '  ⏸ manual mode on',
  ].join('\r\n'));
  // Park the cursor at the end of the composer's second row (row 5, 1-based).
  stub.term.write('\x1b[5;58H');
  const { lastFrame, unmount } = renderPane(stub);
  await tick();
  assert.ok(lastFrame().includes('the update command would, after we have already installed'),
    'the composer row above the cursor must stay visible');
  unmount();
});

test('0429: a real update banner outside the composer is still hidden', async () => {
  const stub = makeStubAgent({ cols: 120, rows: 12 });
  stub.term.write([
    ' Claude Code v2.1.283',
    '  ✓ Update installed · restart to apply',
    RULE,
    '❯ hello',
    RULE,
  ].join('\r\n'));
  stub.term.write('\x1b[4;8H');
  const { lastFrame, unmount } = renderPane(stub);
  await tick();
  assert.ok(!lastFrame().includes('Update installed'), 'the banner row is lifted out of the body');
  assert.ok(lastFrame().includes('hello'), 'the composer still renders');
  unmount();
});
