// tests/models.estimatedPricing.test.mjs — 0408-M2: pricing fallback for
// models the catalog does not know. The rule: never $0 — an unknown model
// inherits the NEWEST same-family rate, flagged estimatedPricing; a model
// with no recognizable family inherits the newest opus.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODELS, kindFromModelId, estimatedPricingFor, newestModelId } from '../tui/lib/models.js';

test('kindFromModelId: parses the family from CLI and friendly forms', () => {
  assert.equal(kindFromModelId('claude-fable-5-1'), 'fable');
  assert.equal(kindFromModelId('claude-opus-4-8'), 'opus');
  assert.equal(kindFromModelId('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(kindFromModelId('sonnet-4.6'), 'sonnet');
  assert.equal(kindFromModelId('fable-9.9'), 'fable');
});

test('kindFromModelId: no family token → null', () => {
  assert.equal(kindFromModelId('made-up-model'), null);
  assert.equal(kindFromModelId(''), null);
  assert.equal(kindFromModelId(null), null);
  assert.equal(kindFromModelId('<synthetic>'), null);
});

test('estimatedPricingFor: unknown model of a known family inherits the newest family rates', () => {
  const p = estimatedPricingFor('claude-sonnet-7');
  const src = MODELS[newestModelId('sonnet')];
  assert.equal(p.costPerMTokIn, src.costPerMTokIn);
  assert.equal(p.costPerMTokOut, src.costPerMTokOut);
  assert.equal(p.costPerMTokCacheRead, src.costPerMTokCacheRead);
  assert.equal(p.estimatedPricing, true, 'always flagged — the rate is inherited, not verified');
  assert.equal(p.estimatedFrom, newestModelId('sonnet'));
});

test('estimatedPricingFor: unknown family falls back to the newest opus (deliberate over-estimate)', () => {
  const p = estimatedPricingFor('claude-mythos-6');
  const src = MODELS[newestModelId('opus')];
  assert.equal(p.costPerMTokIn, src.costPerMTokIn);
  assert.equal(p.estimatedPricing, true);
});

test('estimatedPricingFor: never returns a $0 rate for any input', () => {
  for (const id of ['claude-fable-9-9', 'claude-opus-99', 'gibberish', 'x-1.2', '']) {
    const p = estimatedPricingFor(id);
    assert.ok(p && p.costPerMTokIn > 0 && p.costPerMTokOut > 0,
      `0408-M2: ${JSON.stringify(id)} must inherit a real, non-zero rate`);
  }
});
