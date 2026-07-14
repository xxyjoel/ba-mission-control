// tests/NewSession.test.jsx — verifies the single-input launcher.
//
// The modal is now one TextField + a suggestion dropdown blended from
// (1) recent repos that match the substring query and (2) filesystem
// child directories when the query looks like a path. Plain ↵ launches
// the highlighted suggestion (or the typed path if it exists). ←/→
// cycles the model. esc closes.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import NewSession from '../tui/modals/NewSession.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const noop = () => {};

function fakeRepo(name, absPath) {
  return {
    name,
    parent: '~/projects',
    path: `~/projects/${name}`,
    absPath: absPath || `/Users/test/projects/${name}`,
    last: 'just now',
    defaultBranch: 'main',
    remote: '(local)',
  };
}

// ink-testing-library writes input synchronously but the component's
// effects run on microtasks; small waits let the suggestion list and
// re-render settle.
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

test('NewSession: renders the path input, suggestion list, and model line', () => {
  const { lastFrame, unmount } = render(
    <NewSession
      slot={1}
      repos={[fakeRepo('alpha'), fakeRepo('beta')]}
      onLaunch={noop}
      onClose={noop}
      theme={theme}
    />
  );
  const frame = lastFrame() || '';
  assert.match(frame, /NEW SESSION/);
  assert.match(frame, /path/);
  assert.match(frame, /alpha/);
  assert.match(frame, /beta/);
  assert.match(frame, /model/);
  unmount();
});

test('NewSession: typing filters recents by substring (case-insensitive)', async () => {
  const { lastFrame, stdin, unmount } = render(
    <NewSession
      slot={1}
      repos={[fakeRepo('alpha-svc'), fakeRepo('beta-api'), fakeRepo('alphabet')]}
      onLaunch={noop}
      onClose={noop}
      theme={theme}
    />
  );
  for (const ch of 'ALPH') await press(stdin, ch);
  const frame = lastFrame() || '';
  assert.match(frame, /alpha-svc/);
  assert.match(frame, /alphabet/);
  assert.ok(!/beta-api/.test(frame), 'beta-api should be filtered out');
  unmount();
});

test('NewSession: ↵ on the default highlight launches the first match', async () => {
  const calls = [];
  const { stdin, unmount } = render(
    <NewSession
      slot={4}
      repos={[fakeRepo('alpha', '/abs/alpha'), fakeRepo('beta', '/abs/beta')]}
      onLaunch={(p) => calls.push(p)}
      onClose={noop}
      theme={theme}
    />
  );
  await press(stdin, '\r'); // Enter on the default-highlighted top row
  assert.equal(calls.length, 1, 'should fire onLaunch once');
  assert.equal(calls[0].slot, 4);
  assert.equal(calls[0].repoPath, '/abs/alpha');
  assert.equal(calls[0].branch, 'main');
  unmount();
});

test('NewSession: Tab → ↓ then ↵ launches the second suggestion', async () => {
  const calls = [];
  const { stdin, unmount } = render(
    <NewSession
      slot={2}
      repos={[fakeRepo('alpha', '/abs/alpha'), fakeRepo('beta', '/abs/beta')]}
      onLaunch={(p) => calls.push(p)}
      onClose={noop}
      theme={theme}
    />
  );
  await press(stdin, '\t');     // Tab → switch focus to list
  await press(stdin, '\x1b[B'); // down arrow → now navigates suggestion list
  await press(stdin, '\r');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoPath, '/abs/beta');
  unmount();
});

test('NewSession: ↵ on a typed real path launches it even with no suggestion match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-typed-'));
  const target = join(root, 'plainproject');
  mkdirSync(target);
  const calls = [];
  const { stdin, unmount } = render(
    <NewSession
      slot={7}
      repos={[]} // no recents → no suggestion list, fallback to literal path
      onLaunch={(p) => calls.push(p)}
      onClose={noop}
      theme={theme}
    />
  );
  for (const ch of target) await press(stdin, ch);
  await press(stdin, '\r');
  assert.equal(calls.length, 1, 'should launch literal path with no suggestions');
  assert.equal(calls[0].repoPath, target);
  unmount();
  rmSync(root, { recursive: true, force: true });
});

test('NewSession: Tab → ← / → cycles the model (path focus ignores arrows)', async () => {
  const { lastFrame, stdin, unmount } = render(
    <NewSession
      slot={1}
      repos={[]}
      defaultModel="sonnet-4.6"
      onLaunch={noop}
      onClose={noop}
      theme={theme}
    />
  );
  const initial = lastFrame() || '';
  // Arrow in path focus must NOT change the model — TextField owns
  // the cursor and the modal stays out of the way.
  await press(stdin, '\x1b[C');
  const stillPathFocus = lastFrame() || '';
  // Frame may still differ slightly due to focus indicator, but model
  // line shouldn't change. Easier check: the model selector text on
  // the focus header still says 'path'.
  assert.ok(/focus \[path\]/.test(stillPathFocus), 'still in path focus after arrow');

  // Tab into list focus, then ← / → must cycle the model.
  await press(stdin, '\t');
  const inListFocus = lastFrame() || '';
  await press(stdin, '\x1b[C');
  const afterCycle = lastFrame() || '';
  assert.notEqual(inListFocus, afterCycle, 'model cycles after Tab → →');
  assert.notEqual(initial, afterCycle, 'frame must change after model cycle');
  unmount();
});

test('NewSession: esc fires onClose', async () => {
  let closed = false;
  const { stdin, unmount } = render(
    <NewSession
      slot={1}
      repos={[fakeRepo('alpha')]}
      onLaunch={noop}
      onClose={() => { closed = true; }}
      theme={theme}
    />
  );
  await press(stdin, '\x1b'); // raw ESC
  assert.equal(closed, true);
  unmount();
});

test('NewSession: Ctrl+B opens the filesystem browser', async () => {
  const { lastFrame, stdin, unmount } = render(
    <NewSession
      slot={1}
      repos={[fakeRepo('alpha')]}
      onLaunch={noop}
      onClose={noop}
      theme={theme}
    />
  );
  // Sanity: main view first
  assert.match(lastFrame() || '', /NEW SESSION/);
  await press(stdin, '\x02'); // Ctrl+B
  const frame = lastFrame() || '';
  // RepoPicker header replaces the NewSession header.
  assert.match(frame, /PICK REPO LOCATION/);
  unmount();
});

test('NewSession: ↵ on a non-existent path shows an error, no launch', async () => {
  const calls = [];
  const { lastFrame, stdin, unmount } = render(
    <NewSession
      slot={1}
      repos={[]}
      onLaunch={(p) => calls.push(p)}
      onClose={noop}
      theme={theme}
    />
  );
  for (const ch of '/definitely/not/a/real/path/zzz') await press(stdin, ch);
  await press(stdin, '\r');
  assert.equal(calls.length, 0, 'should not launch a nonexistent path');
  const frame = lastFrame() || '';
  assert.match(frame, /not a directory/);
  unmount();
});
