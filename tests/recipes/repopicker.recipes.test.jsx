// tests/recipes/repopicker.recipes.test.jsx — recipe-style coverage for
// the filesystem-browser modal. Uses a real tmpdir so the async readdir
// path is exercised end-to-end.

import { test, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RepoPicker from '../../tui/modals/RepoPicker.jsx';
import { runRecipe } from '../lib/recipe.js';
import { theme } from '../lib/fixtures.js';

const noop = () => {};

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-repopicker-recipes-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  mkdirSync(join(root, 'gamma'));
  mkdirSync(join(root, '.hidden'));            // filtered: dotfile
  mkdirSync(join(root, 'node_modules'));       // filtered: ignored dir
  mkdirSync(join(root, 'alpha', 'nested'));    // for descend test
  writeFileSync(join(root, 'afile.txt'), 'x'); // filtered: not a dir
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function pickerProps(overrides = {}) {
  return {
    start: root,
    current: [],
    onPick: noop,
    onClose: noop,
    theme,
    ...overrides,
  };
}

test('recipe: lists real subdirs, filters dotfiles / node_modules / files', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 }, // let async readdir resolve
      { expectFrame: [/alpha/, /beta/, /gamma/, /up a level/],
        expectNotFrame: [/hidden/, /node_modules/, /afile/] },
    ],
  });
});

test('recipe: ↵ on a highlighted child picks its absolute path', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 },
      { press: 'j' },                              // idx 0 = "..", move to "alpha"
      { press: '\r' },
      { expectCallback: ['onPick', (calls) =>
          calls.length === 1 && calls[0][0] === join(root, 'alpha')] },
    ],
  });
});

test('recipe: "." picks the folder currently being browsed', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 },
      { press: '.' },
      { expectCallback: ['onPick', (calls) =>
          calls.length === 1 && calls[0][0] === root] },
    ],
  });
});

test('recipe: esc closes without picking', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 },
      { press: '\x1b' },
      { expectCallback: ['onClose', 1] },
      { expectCallback: ['onPick', 0] },
    ],
  });
});

test('recipe: j navigates down, k navigates up', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 },
      { press: 'j' },           // ".." → alpha
      { press: 'j' },           // alpha → beta
      { press: '\r' },
      { expectCallback: ['onPick', (calls) =>
          calls.length === 1 && calls[0][0] === join(root, 'beta')] },
    ],
  });
});

test('recipe: l descends into a subfolder, h goes back up', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps(),
    steps: [
      { tick: 50 },
      { press: 'j' },                              // ".." → alpha
      { press: 'l' },                              // descend into alpha/
      { tick: 50 },                                // readdir of alpha/
      { expectFrame: [/nested/] },                 // shows alpha's child
      { press: 'h' },                              // back up to root
      { tick: 50 },                                // readdir of root again
      { expectFrame: [/alpha/, /beta/, /gamma/] }, // siblings reappear
    ],
  });
});

test('recipe: → on the ".." row goes up a level', async () => {
  // Start a level deep, then the first row is "..". Right-arrow on it
  // should go back to the parent.
  await runRecipe({
    component: RepoPicker,
    props: pickerProps({ start: join(root, 'alpha') }),
    steps: [
      { tick: 50 },
      { expectFrame: [/nested/, /up a level/] },
      { press: '\x1b[C' },                         // → on ".." → goUp
      { tick: 50 },
      { expectFrame: [/alpha/, /beta/, /gamma/] },
    ],
  });
});

test('recipe: current locations render in the "current:" line', async () => {
  await runRecipe({
    component: RepoPicker,
    props: pickerProps({ current: [join(root, 'alpha'), join(root, 'beta')] }),
    steps: [
      { tick: 50 },
      { expectFrame: [/current:/, /alpha/, /beta/] },
    ],
  });
});
