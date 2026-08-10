// tests/Help.shell.test.jsx — verifies that the Help modal lists the shell
// overlay hotkeys (! open, ctrl+q close, forward-all note) added in task 0327.
//
// Since 618c26f the Help modal is a SCROLLABLE window: at the default 24-row test
// terminal only ~9 lines fit, so a single lastFrame() shows just the top and the
// COMMANDS section (where the shell rows live) is below the fold. To verify a row
// is DOCUMENTED regardless of where it scrolls, page through the whole list and
// union every frame — paging by `capacity` yields contiguous windows that cover
// every line. This also exercises the real PgDn scroll path.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Help from '../tui/modals/Help.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const noop = () => {};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Render Help and scroll top→bottom, returning the union of every window shown.
async function fullHelpText(view = 'main') {
  const { lastFrame, stdin, unmount } = render(
    <Help onClose={noop} theme={theme} view={view} />
  );
  const seen = [lastFrame() || ''];
  // Space = PgDn in Help. 12 pages × capacity comfortably covers the ~80-line
  // keymap; clamped pages past the end are harmless no-ops.
  for (let i = 0; i < 12; i++) {
    stdin.write(' ');
    await tick();
    seen.push(lastFrame() || '');
  }
  unmount();
  return seen.join('\n');
}

test('Help modal lists ! to open the shell overlay', async () => {
  const text = await fullHelpText();
  assert.match(text, /Open shell overlay/, 'should document the shell overlay entry');
  assert.ok(text.includes('!'), 'should show ! as the keybinding');
});

test('Help modal lists ctrl+q to close the shell overlay', async () => {
  const text = await fullHelpText();
  assert.match(text, /close \(all other keys/, 'should show the shell-close row');
  assert.match(text, /ctrl\+q/, 'should show ctrl+q as the close binding');
});

test('Help modal notes that all other keys forward to the shell', async () => {
  const text = await fullHelpText();
  assert.match(text, /all other keys.*shell/, 'should note all other keys → shell');
});
