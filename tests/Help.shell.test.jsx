// tests/Help.shell.test.jsx — verifies that the Help modal lists the shell
// overlay hotkeys (! open, ctrl+q close, forward-all note) added in task 0327.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Help from '../tui/modals/Help.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const noop = () => {};

test('Help modal lists ! to open the shell overlay', () => {
  const { lastFrame, unmount } = render(
    <Help onClose={noop} theme={theme} />
  );
  const frame = lastFrame() || '';
  assert.match(frame, /Open shell overlay/, 'should document the shell overlay entry');
  assert.ok(frame.includes('!'), 'should show ! as the keybinding');
  unmount();
});

test('Help modal lists ctrl+q to close the shell overlay', () => {
  const { lastFrame, unmount } = render(
    <Help onClose={noop} theme={theme} />
  );
  const frame = lastFrame() || '';
  assert.match(frame, /ctrl\+q/, 'should show ctrl+q as the close binding');
  unmount();
});

test('Help modal notes that all other keys forward to the shell', () => {
  const { lastFrame, unmount } = render(
    <Help onClose={noop} theme={theme} />
  );
  const frame = lastFrame() || '';
  assert.match(frame, /all other keys.*shell/, 'should note all other keys → shell');
  unmount();
});
