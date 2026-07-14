// tests/recipes/newsession.recipes.test.jsx — declarative coverage for
// the single-input new-session launcher. Mirrors the hand-written tests
// in tests/NewSession.test.jsx but in the recipe DSL.

import { test, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import NewSession from '../../tui/modals/NewSession.jsx';
import { runRecipe } from '../lib/recipe.js';
import { theme } from '../lib/fixtures.js';

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

function newSessionProps(overrides = {}) {
  return {
    slot: 1,
    repos: [fakeRepo('alpha'), fakeRepo('beta')],
    onLaunch: noop,
    onClose: noop,
    theme,
    ...overrides,
  };
}

test('recipe: renders path input + suggestion list + model line', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps(),
    steps: [
      { expectFrame: [/NEW SESSION/, /path/, /alpha/, /beta/, /model/] },
    ],
  });
});

test('recipe: typing filters recents by substring', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps({
      repos: [fakeRepo('alpha'), fakeRepo('alphabet'), fakeRepo('beta')],
    }),
    steps: [
      { type: 'alph' },
      { expectFrame: [/alpha/, /alphabet/], expectNotFrame: [/beta/] },
    ],
  });
});

test('recipe: ↵ launches the highlighted suggestion', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps({
      slot: 4,
      repos: [fakeRepo('alpha', '/abs/alpha'), fakeRepo('beta', '/abs/beta')],
    }),
    steps: [
      { press: '\r' },
      { expectCallback: ['onLaunch', (calls) =>
          calls.length === 1 &&
          calls[0][0].slot === 4 &&
          calls[0][0].repoPath === '/abs/alpha' &&
          calls[0][0].branch === 'main',
      ] },
    ],
  });
});

test('recipe: ↓ then ↵ launches the second suggestion', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps({
      repos: [fakeRepo('alpha', '/abs/alpha'), fakeRepo('beta', '/abs/beta')],
    }),
    steps: [
      { press: '\x1b[B' },  // ↓
      { press: '\r' },
      { expectCallback: ['onLaunch', (calls) =>
          calls.length === 1 && calls[0][0].repoPath === '/abs/beta',
      ] },
    ],
  });
});

test('recipe: esc closes the modal', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps(),
    steps: [
      { press: '\x1b' },
      { tick: 120 },
      { expectCallback: ['onClose', 1] },
    ],
  });
});

// Filesystem fallback path: with no recent repos to match, typing a
// real directory and pressing ↵ launches it directly.
let fsRoot;
before(() => {
  fsRoot = mkdtempSync(join(tmpdir(), 'mc-newsession-recipe-'));
  mkdirSync(join(fsRoot, 'alpha-project'));
  mkdirSync(join(fsRoot, 'beta-thing'));
});
after(() => { try { rmSync(fsRoot, { recursive: true, force: true }); } catch {} });

test('recipe: typing a real path surfaces FS children in the dropdown', async () => {
  await runRecipe({
    component: NewSession,
    props: newSessionProps({ repos: [] }),
    steps: [
      { type: `${fsRoot}/alpha` },
      { tick: 80 },
      { expectFrame: [/alpha-project/] },
    ],
  });
});

test('recipe: ↵ on a typed real path with no suggestion match still launches', async () => {
  const target = join(fsRoot, 'beta-thing');
  await runRecipe({
    component: NewSession,
    props: newSessionProps({ repos: [] }),
    steps: [
      { type: target },
      { tick: 80 },
      { press: '\r' },
      { expectCallback: ['onLaunch', (calls) =>
          calls.length === 1 && calls[0][0].repoPath === target,
      ] },
    ],
  });
});
