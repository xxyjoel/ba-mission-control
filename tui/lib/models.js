// tui/lib/models.js — Claude model metadata for display.
//
// The friendly id (key below) is what we store in settings and show in the
// modal cycler. `cliModel` is the canonical CLI model name we pass to
// `claude --model`. We use full names — not the 'sonnet'/'opus'/'haiku'
// aliases — so our label and the actual model stay locked together: if
// Anthropic ships a newer 'sonnet' tomorrow, the user keeps running 4.6
// until we ship a UI update.
//
// Haiku 4.5 uses the date-suffixed form `claude-haiku-4-5-20251001` —
// the bare `claude-haiku-4-5` resolves to the same model today but acts
// as a moving alias; pinning the dated snapshot guarantees the cost
// figures below match the model the user actually gets.
//
// Verified against `claude -p --model sonnet --output-format json` whose
// `modelUsage` key reports the resolved name; see the README for the probe.
//
// Costs are USD per million tokens (published Anthropic pricing). maxCtx
// drives the per-card ctx %. Last refreshed: 2026-06-10.
//
// Cache pricing (added 2026-06-17 for the JSONL connector):
//   costPerMTokCacheCreation = 1.25 × costPerMTokIn (Anthropic's
//     "cache write" rate — slightly higher than fresh input)
//   costPerMTokCacheRead     = 0.10 × costPerMTokIn (90% discount —
//     this is where the prompt-caching savings come from)
// The JSONL `usage` block carries `cache_creation_input_tokens` and
// `cache_read_input_tokens` separately; without the cache prices,
// the per-turn cost derivation in `server/jsonlConnector.mjs` would
// skew badly on heavy-cache turns (cache_creation often dominates
// the input column on mc's first-turn-per-session shape).

// Pricing + context refreshed 2026-09-24 against Anthropic's published Opus 5.5
// rates ($4/$20) and the prior Opus/Fable/Sonnet book. Opus 5.5 is the current
// newest opus; Opus 5 stays in the book for pinned sessions.
// NEW MODELS ARE ideally discovered (Models API / alias probe). Hand-add when
// the CLI login has no API credential AND the alias probe cannot see a family
// (or when a release is public before the next claude-code cask ships it).
export const MODELS = {
  'opus-5.5':   { label: 'OPUS 5.5',   cliModel: 'claude-opus-5-5',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 4,  costPerMTokOut: 20, costPerMTokCacheCreation: 5,     costPerMTokCacheRead: 0.4 },
  'opus-5':     { label: 'OPUS 5',     cliModel: 'claude-opus-5',             kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'opus-4.8':   { label: 'OPUS 4.8',   cliModel: 'claude-opus-4-8',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'opus-4.7':   { label: 'OPUS 4.7',   cliModel: 'claude-opus-4-7',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'opus-4.6':   { label: 'OPUS 4.6',   cliModel: 'claude-opus-4-6',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'fable-5.1':  { label: 'FABLE 5.1',  cliModel: 'claude-fable-5-1',          kind: 'fable',  maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 10, costPerMTokOut: 50, costPerMTokCacheCreation: 12.5,  costPerMTokCacheRead: 1.0, estimatedPricing: true },
  'fable-5':    { label: 'FABLE 5',    cliModel: 'claude-fable-5',            kind: 'fable',  maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 10, costPerMTokOut: 50, costPerMTokCacheCreation: 12.5,  costPerMTokCacheRead: 1.0 },
  'sonnet-5':   { label: 'SONNET 5',   cliModel: 'claude-sonnet-5',           kind: 'sonnet', maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 3,  costPerMTokOut: 15, costPerMTokCacheCreation: 3.75,  costPerMTokCacheRead: 0.3 },
  'sonnet-4.6': { label: 'SONNET 4.6', cliModel: 'claude-sonnet-4-6',         kind: 'sonnet', maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 3,  costPerMTokOut: 15, costPerMTokCacheCreation: 3.75,  costPerMTokCacheRead: 0.3 },
  'haiku-4.5':  { label: 'HAIKU 4.5',  cliModel: 'claude-haiku-4-5-20251001', kind: 'haiku',  maxCtx: 200000,  maxOut: 64000,  costPerMTokIn: 1,  costPerMTokOut: 5,  costPerMTokCacheCreation: 1.25,  costPerMTokCacheRead: 0.1 },
};
// Sonnet 5 has an introductory rate ($2/$10 per MTok through 2026-08-31); we use
// the standard $3/$15 so the cost display doesn't jump when intro pricing ends.
// `:model refresh` re-runs the CLI probe per alias and overlays the live
// contextWindow onto this catalog (see tui/lib/modelProbe.js).
// An unknown model (a claude release newer than this catalog) is NOT fatal:
// the agent passes the model string straight through to `--model`, and
// modelByCli returns null so the UI degrades gracefully (dim color, no cost).
// TODO(model-autodetect): probe `claude` on version change and reconcile new
// aliases into this catalog automatically (task 0348).

// modelIds — LIVE view of the catalog's ids. A function, not a frozen
// array: applyCacheToCatalog() mutates MODELS after module load (boot
// cache overlay, `:model refresh`, version-change auto-probe), and every
// selector (Settings cycler, NewSession ←/→, :model validation) must see
// discovered models. The old `MODEL_IDS = Object.keys(MODELS)` snapshot
// silently excluded anything discovered after import.
//
// 0420: other providers' models share this object under namespaced keys
// (`cursor:<id>`, see registerProviderModels). A Claude entry is one with no
// `provider` field, so `modelIds()` — every existing caller — still returns
// exactly the Claude list.
export function modelIds(provider = 'claude') {
  return Object.keys(MODELS).filter((id) => (MODELS[id].provider || 'claude') === provider);
}

const isClaudeEntry = (m) => !m.provider;

// ── Other providers (0420) ─────────────────────────────────────────────────
// Keys and cliModel are both `<provider>:<id>`, so the card's existing
// MODELS[agent.model] / modelByCli(agent.resolvedModel) lookups resolve them
// and nothing can collide with a Claude id. No pricing fields: cost for these
// comes from the provider's own usage feed or stays unknown.

// maxCtx from a vendor label such as "Claude Opus 5 1M Thinking" / "… 300K".
// Absent when the label names no size — the card already renders `limit ?`.
function maxCtxFromLabel(label) {
  const m = /(?:^|\s)(\d+(?:\.\d+)?)([MK])(?=\s|$)/i.exec(String(label || ''));
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000));
}

// registerProviderModels — replace `provider`'s entries with `models`
// ([{ id, label }]). Claude entries are never touched.
export function registerProviderModels(provider, models) {
  if (!provider || provider === 'claude') return;
  const prefix = `${provider}:`;
  for (const k of Object.keys(MODELS)) if (k.startsWith(prefix)) delete MODELS[k];
  for (const { id, label } of models || []) {
    if (!id) continue;
    const key = `${prefix}${id}`;
    const entry = { label: label || id, cliModel: key, kind: provider, provider };
    const maxCtx = maxCtxFromLabel(label);
    if (maxCtx) entry.maxCtx = maxCtx;
    MODELS[key] = entry;
  }
}

// cursorCliArg — the `--model` value for a Cursor catalog id. 'auto' is a real
// Cursor model id and passes through like any other.
export function cursorCliArg(modelId) {
  if (!modelId) return null;
  const s = String(modelId);
  return s.startsWith('cursor:') ? s.slice('cursor:'.length) || null : s;
}

// Zero-width / BOM characters the CLI pads some labels with.
const ZERO_WIDTH_RX = /[\u200b-\u200d\u2060\ufeff]/g;

// parseCursorModelList — `cursor-agent --list-models` stdout → [{ id, label }].
// Lines are `id - Label`; the header, blank lines and anything else are
// skipped. Never throws.
export function parseCursorModelList(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.replace(ZERO_WIDTH_RX, '').trim();
    const m = /^(\S+) - (.+)$/.exec(line);
    if (!m) continue;
    out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

// newestModelId — newest non-retired model of a kind, by the numeric version
// in its friendly id ('opus-5' → 5, 'opus-4.8' → 4.8). A LIVE computation over
// the catalog, so a model added by discovery (Models API sync / alias probe)
// wins the moment it lands — no hardcoded "current best" id anywhere.
export function newestModelId(kind = 'opus') {
  let best = null, bestV = -1;
  for (const [id, m] of Object.entries(MODELS)) {
    if (!isClaudeEntry(m) || m.kind !== kind || m.retired) continue;
    const v = parseFloat(String(id).slice(String(id).lastIndexOf('-') + 1));
    if (Number.isFinite(v) && v > bestV) { bestV = v; best = id; }
  }
  return best;
}

// resolveModelId — turn the defaultModel setting into a concrete catalog id.
// 'auto' (the shipped default) follows discovery: newest opus at resolve time.
// Any explicit id passes through untouched (user pinned a model on purpose).
export function resolveModelId(id, kind = 'opus') {
  if (id && id !== 'auto') return id;
  return newestModelId(kind) || modelIds()[0];
}

// kindFromModelId — infer the model FAMILY ('opus' | 'fable' | 'sonnet' |
// 'haiku' | …) from either id form: the CLI name ('claude-fable-5-1') or the
// friendly key ('fable-5.1'). Returns null when no family token is parseable.
// Pure string work — no catalog lookup — so it works for models the catalog
// has never heard of (the whole point: 0408-M2 pricing fallback).
export function kindFromModelId(modelId) {
  const s = String(modelId || '').toLowerCase();
  const m = /^claude-([a-z]+)(?:-|$)/.exec(s) || /^([a-z]+)(?:-[\d.]|$)/.exec(s);
  return m ? m[1] : null;
}

// estimatedPricingFor — pricing entry for a model the catalog does NOT know.
// 0408-M2: an unknown model must never price at $0 — that silently disables
// costSession, costCapUSD and dailyBudgetUSD for exactly the newest (most
// expensive) models. Rule: inherit the NEWEST same-family rate, flagged
// estimatedPricing (same contract a probe-discovered model gets). When even
// the family is unknown, inherit the newest opus — the default family
// everywhere else (resolveModelId) and a deliberate over- rather than
// under-estimate. Returns { id-less entry, estimatedPricing: true,
// estimatedFrom: <catalog id> } or null only when the catalog is empty.
export function estimatedPricingFor(modelId) {
  const kind = kindFromModelId(modelId);
  const srcId = (kind && newestModelId(kind)) || newestModelId('opus') || modelIds()[0];
  const src = srcId ? MODELS[srcId] : null;
  if (!src) return null;
  return { ...src, estimatedPricing: true, estimatedFrom: srcId };
}

// modelByCli — reverse-lookup a catalog entry by its CLI model name. claude
// reports the resolved cli model in every assistant event (→ agent.resolvedModel),
// and a mid-session `/model` switch lands there too — so this is how the UI
// reflects the CURRENT model rather than the launch-time one. Returns
// { id, ...entry } (id = the friendly catalog key, for modelColor) or null
// when the cli model isn't in the catalog (genuine drift / unknown model).
export function modelByCli(cliModel) {
  if (!cliModel) return null;
  const s = String(cliModel);
  for (const [id, m] of Object.entries(MODELS)) {
    if (m.cliModel === s) return { id, ...m };
  }
  // Friendly catalog key passed by mistake (or launch id reused as resolved).
  if (MODELS[s]) return { id: s, ...MODELS[s] };
  // Dated snapshot vs bare catalog id (…-20251001 / …-v1 suffixes).
  const bare = s.replace(/-\d{8}(-v\d+)?$/i, '');
  if (bare !== s) {
    for (const [id, m] of Object.entries(MODELS)) {
      if (m.cliModel === bare || String(m.cliModel).replace(/-\d{8}(-v\d+)?$/i, '') === bare) {
        return { id, ...m };
      }
    }
  }
  return null;
}

// resolveAgentModel — the entry Card / Zoom use for label, color, and ctx %.
// Prefer the live resolved CLI id; fall back through resolveModelId so a
// launch of `auto` still has a maxCtx denominator (otherwise Zoom shows
// `ctx …/?  ?%`). Resume often puts a CLI id in `agent.model` (store saves
// resolvedModel as the launch model) — modelByCli that too. Unknown CLI ids
// inherit maxCtx from the newest same-kind sibling when we can infer the family.
export function resolveAgentModel(agent) {
  if (!agent) return null;
  const resolved = modelByCli(agent.resolvedModel);
  if (resolved) return resolved;
  const launchId = resolveModelId(agent.model);
  if (launchId && MODELS[launchId]) return { id: launchId, ...MODELS[launchId] };
  if (agent.model && MODELS[agent.model]) return { id: agent.model, ...MODELS[agent.model] };
  // CLI id (or dated snapshot) sitting in the launch field — common after
  // :resume-all, which prefers store.resolvedModel over the friendly id.
  const launchCli = modelByCli(agent.model);
  if (launchCli) return launchCli;
  const driftId = agent.resolvedModel || agent.model;
  if (driftId) {
    const kind = kindFromModelId(driftId);
    const sibId = kind && newestModelId(kind);
    if (sibId && MODELS[sibId]) {
      return {
        id: sibId,
        ...MODELS[sibId],
        cliModel: driftId,
        label: String(driftId).replace(/^claude-/, '').toUpperCase(),
        estimatedPricing: true,
      };
    }
  }
  return null;
}

// Display color per model (theme-relative, resolved at render). A non-Claude
// kind (e.g. 'cursor') falls through to the default below.
export function modelColor(id, theme) {
  const m = MODELS[id];
  if (!m) return theme.dim;
  if (m.kind === 'opus') return theme.magenta;
  if (m.kind === 'fable') return theme.yellow;   // top tier — distinct from opus
  if (m.kind === 'haiku') return theme.green;
  return theme.brBlue;                            // sonnet + any future kind
}
