// tests/recipes/reliability.recipes.test.jsx — covers the visual
// surface of the reliability features shipped from the top-10 list:
//   - Card renders a context-pressure chip (#2 / #38)
//   - Card renders a STUCK chip when the agent is silent (#25)
//   - Help highlights the current view's section (#47)
//
// The wire-up itself (toast firing, snapshot refresh on the slow clock,
// stuck detection in Agent.toJSON) is exercised at the unit level by
// the existing detectPrompt suite and the live `mc` runs; here we lock
// the rendered card / modal output that depends on those signals.

import { test } from 'node:test';
import Card from '../../tui/Card.jsx';
import Help from '../../tui/modals/Help.jsx';
import { runRecipe } from '../lib/recipe.js';
import { theme, makeAgent } from '../lib/fixtures.js';
import { MODELS } from '../../tui/lib/models.js';

const noop = () => {};

// makeAgent defaults to sonnet-4.6. We derive the test context from the model's
// actual maxCtx in the catalog (single source of truth) so this stays correct if
// the context window changes — the card derives the percentage the same way.

test('recipe: card chip — context near threshold renders the % chip', async () => {
  // 85% of sonnet-4.6's ctx window → above the 80% warn, below the 90% over
  // threshold → yellow chip with "85%".
  const agent = makeAgent({ status: 'working', context: Math.round(0.85 * MODELS['sonnet-4.6'].maxCtx) });
  await runRecipe({
    component: Card,
    props: { agent, focused: false, threshold: 150_000, warnPct: 85,
             borderStyle: 'round', showTools: false, theme },
    steps: [
      { expectFrame: [/85%/] },
    ],
  });
});

test('recipe: card chip — context safely under threshold has no % chip', async () => {
  const agent = makeAgent({ status: 'working', context: 10_000 });
  await runRecipe({
    component: Card,
    props: { agent, focused: false, threshold: 150_000, warnPct: 85,
             borderStyle: 'round', showTools: false, theme },
    steps: [
      // The CTX bar still shows "5%" in the ctx row; we're guarding the
      // additional title-row chip, which only renders above warn.
      // Use a more specific check on the status word so we're not
      // matching the bar percent.
      { expectNotFrame: [/WORKING.*·.*\d+%/] },
    ],
  });
});

test('recipe: card chip — stuckMin renders STUCK Nm in red', async () => {
  const agent = makeAgent({ status: 'working', stuckMin: 7 });
  await runRecipe({
    component: Card,
    props: { agent, focused: false, threshold: 150_000, warnPct: 85,
             borderStyle: 'round', showTools: false, theme },
    steps: [
      { expectFrame: [/STUCK 7m/] },
    ],
  });
});

test('recipe: card chip — stuckMin=0 hides the STUCK chip', async () => {
  const agent = makeAgent({ status: 'working', stuckMin: 0 });
  await runRecipe({
    component: Card,
    props: { agent, focused: false, threshold: 150_000, warnPct: 85,
             borderStyle: 'round', showTools: false, theme },
    steps: [
      { expectNotFrame: [/STUCK/] },
    ],
  });
});

test('recipe: help — view="main" highlights NAVIGATION as current view', async () => {
  await runRecipe({
    component: Help,
    props: { onClose: noop, theme, width: 100, view: 'main' },
    steps: [
      { expectFrame: [/▶ NAVIGATION.*CURRENT VIEW/] },
    ],
  });
});

// rows:100 renders the keymap un-windowed (the Help modal is a scrollable window
// since 618c26f; at the harness's default 24-row terminal these sections scroll
// below the fold). See task 0358.
test('recipe: help — view="zoom" highlights ZOOM and SLASH sections', async () => {
  await runRecipe({
    component: Help,
    props: { onClose: noop, theme, width: 100, rows: 100, view: 'zoom' },
    steps: [
      { expectFrame: [/▶ ZOOM.*CURRENT VIEW/, /▶ SLASH COMMANDS.*CURRENT VIEW/] },
    ],
  });
});

test('recipe: help documents the new kill-twice-to-confirm behavior', async () => {
  await runRecipe({
    component: Help,
    props: { onClose: noop, theme, width: 100, rows: 100, view: 'main' },
    steps: [
      { expectFrame: [/press K twice/, /3s arm/] },
    ],
  });
});
