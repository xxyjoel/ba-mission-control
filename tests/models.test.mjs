// tests/models.test.mjs — catalog helpers (modelByCli reverse-lookup).
//
// modelByCli is how the UI reflects a mid-session /model switch: claude
// reports the resolved cli model in agent.resolvedModel, and the card/zoom
// resolve it back to the catalog entry for label/color/maxCtx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelByCli, modelIds, newestModelId } from '../tui/lib/models.js';
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

test('opus-5.5 and opus-5 are selectable in the static catalog', () => {
  assert.equal(MODELS['opus-5.5']?.cliModel, 'claude-opus-5-5');
  assert.equal(MODELS['opus-5']?.cliModel, 'claude-opus-5');
  assert.ok(modelIds().includes('opus-5.5'));
  assert.ok(modelIds().includes('opus-5'));
  assert.equal(modelByCli('claude-opus-5-5')?.id, 'opus-5.5');
  assert.equal(newestModelId('opus'), 'opus-5.5');
});

test('a probe-DISCOVERED model becomes visible through the live modelIds() view', () => {
  // Net-new models still arrive via applyCacheToCatalog when the alias probe
  // resolves a cli id that is not yet in the book (e.g. a future opus-5.6).
  assert.ok(!MODELS['opus-9.9'], 'precondition: opus-9.9 is not a static entry');
  const cache = { fetchedAt: 1, models: { opus: { cliModel: 'claude-opus-9-9', contextWindow: 1000000, maxOut: 128000 } } };
  const { added } = applyCacheToCatalog(MODELS, cache);
  try {
    assert.deepEqual(added, ['opus-9.9']);
    assert.ok(modelIds().includes('opus-9.9'), 'live id view sees the discovered model');
    const e = modelByCli('claude-opus-9-9');
    assert.equal(e.id, 'opus-9.9');
    assert.equal(e.maxCtx, 1000000);
    // Pricing is inherited from the newest same-kind sibling and flagged.
    assert.equal(e.costPerMTokIn, MODELS['opus-5.5'].costPerMTokIn);
    assert.equal(e.estimatedPricing, true);
  } finally {
    delete MODELS['opus-9.9']; // keep the shared catalog clean for other tests
  }
});

test('applyCacheToCatalog ignores alias→wrong-family resolutions (haiku poison)', () => {
  const before = { ...MODELS['opus-5.5'] };
  const { added, updated } = applyCacheToCatalog(MODELS, {
    fetchedAt: 1,
    models: { opus: { cliModel: 'claude-haiku-4-5-20251001', contextWindow: 200000, maxOut: 32000 } },
  });
  assert.deepEqual(added, []);
  assert.deepEqual(updated, []);
  assert.equal(MODELS['opus-5.5'].cliModel, before.cliModel);
  assert.equal(MODELS['opus-5.5'].maxCtx, before.maxCtx);
});

test('modelByCli: unknown / falsy cli model → null (genuine drift signal)', () => {
  assert.equal(modelByCli('claude-made-up-9'), null);
  assert.equal(modelByCli(''), null);
  assert.equal(modelByCli(null), null);
  assert.equal(modelByCli(undefined), null);
});

// Fable 5.1 — the hand-added exception to "new models are discovered, not
// typed". Neither automatic source can see it: the Models API sync has no
// environment credential on a claude-CLI login, and KNOWN_ALIASES has no
// fable alias. Pinned here so a later cleanup can't silently drop it back
// out of the picker while discovery is still blind to it.
test('fable-5.1 is selectable and carries its live limits', () => {
  const m = MODELS['fable-5.1'];
  assert.ok(m, 'fable-5.1 must be in the catalog');
  assert.equal(m.cliModel, 'claude-fable-5-1');
  assert.equal(m.kind, 'fable');
  // Limits from a live GET /v1/models (2026-09-18): 1M in, 128k out.
  assert.equal(m.maxCtx, 1000000);
  assert.equal(m.maxOut, 128000);
  // Every selector reads modelIds(), so this is the picker assertion.
  assert.ok(modelIds().includes('fable-5.1'), 'picker must offer fable-5.1');
  assert.equal(modelByCli('claude-fable-5-1')?.id, 'fable-5.1');
});

test('fable-5.1 pricing is flagged estimated, not presented as verified', () => {
  // Published rates for 5.1 are NOT confirmed — they are inherited from
  // fable-5 under the same contract a discovered model gets. If someone adds
  // real rates they must clear the flag; if someone clears the flag without
  // adding real rates, this fails.
  const m = MODELS['fable-5.1'];
  assert.equal(m.estimatedPricing, true);
  assert.equal(m.costPerMTokIn, MODELS['fable-5'].costPerMTokIn);
  assert.equal(m.costPerMTokOut, MODELS['fable-5'].costPerMTokOut);
});

test('fable-5.1 outranks fable-5 as the newest of its kind', () => {
  // newestModelId parses the trailing version, so a '5.1' that parsed as 5
  // would tie with fable-5 and resolve by iteration order instead of version.
  assert.equal(newestModelId('fable'), 'fable-5.1');
  // The fable entries must not disturb the opus lineage that 'auto' follows.
  assert.equal(newestModelId('opus'), 'opus-5.5');
});
