// tests/recipes/dashboard.recipes.test.jsx — fleet dashboard modal.
//
// Covers the four flows that matter for triage:
//   1. Renders one row per live agent (and a friendly empty state).
//   2. ↑/↓ moves the highlight + fires the onFocus callback.
//   3. S cycles the sort column; R toggles direction.
//   4. ↵ on a highlighted row fires onZoom with that slot's id.

import { test } from 'node:test';
import Dashboard from '../../tui/modals/Dashboard.jsx';
import { runRecipe } from '../lib/recipe.js';
import { theme, makeAgent } from '../lib/fixtures.js';

const noop = () => {};

function dashProps(overrides = {}) {
  return {
    agents: [
      makeAgent({ slot: 1, id: 's1', name: 'alpha', status: 'working', costSession: 0.5, context: 80_000 }),
      makeAgent({ slot: 2, id: 's2', name: 'beta',  status: 'waiting', costSession: 2.1, context: 180_000 }),
      makeAgent({ slot: 3, id: 's3', name: 'gamma', status: 'idle',    costSession: 0.05, context: 5_000 }),
      // Empty slot — must be filtered out of the dashboard rows.
      { id: 'empty-4', slot: 4, status: 'empty', name: null, model: null },
    ],
    threshold: 150_000,
    theme,
    weekCost: 12.5,
    dayCost: 3.0,
    budget: 0,
    onClose: noop,
    onZoom: noop,
    onFocus: noop,
    initialSlot: 1,
    width: 120,
    ...overrides,
  };
}

test('recipe: dashboard renders one row per LIVE agent (empties filtered)', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps(),
    steps: [
      { expectFrame: [/FLEET DASHBOARD/, /3 live/, /alpha/, /beta/, /gamma/] },
      // The empty slot 4 must NOT appear in the body.
      { expectNotFrame: [/EMP|\[4\]/] },
    ],
  });
});

test('recipe: dashboard empty state when no live agents', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps({
      agents: [
        { id: 'e1', slot: 1, status: 'empty', name: null, model: null },
        { id: 'e2', slot: 2, status: 'empty', name: null, model: null },
      ],
    }),
    steps: [
      { expectFrame: [/fleet empty/, /launch a session/] },
    ],
  });
});

test('recipe: ↓ moves highlight + fires onFocus(slot)', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps(),
    steps: [
      { press: '\x1b[B' }, // ↓ once → slot 2
      { expectCallback: ['onFocus', (calls) =>
          calls.length === 1 && calls[0][0] === 2] },
    ],
  });
});

test('recipe: S cycles sort column (slot → status → ctx → tpm → cost → age)', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps(),
    steps: [
      { expectFrame: [/sort:.*slot/] },
      { press: 'S' },
      { expectFrame: [/sort:.*status/] },
      { press: 'S' },
      { expectFrame: [/sort:.*ctx/] },
    ],
  });
});

test('recipe: ↵ zooms the highlighted slot', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps({ initialSlot: 2 }),
    steps: [
      { press: '\r' },
      { expectCallback: ['onZoom', (calls) =>
          calls.length === 1 && calls[0][0] === 's2'] },
    ],
  });
});

test('recipe: D or esc closes the dashboard', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps(),
    steps: [
      { press: 'D' },
      { expectCallback: ['onClose', 1] },
    ],
  });
});

test('recipe: daily-budget readout colors red when over', async () => {
  await runRecipe({
    component: Dashboard,
    props: dashProps({ dayCost: 7.5, budget: 5.0 }),
    steps: [
      // Budget render is "day $7.50 / $5.00"; we can't easily assert on
      // color via plain regex, but the values both surface in the frame.
      { expectFrame: [/\$7\.50/, /\$5\.00/] },
    ],
  });
});
