// tests/modelProbe.test.mjs — programmatic model discovery (#model-catalog).
//
// Covers the PURE logic (parse / cache / catalog overlay). The live probe
// (probeAlias/probeAll) spawns a real billed `claude` turn, so it is NOT
// exercised here — only the parsing of its output shape is.
//
// Sandbox the config dir BEFORE importing modelProbe: CACHE_FILE is resolved
// at module load via getConfigDir(), so the env var must be set first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'mc-modelprobe-'));
process.env.MC_CONFIG_DIR = SANDBOX;

const {
  parseModelUsage, deriveFriendlyId, applyCacheToCatalog,
  saveModelCache, loadModelCache, isCacheStale,
} = await import('../tui/lib/modelProbe.js');

// Trimmed real output of: claude -p --model opus --output-format json
const REAL_PROBE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'ok',
  total_cost_usd: 0.124,
  modelUsage: {
    'claude-opus-4-8': {
      inputTokens: 7016, outputTokens: 4, costUSD: 0.124,
      contextWindow: 1000000, maxOutputTokens: 64000,
    },
  },
});

test('parseModelUsage: pulls resolved model + window from real probe output', () => {
  const r = parseModelUsage(REAL_PROBE);
  assert.deepEqual(r, { cliModel: 'claude-opus-4-8', contextWindow: 1000000, maxOut: 64000 });
});

test('parseModelUsage: accepts an already-parsed object', () => {
  const r = parseModelUsage(JSON.parse(REAL_PROBE));
  assert.equal(r.cliModel, 'claude-opus-4-8');
});

test('parseModelUsage: returns null on garbage / missing modelUsage', () => {
  assert.equal(parseModelUsage('not json'), null);
  assert.equal(parseModelUsage('{}'), null);
  assert.equal(parseModelUsage(JSON.stringify({ modelUsage: {} })), null);
  assert.equal(parseModelUsage(null), null);
});

test('deriveFriendlyId: claude- prefix stripped, dashes → dots, date dropped', () => {
  assert.equal(deriveFriendlyId('claude-opus-4-8'), 'opus-4.8');
  assert.equal(deriveFriendlyId('claude-sonnet-4-6'), 'sonnet-4.6');
  assert.equal(deriveFriendlyId('claude-haiku-4-5-20251001'), 'haiku-4.5');
});

test('applyCacheToCatalog: updates maxCtx of a KNOWN model by cliModel', () => {
  const models = {
    'opus-4.8': { label: 'OPUS 4.8', cliModel: 'claude-opus-4-8', kind: 'opus', maxCtx: 200000, costPerMTokIn: 15, costPerMTokOut: 75 },
  };
  const cache = { fetchedAt: 1, models: { opus: { cliModel: 'claude-opus-4-8', contextWindow: 1000000, maxOut: 64000 } } };
  const res = applyCacheToCatalog(models, cache);
  assert.equal(models['opus-4.8'].maxCtx, 1000000, 'maxCtx overlaid from probe');
  assert.equal(models['opus-4.8'].maxOut, 64000);
  assert.deepEqual(res.updated, ['opus-4.8']);
  assert.deepEqual(res.added, []);
});

test('applyCacheToCatalog: ADDS an unknown model, inheriting same-kind pricing', () => {
  const models = {
    'opus-4.8': { label: 'OPUS 4.8', cliModel: 'claude-opus-4-8', kind: 'opus', maxCtx: 1000000, costPerMTokIn: 15, costPerMTokOut: 75, costPerMTokCacheCreation: 18.75, costPerMTokCacheRead: 1.5 },
  };
  const cache = { fetchedAt: 1, models: { opus: { cliModel: 'claude-opus-4-9', contextWindow: 1000000, maxOut: 64000 } } };
  const res = applyCacheToCatalog(models, cache);
  assert.deepEqual(res.added, ['opus-4.9']);
  const added = models['opus-4.9'];
  assert.equal(added.cliModel, 'claude-opus-4-9');
  assert.equal(added.kind, 'opus');
  assert.equal(added.costPerMTokIn, 15, 'pricing inherited from same-kind sibling');
  assert.equal(added.estimatedPricing, true, 'flagged so cost display can warn');
});

test('applyCacheToCatalog: no-op on empty / null cache', () => {
  const models = { 'opus-4.8': { cliModel: 'claude-opus-4-8', kind: 'opus', maxCtx: 1000000 } };
  assert.deepEqual(applyCacheToCatalog(models, null), { updated: [], added: [] });
  assert.deepEqual(applyCacheToCatalog(models, { models: {} }), { updated: [], added: [] });
});

test('saveModelCache / loadModelCache: round-trips successful probes, skips errors', () => {
  const results = [
    { alias: 'opus', cliModel: 'claude-opus-4-8', contextWindow: 1000000, maxOut: 64000 },
    { alias: 'sonnet', error: 'not signed in' },
  ];
  const saved = saveModelCache(results, 12345);
  assert.equal(saved.fetchedAt, 12345);
  assert.ok(saved.models.opus, 'successful probe persisted');
  assert.ok(!saved.models.sonnet, 'errored probe NOT persisted');

  const loaded = loadModelCache();
  assert.equal(loaded.fetchedAt, 12345);
  assert.equal(loaded.models.opus.cliModel, 'claude-opus-4-8');
});

test('isCacheStale: honors TTL and missing fetchedAt', () => {
  assert.equal(isCacheStale(null), true);
  assert.equal(isCacheStale({ models: {} }), true, 'no fetchedAt → stale');
  assert.equal(isCacheStale({ fetchedAt: 1000 }, 500, 1400), false, 'within TTL');
  assert.equal(isCacheStale({ fetchedAt: 1000 }, 500, 2000), true, 'past TTL');
});

test.after(() => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });
