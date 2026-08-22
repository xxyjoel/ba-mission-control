// tests/models.autoDefault.test.mjs — the 'auto' default model resolves
// against the LIVE catalog: newest non-retired Opus, discovery included.
// Pins the fix for "opus 5 doesn't show in a fresh install" (2026-08-22):
// the default must follow what discovery finds, never a hardcoded id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelIds, newestModelId, resolveModelId } from '../tui/lib/models.js';

test('newestModelId picks the highest-versioned opus in the static catalog', () => {
  // Static book currently tops out at opus-4.8; the assertion is on ordering,
  // not the specific id: whatever wins must be an opus and >= every other opus.
  const winner = newestModelId('opus');
  assert.ok(winner && MODELS[winner].kind === 'opus');
  const v = (id) => parseFloat(id.slice(id.lastIndexOf('-') + 1));
  for (const id of modelIds()) {
    if (MODELS[id].kind !== 'opus' || MODELS[id].retired) continue;
    assert.ok(v(winner) >= v(id), `${winner} must be >= ${id}`);
  }
});

test('a discovery-added opus immediately wins auto-resolution', () => {
  MODELS['opus-9.9'] = { label: 'OPUS 9.9', cliModel: 'claude-opus-9-9', kind: 'opus', maxCtx: 1, maxOut: 1 };
  try {
    assert.equal(newestModelId('opus'), 'opus-9.9');
    assert.equal(resolveModelId('auto'), 'opus-9.9');
    assert.equal(resolveModelId(undefined), 'opus-9.9');
  } finally {
    delete MODELS['opus-9.9'];
  }
});

test('a retired model never wins', () => {
  MODELS['opus-9.9'] = { label: 'OPUS 9.9', cliModel: 'claude-opus-9-9', kind: 'opus', maxCtx: 1, maxOut: 1, retired: true };
  try {
    assert.notEqual(newestModelId('opus'), 'opus-9.9');
  } finally {
    delete MODELS['opus-9.9'];
  }
});

test('an explicit id passes through resolveModelId untouched', () => {
  assert.equal(resolveModelId('sonnet-4.6'), 'sonnet-4.6');
  assert.equal(resolveModelId('haiku-4.5'), 'haiku-4.5');
});

test('other kinds resolve within their kind', () => {
  const s = newestModelId('sonnet');
  assert.ok(s && MODELS[s].kind === 'sonnet');
});
