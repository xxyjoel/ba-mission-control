// tests/models.test.mjs — catalog helpers (modelByCli reverse-lookup).
//
// modelByCli is how the UI reflects a mid-session /model switch: claude
// reports the resolved cli model in agent.resolvedModel, and the card/zoom
// resolve it back to the catalog entry for label/color/maxCtx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelByCli, modelIds } from '../tui/lib/models.js';
import { applyCacheToCatalog } from '../tui/lib/modelProbe.js';

test('modelByCli: resolves a known cli model to its catalog entry + friendly id', () => {
  const e = modelByCli('claude-opus-4-8');
  assert.ok(e, 'opus-4.8 cli id should resolve');
  assert.equal(e.id, 'opus-4.8');
  assert.equal(e.label, MODELS['opus-4.8'].label);
  assert.equal(e.maxCtx, MODELS['opus-4.8'].maxCtx);
});

test('modelByCli: every catalog entry round-trips through its cliModel', () => {
  for (const [id, m] of Object.entries(MODELS)) {
    assert.equal(modelByCli(m.cliModel)?.id, id, `${id} should round-trip`);
  }
});

test('a probe-DISCOVERED model becomes visible through the live modelIds() view', () => {
  // Net-new models are never hand-added to MODELS — they arrive from the
  // claude CLI via applyCacheToCatalog (e.g. Opus 5, which v2.1.220's bare
  // `opus` alias resolves to). The selectors all read modelIds(), a live
  // view, so a discovered model is immediately selectable.
  assert.ok(!MODELS['opus-5'], 'precondition: opus-5 is not a static entry');
  const cache = { fetchedAt: 1, models: { opus: { cliModel: 'claude-opus-5', contextWindow: 1000000, maxOut: 128000 } } };
  const { added } = applyCacheToCatalog(MODELS, cache);
  try {
    assert.deepEqual(added, ['opus-5']);
    assert.ok(modelIds().includes('opus-5'), 'live id view sees the discovered model');
    const e = modelByCli('claude-opus-5');
    assert.equal(e.id, 'opus-5');
    assert.equal(e.maxCtx, 1000000);
    // Pricing is inherited from the newest same-kind sibling and flagged.
    assert.equal(e.costPerMTokIn, MODELS['opus-4.8'].costPerMTokIn);
    assert.equal(e.estimatedPricing, true);
  } finally {
    delete MODELS['opus-5']; // keep the shared catalog clean for other tests
  }
});

test('modelByCli: unknown / falsy cli model → null (genuine drift signal)', () => {
  assert.equal(modelByCli('claude-made-up-9'), null);
  assert.equal(modelByCli(''), null);
  assert.equal(modelByCli(null), null);
  assert.equal(modelByCli(undefined), null);
});
