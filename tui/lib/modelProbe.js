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
    const { stdout } = await execFileP(
      claudeBin,
      ['-p', '--model', alias, '--output-format', 'json', PROBE_PROMPT],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
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
export function saveModelCache(results, now = Date.now()) {
  const models = {};
  for (const r of results || []) {
    if (!r || r.error || !r.cliModel) continue;
    models[r.alias] = { cliModel: r.cliModel, contextWindow: r.contextWindow, maxOut: r.maxOut };
  }
  const payload = { fetchedAt: now, models };
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
