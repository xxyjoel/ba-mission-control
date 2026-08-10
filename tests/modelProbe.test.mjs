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
  autoProbeOnVersionChange, listApiModels, syncCatalogFromApi,
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

test('saveModelCache: stamps the claude CLI version when provided', () => {
  const results = [{ alias: 'opus', cliModel: 'claude-opus-5', contextWindow: 1000000, maxOut: 128000 }];
  const payload = saveModelCache(results, 123, '2.1.220');
  assert.equal(payload.claudeVersion, '2.1.220');
  assert.equal(loadModelCache().claudeVersion, '2.1.220');
  // Unstamped save (version fetch failed) omits the field entirely.
  assert.equal('claudeVersion' in saveModelCache(results, 124, null), false);
});

// autoProbeOnVersionChange — every collaborator injected; no processes spawn.
const FAKE_PROBE_RESULTS = [
  { alias: 'opus', cliModel: 'claude-opus-5', contextWindow: 1000000, maxOut: 128000 },
];
function fakes({ version = '2.1.220', cache = null } = {}) {
  const calls = { probed: 0, saved: [] };
  return {
    calls,
    opts: {
      getVersion: async () => version,
      loadCache: () => cache,
      probe: async () => { calls.probed++; return FAKE_PROBE_RESULTS; },
      saveCache: (results, now, v) => { calls.saved.push(v); return { fetchedAt: now, claudeVersion: v, models: { opus: FAKE_PROBE_RESULTS[0] } }; },
      now: () => 1,
    },
  };
}

test('autoProbeOnVersionChange: same stamped version → no probe (no billing)', async () => {
  const { calls, opts } = fakes({ cache: { fetchedAt: 1, claudeVersion: '2.1.220', models: {} } });
  const r = await autoProbeOnVersionChange({}, opts);
  assert.equal(r.probed, false);
  assert.equal(r.version, '2.1.220');
  assert.equal(calls.probed, 0);
});

test('autoProbeOnVersionChange: version changed → probes, saves stamp, merges discovery', async () => {
  const models = { 'opus-4.8': { label: 'OPUS 4.8', cliModel: 'claude-opus-4-8', kind: 'opus', maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5, costPerMTokOut: 25, costPerMTokCacheCreation: 6.25, costPerMTokCacheRead: 0.5 } };
  const { calls, opts } = fakes({ cache: { fetchedAt: 1, claudeVersion: '2.1.219', models: {} } });
  const r = await autoProbeOnVersionChange(models, opts);
  assert.equal(r.probed, true);
  assert.deepEqual(r.added, ['opus-5']);
  assert.deepEqual(calls.saved, ['2.1.220']);
  assert.ok(models['opus-5'], 'discovered model merged into the catalog');
  assert.equal(models['opus-5'].estimatedPricing, true);
});

test('autoProbeOnVersionChange: unstamped legacy cache → probes once to stamp it', async () => {
  const { calls, opts } = fakes({ cache: { fetchedAt: 1, models: {} } });
  const r = await autoProbeOnVersionChange({}, opts);
  assert.equal(r.probed, true);
  assert.equal(calls.probed, 1);
});

test('autoProbeOnVersionChange: version unavailable → does nothing', async () => {
  const { calls, opts } = fakes({ version: null });
  const r = await autoProbeOnVersionChange({}, opts);
  assert.equal(r.probed, false);
  assert.equal(calls.probed, 0);
});

// ── Models API sync (0369) ──────────────────────────────────────────

function freshCatalog() {
  return {
    'opus-4.8':  { label: 'OPUS 4.8',  cliModel: 'claude-opus-4-8',           kind: 'opus',  maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5, costPerMTokOut: 25, costPerMTokCacheCreation: 6.25, costPerMTokCacheRead: 0.5 },
    'haiku-4.5': { label: 'HAIKU 4.5', cliModel: 'claude-haiku-4-5-20251001', kind: 'haiku', maxCtx: 200000,  maxOut: 64000,  costPerMTokIn: 1, costPerMTokOut: 5,  costPerMTokCacheCreation: 1.25, costPerMTokCacheRead: 0.1 },
  };
}

test('listApiModels: no credential → ok:false, no fetch attempted', async () => {
  let fetched = 0;
  const r = await listApiModels({ apiKey: undefined, authToken: undefined, fetchImpl: async () => { fetched++; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential/);
  assert.equal(fetched, 0);
});

test('listApiModels: paginates with after_id until has_more is false', async () => {
  const pages = [
    { data: [{ id: 'claude-opus-5' }], has_more: true, last_id: 'claude-opus-5' },
    { data: [{ id: 'claude-sonnet-5' }], has_more: false, last_id: 'claude-sonnet-5' },
  ];
  const urls = [];
  const r = await listApiModels({
    apiKey: 'k',
    fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => pages.shift() }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models.map((m) => m.id), ['claude-opus-5', 'claude-sonnet-5']);
  assert.match(urls[1], /after_id=claude-opus-5/);
});

test('listApiModels: HTTP error → ok:false with status', async () => {
  const r = await listApiModels({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(r, { ok: false, reason: 'models API HTTP 401' });
});

test('listApiModels: refuses a non-https base URL before any fetch (credential-leak guard)', async () => {
  let fetched = 0;
  const r = await listApiModels({ apiKey: 'k', baseUrl: 'http://evil.example', fetchImpl: async () => { fetched++; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-https/);
  assert.equal(fetched, 0);
});

test('listApiModels: fetches with redirect:"error" so x-api-key cannot follow a hop', async () => {
  let opts;
  await listApiModels({ apiKey: 'k', fetchImpl: async (url, o) => { opts = o; return { ok: true, json: async () => ({ data: [], has_more: false }) }; } });
  assert.equal(opts.redirect, 'error');
});

test('syncCatalogFromApi: adds unknown API models with sibling pricing + real limits', () => {
  const models = freshCatalog();
  const { added } = syncCatalogFromApi(models, [
    { id: 'claude-opus-4-8', max_input_tokens: 1000000, max_tokens: 128000 },
    { id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 64000 },
    { id: 'claude-opus-5', max_input_tokens: 1000000, max_tokens: 128000 },
  ]);
  assert.deepEqual(added, ['opus-5']);
  assert.equal(models['opus-5'].cliModel, 'claude-opus-5');
  assert.equal(models['opus-5'].maxCtx, 1000000);
  assert.equal(models['opus-5'].costPerMTokIn, 5); // inherited from opus-4.8
  assert.equal(models['opus-5'].estimatedPricing, true);
});

test('syncCatalogFromApi: updates known limits; dated-vs-bare ids collapse, no dup', () => {
  const models = freshCatalog();
  const { added, updated } = syncCatalogFromApi(models, [
    { id: 'claude-opus-4-8', max_input_tokens: 1000000, max_tokens: 128000 },
    // API lists the bare alias while mc pins the dated snapshot — same model.
    { id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 128000 },
  ]);
  assert.deepEqual(added, []);
  assert.ok(updated.includes('haiku-4.5'));
  assert.equal(models['haiku-4.5'].maxOut, 128000);
  assert.equal(Object.keys(models).length, 2, 'no duplicate haiku entry');
});

test('syncCatalogFromApi: catalog model absent from the API → retired (kept, not deleted)', () => {
  const models = freshCatalog();
  const { retired } = syncCatalogFromApi(models, [
    { id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 64000 },
  ]);
  assert.deepEqual(retired, ['opus-4.8']);
  assert.equal(models['opus-4.8'].retired, true);
  assert.equal(models['opus-4.8'].costPerMTokIn, 5, 'pricing kept for cost history');
  // …and a later API list containing it again un-retires it.
  const again = syncCatalogFromApi(models, [
    { id: 'claude-opus-4-8', max_input_tokens: 1000000, max_tokens: 128000 },
    { id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 64000 },
  ]);
  assert.ok(again.updated.includes('opus-4.8'));
  assert.equal(models['opus-4.8'].retired, undefined);
});

test('syncCatalogFromApi: skips legacy claude-3-* naming and empty lists', () => {
  const models = freshCatalog();
  const r = syncCatalogFromApi(models, [{ id: 'claude-3-haiku-20240307' }]);
  assert.deepEqual(r.added, []);
  assert.ok(!models['3-haiku']);
  // Empty / failed list must be a no-op — never mass-retire the catalog.
  const r2 = syncCatalogFromApi(models, []);
  assert.deepEqual(r2, { added: [], updated: [], retired: [] });
  assert.equal(models['opus-4.8'].retired, undefined);
});

test('isCacheStale: honors TTL and missing fetchedAt', () => {
  assert.equal(isCacheStale(null), true);
  assert.equal(isCacheStale({ models: {} }), true, 'no fetchedAt → stale');
  assert.equal(isCacheStale({ fetchedAt: 1000 }, 500, 1400), false, 'within TTL');
  assert.equal(isCacheStale({ fetchedAt: 1000 }, 500, 2000), true, 'past TTL');
});

test.after(() => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });
