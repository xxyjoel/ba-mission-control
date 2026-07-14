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

export const MODELS = {
  'opus-4.8':   { label: 'OPUS 4.8',   cliModel: 'claude-opus-4-8',             kind: 'opus',   maxCtx: 1000000, maxOut: 64000, costPerMTokIn: 15, costPerMTokOut: 75, costPerMTokCacheCreation: 18.75, costPerMTokCacheRead: 1.5 },
  'sonnet-4.6': { label: 'SONNET 4.6', cliModel: 'claude-sonnet-4-6',           kind: 'sonnet', maxCtx: 200000,  costPerMTokIn: 3,  costPerMTokOut: 15, costPerMTokCacheCreation: 3.75,  costPerMTokCacheRead: 0.3 },
  'opus-4.7':   { label: 'OPUS 4.7',   cliModel: 'claude-opus-4-7',             kind: 'opus',   maxCtx: 200000,  costPerMTokIn: 15, costPerMTokOut: 75, costPerMTokCacheCreation: 18.75, costPerMTokCacheRead: 1.5 },
  'haiku-4.5':  { label: 'HAIKU 4.5',  cliModel: 'claude-haiku-4-5-20251001',   kind: 'haiku',  maxCtx: 200000,  costPerMTokIn: 1,  costPerMTokOut: 5,  costPerMTokCacheCreation: 1.25,  costPerMTokCacheRead: 0.1 },
};
// opus-4.8 maxCtx/maxOut VERIFIED 2026-06-22 via
//   claude -p --model opus --output-format json → modelUsage[claude-opus-4-8]
//   .contextWindow = 1_000_000, .maxOutputTokens = 64_000
// `:model refresh` re-runs that probe for every alias and overlays the
// live contextWindow onto this catalog (see tui/lib/modelProbe.js).
// TODO(opus-4.8-pricing): costPerMTokIn / costPerMTokOut are still
// mirrored from 4.7 (15/75 USD per MTok) — the probe reports only total
// costUSD per turn, not per-MTok rates, so pricing must be confirmed
// against the Anthropic pricing page. Cost display will be off if the
// rates moved.

export const MODEL_IDS = Object.keys(MODELS);

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
  if (m.kind === 'haiku') return theme.green;
  return theme.brBlue;
}
