// tests/RepoPicker.test.jsx — the filesystem-browser modal used to choose
// where New Session scans for repos. Renders against a real temp dir so the
// async readdir path is exercised. ink-testing-library supplies the TTY.

import React from 'react';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import RepoPicker from '../tui/modals/RepoPicker.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-repopicker-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  mkdirSync(join(root, '.hidden'));          // should be filtered out
  mkdirSync(join(root, 'node_modules'));      // should be filtered out
  writeFileSync(join(root, 'afile.txt'), 'x'); // files are not listed
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

const tick = () => new Promise((r) => setTimeout(r, 30));
async function press(stdin, key) {
  await tick();
  stdin.write(key);
  await tick();
}

test('RepoPicker: lists real subdirs, hides dotfiles / node_modules / files', async () => {
  const { lastFrame, unmount } = render(
    <RepoPicker start={root} current={[]} onPick={() => {}} onClose={() => {}} theme={theme} />
  );
  await tick(); // let the readdir effect resolve
  const frame = lastFrame() || '';
  assert.match(frame, /alpha/, 'shows alpha');
  assert.match(frame, /beta/, 'shows beta');
  assert.match(frame, /up a level/, 'shows the ../ up-entry (not at fs root)');
  assert.doesNotMatch(frame, /hidden/, 'hides dotfiles');
  assert.doesNotMatch(frame, /node_modules/, 'hides node_modules');
  assert.doesNotMatch(frame, /afile/, 'does not list plain files');
  unmount();
});

test('RepoPicker: ↵ on a highlighted child picks its absolute path', async () => {
  const picks = [];
  const { stdin, unmount } = render(
    <RepoPicker start={root} current={[]} onPick={(p) => picks.push(p)} onClose={() => {}} theme={theme} />
  );
  // idx 0 is the ".." up-entry; move down once to land on "alpha".
  await press(stdin, 'j');
  await press(stdin, '\r');
  assert.equal(picks.length, 1, 'Enter on a child should pick once');
  assert.equal(picks[0], join(root, 'alpha'));
  unmount();
});

test('RepoPicker: "." picks the folder currently being browsed', async () => {
  const picks = [];
  const { stdin, unmount } = render(
    <RepoPicker start={root} current={[]} onPick={(p) => picks.push(p)} onClose={() => {}} theme={theme} />
  );
  await press(stdin, '.');
  assert.equal(picks.length, 1);
  assert.equal(picks[0], root, '"." picks cwd itself, not a child');
  unmount();
});

test('RepoPicker: esc closes without picking', async () => {
  let closed = false;
  const picks = [];
  const { stdin, unmount } = render(
    <RepoPicker start={root} current={[]} onPick={(p) => picks.push(p)} onClose={() => { closed = true; }} theme={theme} />
  );
  await press(stdin, '\x1b'); // esc
  assert.equal(closed, true, 'esc should close');
  assert.equal(picks.length, 0, 'esc should not pick');
  unmount();
});
