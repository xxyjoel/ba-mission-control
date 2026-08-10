// tui/lib/modelProbe.js — programmatic model discovery.
//
// The `claude` CLI has no `models list` subcommand. The only programmatic
// way to learn what an alias ('opus'/'sonnet'/'haiku') resolves to TODAY —
// and its real context window — is to run a one-shot query and read the
// `modelUsage` block of the JSON result:
//
//   $ claude -p --model opus --output-format json 'hi'
//   { …, "modelUsage": { "claude-opus-4-8": {
//        "contextWindow": 1000000, "maxOutputTokens": 64000, … } } }
//
// So each probe is a REAL (billed) turn — ~$0.10–0.15 and ~2s. That's why
// we never probe on every boot: `:model refresh` triggers a live probe and
// writes a cache; boot just overlays the cache onto the static catalog in
// tui/lib/models.js (cheap, offline). See applyCacheToCatalog().
//
// CLAUDE_BIN is user-controlled — we only ever spawn it argv-form via
// execFile (never a shell string), matching server/agent.mjs + auth.js.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';

const execFileP = promisify(execFile);

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Stable aliases the CLI resolves to "latest of family". These never go
// stale — claude maps them forward as new models ship, which is exactly
// what we probe to discover.
export const KNOWN_ALIASES = ['opus', 'sonnet', 'haiku'];

const CACHE_FILE = join(getConfigDir(), 'models-cache.json');
const TMP_FILE   = CACHE_FILE + '.tmp';

// Cache older than this is considered stale (callers decide what to do).
// One week: model lineups move on the order of months, and a manual
// `:model refresh` is always available for same-day accuracy.
export const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Minimal prompt — cost is dominated by system-prompt + caching, not the
// user text, so length is irrelevant; we just need one completed turn.
const PROBE_PROMPT = 'Reply with exactly: ok';
const PROBE_TIMEOUT_MS = 60_000;

// parseModelUsage — pull the resolved model + window out of a `claude -p
// --output-format json` result. Accepts the raw stdout string OR an
// already-parsed object. Returns { cliModel, contextWindow, maxOut } or
// null when the shape isn't what we expect (so callers can skip cleanly).
export function parseModelUsage(resultOrJson) {
  let obj = resultOrJson;
  if (typeof resultOrJson === 'string') {
    try { obj = JSON.parse(resultOrJson); } catch { return null; }
  }
  const usage = obj && obj.modelUsage;
  if (!usage || typeof usage !== 'object') return null;
  // modelUsage is keyed by the resolved CLI model name. Take the first
  // (queries pin a single model, so there's exactly one key in practice).
  const cliModel = Object.keys(usage)[0];
  if (!cliModel) return null;
  const u = usage[cliModel] || {};
  const contextWindow = Number(u.contextWindow) || null;
  const maxOut = Number(u.maxOutputTokens) || null;
  return { cliModel, contextWindow, maxOut };
}

// probeAlias — run one billed probe for a single alias. Resolves to
// { alias, cliModel, contextWindow, maxOut } on success, or
// { alias, error } on any failure (not-signed-in, timeout, bad JSON).
// Never throws — refresh aggregates and reports partial results.
export async function probeAlias(alias, { claudeBin = CLAUDE_BIN, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const pending = execFileP(
      claudeBin,
      ['-p', '--model', alias, '--output-format', 'json', PROBE_PROMPT],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    // Probes are opportunistic — never let an in-flight one hold the event
    // loop open and block mc's exit (surfaced as pty-recipe quit timeouts).
    pending.child?.unref?.();
    const { stdout } = await pending;
    const parsed = parseModelUsage(stdout);
    if (!parsed) return { alias, error: 'could not parse modelUsage from probe output' };
    return { alias, ...parsed };
  } catch (e) {
    return { alias, error: e.killed ? `probe timed out after ${timeoutMs}ms` : (e.message || 'probe failed') };
  }
}

// probeAll — probe several aliases concurrently. Returns the array of
// per-alias results (mix of success + {error}).
export async function probeAll(aliases = KNOWN_ALIASES, opts = {}) {
  return Promise.all(aliases.map((a) => probeAlias(a, opts)));
}

// ── cache (config dir) ──────────────────────────────────────────────

export function loadModelCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.models) return null;
    return raw;
  } catch {
    return null;
  }
}

// saveModelCache — persist successful probe results keyed by alias.
// `now` is injected so tests stay deterministic; defaults to wall clock.
// `claudeVersion` stamps which CLI produced these resolutions, so boot can
// detect "claude updated since last probe" and re-discover automatically.
export function saveModelCache(results, now = Date.now(), claudeVersion = null) {
  const models = {};
  for (const r of results || []) {
    if (!r || r.error || !r.cliModel) continue;
    models[r.alias] = { cliModel: r.cliModel, contextWindow: r.contextWindow, maxOut: r.maxOut };
  }
  const payload = { fetchedAt: now, ...(claudeVersion ? { claudeVersion } : {}), models };
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(TMP_FILE, JSON.stringify(payload, null, 2));
    renameSync(TMP_FILE, CACHE_FILE);
  } catch { /* best-effort — a missing cache just means we use static data */ }
  return payload;
}

export function isCacheStale(cache, ttlMs = MODEL_CACHE_TTL_MS, now = Date.now()) {
  if (!cache || !cache.fetchedAt) return true;
  return (now - cache.fetchedAt) > ttlMs;
}

// getClaudeVersion — `claude --version`, free and fast (~100ms, no API
// call). Returns the semver string or null; never throws.
export async function getClaudeVersion({ claudeBin = CLAUDE_BIN, timeoutMs = 10_000 } = {}) {
  try {
    const pending = execFileP(claudeBin, ['--version'], { timeout: timeoutMs });
    pending.child?.unref?.(); // see probeAlias — never block mc's exit
    const { stdout } = await pending;
    const m = String(stdout).match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// autoProbeOnVersionChange — the "claude updated → discover its models"
// loop (task 0368, closes TODO(model-autodetect)). Compares the CLI's
// current version to the one stamped in the cache; on mismatch (or an
// unstamped legacy cache) runs the same probe → save → overlay path as
// `:model refresh`. Each probe is a real billed turn, so this fires ONLY
// when the version actually changed — steady-state boots cost nothing.
// Fire-and-forget: resolves { probed, version, updated, added } for
// logging, and never throws.
export async function autoProbeOnVersionChange(models, {
  claudeBin = CLAUDE_BIN,
  loadCache = loadModelCache,
  saveCache = saveModelCache,
  probe = probeAll,
  getVersion = getClaudeVersion,
  now = () => Date.now(),
} = {}) {
  try {
    const version = await getVersion({ claudeBin });
    if (!version) return { probed: false, version: null };
    const cache = loadCache();
    if (cache && cache.claudeVersion === version) return { probed: false, version };
    const results = await probe(KNOWN_ALIASES, { claudeBin });
    // Don't stamp the version unless at least one alias resolved —
    // otherwise a transient failure (offline, signed out) would silence
    // discovery until the NEXT claude update.
    const ok = results.some((r) => r && !r.error && r.cliModel);
    const saved = saveCache(results, now(), ok ? version : null);
    const applied = applyCacheToCatalog(models, saved);
    return { probed: true, version, ...applied };
  } catch {
    return { probed: false, version: null };
  }
}

// ── Models API source (authoritative inventory) ─────────────────────
// GET /v1/models — the same endpoint the Anthropic SDK's
// client.models.list() wraps. FREE (no tokens billed) and complete: every
// model the credential can see, with real context/output limits. This is
// the primary sync source; the alias probes above remain for (a) alias
// RESOLUTION (which model `opus` points at today — the API can't say) and
// (b) users with only a claude-CLI login, where no API credential is
// available in the environment and this endpoint can't be called.

// listApiModels — fetch the full model inventory. Auth comes from the
// environment (ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN with the OAuth
// beta header). Returns { ok:true, models:[{id, display_name,
// max_input_tokens, max_tokens}, …] } or { ok:false, reason }. Never throws.
export async function listApiModels({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.ANTHROPIC_API_KEY,
  authToken = process.env.ANTHROPIC_AUTH_TOKEN,
  baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey && !authToken) {
    return { ok: false, reason: 'no API credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)' };
  }
  const headers = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;
  else { headers.authorization = `Bearer ${authToken}`; headers['anthropic-beta'] = 'oauth-2025-04-20'; }
  const models = [];
  let afterId = null;
  try {
    // /v1/models paginates with after_id / has_more / last_id.
    for (let page = 0; page < 10; page++) {
      const url = `${baseUrl}/v1/models?limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, reason: `models API HTTP ${res.status}` };
      const body = await res.json();
      for (const m of body.data || []) if (m && m.id) models.push(m);
      if (!body.has_more || !body.last_id) break;
      afterId = body.last_id;
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, reason: e?.message || 'models API fetch failed' };
  }
}

// syncCatalogFromApi — diff mc's catalog against the API inventory and
// reconcile mc to match. MUTATES `models` (same contract as
// applyCacheToCatalog):
//   • API model unknown to mc → ADD (friendly id derived from the cli id,
//     pricing inherited from the newest same-kind sibling + flagged
//     estimatedPricing, limits from the API)
//   • known model            → UPDATE maxCtx/maxOut from the API's real
//     limits, and clear any stale `retired` flag
//   • catalog model absent from the API → mark `retired: true` (kept, not
//     deleted — cost derivation for past sessions still needs its pricing)
// Dated-vs-bare id collisions (API lists claude-haiku-4-5 while mc pins
// claude-haiku-4-5-20251001) collapse to one friendly id: treated as the
// same model, updated not duplicated, never retired.
// Returns { added, updated, retired } friendly-id arrays.
export function syncCatalogFromApi(models, apiModels) {
  const out = { added: [], updated: [], retired: [] };
  if (!Array.isArray(apiModels) || apiModels.length === 0) return out;

  const byCli = new Map(Object.entries(models).map(([id, m]) => [m.cliModel, id]));
  const seenFriendly = new Set();

  for (const am of apiModels) {
    const cliModel = am?.id;
    // Modern naming only (claude-<family>-…, family alphabetic). The legacy
    // claude-3-* generation derives to junk ids ('3-haiku') and was never
    // supported by mc — skip rather than pollute the picker.
    if (!cliModel || !/^claude-[a-z]+(-|$)/.test(cliModel)) continue;
    const friendly = deriveFriendlyId(cliModel);
    seenFriendly.add(friendly);

    const knownId = byCli.get(cliModel) || (models[friendly] ? friendly : null);
    if (knownId) {
      const m = models[knownId];
      let touched = false;
      if (am.max_input_tokens && m.maxCtx !== am.max_input_tokens) { m.maxCtx = am.max_input_tokens; touched = true; }
      if (am.max_tokens && m.maxOut !== am.max_tokens) { m.maxOut = am.max_tokens; touched = true; }
      if (m.retired) { delete m.retired; touched = true; }
      if (touched && !out.updated.includes(knownId)) out.updated.push(knownId);
      continue;
    }

    const kind = friendly.split('-')[0];
    const sibling = Object.values(models).find((m) => m.kind === kind);
    models[friendly] = {
      label: friendly.toUpperCase().replace('-', ' '),
      cliModel,
      kind,
      maxCtx: am.max_input_tokens || (sibling ? sibling.maxCtx : 200000),
      maxOut: am.max_tokens || (sibling ? sibling.maxOut : undefined),
      costPerMTokIn: sibling ? sibling.costPerMTokIn : 0,
      costPerMTokOut: sibling ? sibling.costPerMTokOut : 0,
      costPerMTokCacheCreation: sibling ? sibling.costPerMTokCacheCreation : 0,
      costPerMTokCacheRead: sibling ? sibling.costPerMTokCacheRead : 0,
      estimatedPricing: true,
    };
    byCli.set(cliModel, friendly);
    out.added.push(friendly);
  }

  // Anything mc lists that the API no longer serves → retired (kept for
  // cost history; selectors may dim it but it stays resolvable). Only when
  // the list yielded at least one recognized model — a degenerate list
  // (all-legacy, wrong account) must never mass-retire the catalog.
  if (seenFriendly.size === 0) return out;
  for (const [id, m] of Object.entries(models)) {
    if (!seenFriendly.has(id) && !m.retired) {
      m.retired = true;
      out.retired.push(id);
    }
  }
  return out;
}

// syncModelsFromApi — one-call convenience for boot: fetch + diff + merge.
// Resolves { ok, reason?, added?, updated?, retired? }; never throws.
export async function syncModelsFromApi(models, opts = {}) {
  const r = await listApiModels(opts);
  if (!r.ok) return r;
  return { ok: true, ...syncCatalogFromApi(models, r.models) };
}

// deriveFriendlyId — best-effort 'claude-opus-4-8' → 'opus-4.8'. Only used
// for models the probe discovers that aren't already in the catalog; known
// models are matched by cliModel and updated in place. Drops 8-digit date
// suffixes so a dated snapshot collapses to its family version.
export function deriveFriendlyId(cliModel) {
  const parts = String(cliModel).replace(/^claude-/, '').split('-');
  const kind = parts[0] || 'model';
  const ver = parts.slice(1).filter((p) => !/^\d{8}$/.test(p)).join('.');
  return ver ? `${kind}-${ver}` : kind;
}

// applyCacheToCatalog — overlay probed data onto the live MODELS object.
// MUTATES `models` (ESM live binding shared by every importer):
//   • known cliModel  → update maxCtx / maxOut from the real window
//   • unknown cliModel → add a new entry; pricing is inherited from the
//     newest same-`kind` model and flagged estimatedPricing:true.
// Returns { updated: [ids], added: [ids] } for the caller to report.
export function applyCacheToCatalog(models, cache) {
  const out = { updated: [], added: [] };
  if (!cache || !cache.models) return out;

  const byCli = new Map(Object.entries(models).map(([id, m]) => [m.cliModel, id]));

  for (const alias of Object.keys(cache.models)) {
    const { cliModel, contextWindow, maxOut } = cache.models[alias] || {};
    if (!cliModel) continue;

    const knownId = byCli.get(cliModel);
    if (knownId) {
      const m = models[knownId];
      if (contextWindow && m.maxCtx !== contextWindow) { m.maxCtx = contextWindow; }
      if (maxOut) m.maxOut = maxOut;
      if (!out.updated.includes(knownId)) out.updated.push(knownId);
      continue;
    }

    // Unknown model — add it. Infer kind from the alias (which IS the
    // family), inherit pricing/color from the newest same-kind entry.
    const kind = KNOWN_ALIASES.includes(alias) ? alias : deriveFriendlyId(cliModel).split('-')[0];
    const sibling = Object.values(models).find((m) => m.kind === kind);
    const id = deriveFriendlyId(cliModel);
    models[id] = {
      label: id.toUpperCase().replace('-', ' '),
      cliModel,
      kind,
      maxCtx: contextWindow || (sibling ? sibling.maxCtx : 200000),
      maxOut: maxOut || (sibling ? sibling.maxOut : undefined),
      costPerMTokIn: sibling ? sibling.costPerMTokIn : 0,
      costPerMTokOut: sibling ? sibling.costPerMTokOut : 0,
      costPerMTokCacheCreation: sibling ? sibling.costPerMTokCacheCreation : 0,
      costPerMTokCacheRead: sibling ? sibling.costPerMTokCacheRead : 0,
      estimatedPricing: true,
    };
    byCli.set(cliModel, id);
    out.added.push(id);
  }
  return out;
}
