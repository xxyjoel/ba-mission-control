// tests/models.test.mjs — catalog helpers (modelByCli reverse-lookup).
//
// modelByCli is how the UI reflects a mid-session /model switch: claude
// reports the resolved cli model in agent.resolvedModel, and the card/zoom
// resolve it back to the catalog entry for label/color/maxCtx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelByCli } from '../tui/lib/models.js';

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

test('modelByCli: unknown / falsy cli model → null (genuine drift signal)', () => {
  assert.equal(modelByCli('claude-made-up-9'), null);
  assert.equal(modelByCli(''), null);
  assert.equal(modelByCli(null), null);
  assert.equal(modelByCli(undefined), null);
});
