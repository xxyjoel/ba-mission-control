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

// Pricing + context refreshed 2026-07-27 against the authoritative Claude model
// catalog (Fable/Mythos 5, Opus 4.8/4.7/4.6, Sonnet 5/4.6, Haiku 4.5). Opus is
// $5/$25 per MTok (previously mis-mirrored from an old 15/75 figure); Opus 4.7
// and Sonnet 4.6 are 1M context (previously 200K). Cache rates follow the file
// convention: cacheCreation = 1.25×in, cacheRead = 0.10×in.
// NEW MODELS ARE NOT ADDED HERE BY HAND. This table is the offline pricing
// book for models whose published rates we've verified. Net-new models
// (e.g. Opus 5, which claude v2.1.220's bare `opus` alias resolves to) are
// DISCOVERED from the source of truth — the claude CLI itself — via
// tui/lib/modelProbe.js: probe → models-cache.json → applyCacheToCatalog()
// merges them into this object at boot / on `:model refresh` / on a claude
// version change, with pricing inherited from the newest same-kind sibling
// and flagged estimatedPricing until a verified row is added here.
export const MODELS = {
  'opus-4.8':   { label: 'OPUS 4.8',   cliModel: 'claude-opus-4-8',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'opus-4.7':   { label: 'OPUS 4.7',   cliModel: 'claude-opus-4-7',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
  'opus-4.6':   { label: 'OPUS 4.6',   cliModel: 'claude-opus-4-6',           kind: 'opus',   maxCtx: 1000000, maxOut: 128000, costPerMTokIn: 5,  costPerMTokOut: 25, costPerMTokCacheCreation: 6.25,  costPerMTokCacheRead: 0.5 },
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
export function modelIds() { return Object.keys(MODELS); }

// modelByCli — reverse-lookup a catalog entry by its CLI model name. claude
// reports the resolved cli model in every assistant event (→ agent.resolvedModel),
// and a mid-session `/model` switch lands there too — so this is how the UI
// reflects the CURRENT model rather than the launch-time one. Returns
// { id, ...entry } (id = the friendly catalog key, for modelColor) or null
// when the cli model isn't in the catalog (genuine drift / unknown model).
export function modelByCli(cliModel) {
  if (!cliModel) return null;
  for (const [id, m] of Object.entries(MODELS)) {
    if (m.cliModel === cliModel) return { id, ...m };
  }
  return null;
}

// Display color per model (theme-relative, resolved at render).
export function modelColor(id, theme) {
  const m = MODELS[id];
  if (!m) return theme.dim;
  if (m.kind === 'opus') return theme.magenta;
  if (m.kind === 'fable') return theme.yellow;   // top tier — distinct from opus
  if (m.kind === 'haiku') return theme.green;
  return theme.brBlue;                            // sonnet + any future kind
}
