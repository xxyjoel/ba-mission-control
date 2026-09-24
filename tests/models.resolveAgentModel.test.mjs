// tests/models.resolveAgentModel.test.mjs — Zoom/Card ctx denominator for `auto`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentModel, modelByCli, newestModelId, MODELS } from '../tui/lib/models.js';

test('resolveAgentModel: launch auto → newest opus maxCtx (not ?%)', () => {
  const m = resolveAgentModel({ model: 'auto', resolvedModel: null, context: 12000 });
  assert.ok(m, 'must resolve');
  assert.equal(m.id, newestModelId('opus'));
  assert.ok(m.maxCtx > 0);
});

test('resolveAgentModel: prefers resolved CLI id over launch auto', () => {
  const m = resolveAgentModel({ model: 'auto', resolvedModel: 'claude-sonnet-5' });
  assert.equal(m.id, 'sonnet-5');
  assert.equal(m.maxCtx, MODELS['sonnet-5'].maxCtx);
});

test('resolveAgentModel: dated CLI snapshot matches bare catalog id', () => {
  const m = resolveAgentModel({
    model: 'haiku-4.5',
    resolvedModel: 'claude-haiku-4-5-20251001',
  });
  assert.equal(m.id, 'haiku-4.5');
});

test('resolveAgentModel: CLI id in launch model (resume path) still has maxCtx', () => {
  // :resume-all sets model = rec.resolvedModel || rec.model — often a CLI id
  // with resolvedModel still null until the first transcript event.
  const m = resolveAgentModel({ model: 'claude-opus-5', resolvedModel: null });
  assert.ok(m, 'must resolve CLI launch id');
  assert.equal(m.id, 'opus-5');
  assert.ok(m.maxCtx > 0);
});

test('resolveAgentModel: bare claude-opus-4-8 launch id', () => {
  const m = resolveAgentModel({ model: 'claude-opus-4-8', resolvedModel: null });
  assert.equal(m.id, 'opus-4.8');
});

test('modelByCli: friendly id also resolves', () => {
  assert.equal(modelByCli('opus-5.5')?.id, 'opus-5.5');
});
