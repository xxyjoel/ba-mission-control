// tui/lib/settings.js — TUI settings: defaults, schema, persistence on disk.
//
// Persisted to ~/.config/claude-mc/settings.json so layout/theme survives a
// restart. Schema matches Mission Control TUI.html so future menu additions
// stay 1:1 with the design.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';
import { isReadOnlyMode } from './instanceLock.js';
import { PLUGINS, applyPluginDefaults } from './plugins.js';
// The Default-model cycler lists the LIVE catalog (static entries + models
// discovered from the claude CLI probe). Passed as a function so it is
// re-evaluated on every cycle — a hardcoded array here silently fell out of
// sync with the catalog twice (0367).
import { modelIds } from './models.js';
import { PROVIDER_IDS, getProvider } from '../../server/providers/index.mjs';

const CONFIG_DIR  = getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, 'settings.json');
const BACKUP_FILE = CONFIG_FILE + '.bak';
const TMP_FILE    = CONFIG_FILE + '.tmp';

export const SETTINGS_DEFAULTS = {
  theme: 'BlueArch',
  tickRate: 700,           // ms — only affects UI polling cadence; agent state is event-driven
  density: 'regular',      // compact | regular | spacious
  gridCols: 5,             // 3 | 4 | 5
  // Max cards shown per pane. When the live-card count exceeds this, the
  // grid pages: the pane keeps this many, overflow moves to the next pane
  // (switch with [ / ]). A COUNT, independent of gridCols (which only sets
  // width) — so "keep 9 visible" means a 3×3 pane regardless of column
  // width. 0 = no cap (fill as many as physically fit). The pane is also
  // capped by what fits the terminal height so it can never be clipped.
  windowsPerPane: 9,
  // Maximum live sessions. Default 10 (10 fits the 1-9/0 hotkey scheme);
  // bumping it forces slots 11+ to be reached via arrow nav or `:goto N`.
  // Applied at Fleet construction — change requires an mc restart.
  maxSlots: 10,
  showFleetLog: true,
  fleetLogLines: 10,
  // 'narrative' (default) filters the fleet log to assistant text + errors
  // + broadcasts — the "I did X / doing Y" lines a human reads to follow
  // what claude is saying, without bash/tool/system noise. 'all' shows
  // every event kind (tool, sys, think, user, asst, err, bcast). Toggle
  // live with Shift+L. (Zoom is unaffected — it always shows the full PTY.)
  fleetLogMode: 'narrative', // 'narrative' | 'all'
  // When false (default) the Card tail hides tool/sys/think events so
  // the 3-line tile preview surfaces user/asst/note/err entries — what
  // the human cares about at a glance. Tools still visible by zooming.
  cardShowTools: false,
  // When true (default), claude's own "update available" banner is lifted out
  // of the zoom PTY body and shown as a discrete chip on the right of the zoom
  // header, so it stops encroaching on the conversation. Off → leave claude's
  // banner where claude paints it.
  hideClaudeUpdateBanner: true,
  borderStyle: 'rounded',  // rounded | sharp | double
  ctxThreshold: 150000,
  warnPct: 85,
  // Delay (ms) BETWEEN each per-session send in a broadcast / resume-all, so
  // mc doesn't open many streaming API connections in the same instant — a
  // self-induced ECONNRESET / overload risk with several live slots. 0 = fire
  // all at once (legacy). 200ms spaces 10 sessions over ~2s.
  broadcastStaggerMs: 200,
  clock24: true,
  vimKeys: true,
  // When true, on boot mc auto-restores every saved session whose slot
  // is empty. Off by default to avoid surprise API spend on launch.
  // Toggle via Settings (Esc menu) or `:autoresume on|off`. The toast
  // hint runs either way — it just tells the user how to restore manually
  // when this is off.
  autoResumeOnStart: false,
  // How many sessions to keep in the LITE history (view-only via
  // `:history`). Different from `bySlot` (recent-active, max 10) — this
  // is a rolling breadcrumb trail for historical reference. Bumping the
  // limit retroactively grows the trail; lowering it trims to the
  // newest N on the next sync tick.
  sessionHistoryLimit: 20,
  // Newest statically-priced entry. Discovered models (e.g. opus-5) can be
  // made the default with `:model default <id>` once the probe has run.
  defaultModel: 'auto',
  // Boot-time model discovery from the Models API (free GET /v1/models when
  // an env credential exists) + the claude-version-change alias probe. Off →
  // discovery only via manual `:model refresh` (security review 2026-08-10:
  // boot egress must have an opt-out).
  syncModelsOnBoot: true,
  defaultPermission: 'acceptEdits', // default | acceptEdits | bypassPermissions | plan
  gitPollSec: 6,
  // Repo scan locations for the New Session picker. Empty = use the
  // built-in defaults (or the REPO_PARENTS env var). When non-empty these
  // REPLACE the defaults — only these dirs are walked. Set via the repo
  // location picker (`:repos`); stored as absolute or ~-prefixed paths.
  repoParents: [],
  broadcastConfirm: true,
  autoCompactSuggest: true,
  toastDurationMs: 4000,
  // Per-slot session cost cap (USD). 0 disables. When a slot's
  // costSession crosses this number, Agent.send() refuses further
  // user-driven messages until the cap is reset via :resetcap <slot>.
  // Designed to catch runaway Bash-loops before they cost $20.
  costCapUSD: 0,
  // Fleet-wide cumulative spend cap for the calendar day (UTC). 0
  // disables. Fleet.launch() refuses new sessions once today's total
  // exceeds this number. Existing sessions keep running — this guards
  // against starting new work, not against ongoing turns.
  dailyBudgetUSD: 0,
  // Slack Incoming Webhook URL — used by :feedback and :request. Leave
  // empty to disable. Set with `:slack <url>` from the command bar.
  slackWebhook: '',
  // Subscriptions (0420). mc stores only these flags — credentials stay with
  // each vendor CLI. Claude is always enabled; Cursor needs its toggle on AND
  // a connected `cursor-agent` before New Session offers it.
  subscriptions_cursor_enabled: false,
  defaultProvider: 'claude',
  cursorDefaultModel: 'auto',   // bare Cursor model id; launches use `cursor:<id>`
  cursorDefaultMode: 'default', // a Cursor-native mode (providers/index.mjs)
  cursorStatusHooks: true,
  cursorAutoTrust: false,
  cursorUsageSync: false,
};

// Cursor model ids for the default-model cycler, stored bare (no `cursor:`
// namespace). Only namespaced catalog entries count, so a modelIds() that
// ignores its argument (Claude-only catalog) contributes nothing.
// TODO(provider-models): drop the prefix filter once models.js ships
// modelIds(provider) with namespaced `cursor:<id>` entries.
function cursorModelOptions() {
  let ids = [];
  try { ids = modelIds('cursor') || []; } catch { ids = []; }
  const bare = ids.filter(id => typeof id === 'string' && id.startsWith('cursor:')).map(id => id.slice('cursor:'.length));
  return ['auto', ...bare.filter(id => id && id !== 'auto')];
}

// One-line auth status for a SUBSCRIPTIONS row. `st` is the probe state kept
// by Settings.jsx: { state: 'checking'|'connected'|'disconnected'|'not-installed', email, plan, bin }.
export function subscriptionStatusText(st) {
  if (!st || st.state === 'checking') return '◌ checking…';
  if (st.state === 'connected') return ['● connected', st.email, st.plan].filter(Boolean).join(' · ');
  if (st.state === 'not-installed') return `○ not installed — install ${st.bin}`;
  return '○ not connected';
}

// A provider's status row: shows the probe result, ↵ connects (or, for
// providers other than Claude, disconnects). `ctx` comes from Settings.jsx.
function subscriptionStatusRow(id, label, desc) {
  return {
    key: `sub_${id}_status`, label, kind: 'action', provider: id, desc,
    compute: (_s, ctx) => subscriptionStatusText(ctx?.status?.(id)),
    hint: (_s, ctx) => {
      const st = ctx?.status?.(id);
      if (st?.state === 'disconnected') return '↵ connect';
      if (st?.state === 'connected' && id !== 'claude') return '↵ disconnect';
      return '';
    },
    run: (ctx) => {
      const st = ctx.status(id);
      if (st?.state === 'disconnected') ctx.connect(id);
      else if (st?.state === 'connected' && id !== 'claude') ctx.disconnect(id);
      else if (st?.state === 'not-installed') ctx.notice(subscriptionStatusText(st));
    },
  };
}

export const SETTINGS_SCHEMA = [
  { id: 'general', title: 'GENERAL', items: [
    { key: 'tickRate',     label: 'Update rate',          kind: 'number', min: 200, max: 5000, step: 100, unit: ' ms', desc: 'How often the UI re-samples derived stats' },
    { key: 'gitPollSec',   label: 'Git status poll',      kind: 'number', min: 1, max: 60, step: 1, unit: ' s' },
    { key: 'broadcastStaggerMs', label: 'Broadcast stagger', kind: 'number', min: 0, max: 2000, step: 50, unit: ' ms', desc: 'Delay between each per-session send in a broadcast / resume-all, so mc does not open many API connections at once. 0 = all at once.' },
    { key: 'vimKeys',      label: 'Vim keys (h j k l)',   kind: 'toggle', desc: 'Use hjkl alongside arrow keys' },
    { key: 'clock24',      label: '24-hour clock',        kind: 'toggle' },
    { key: 'autoResumeOnStart', label: 'Auto-resume sessions on startup', kind: 'toggle', desc: 'On boot, restore every saved session whose slot is empty. Off → just shows a `:resume-all` hint instead.' },
    { key: 'sessionHistoryLimit', label: 'Session history limit', kind: 'number', min: 0, max: 200, step: 5, unit: ' sessions', desc: 'View-only history for `:history`. NOT used by :resume-all — that only restores the last-active state.' },
    { key: 'defaultModel', label: 'Default model',        kind: 'cycle',  options: () => ['auto', ...modelIds()], desc: 'New-session default. `auto` follows discovery (newest Opus in the live catalog); an explicit id pins it. `:model refresh` re-probes the source.' },
    { key: 'syncModelsOnBoot', label: 'Discover models on startup', kind: 'toggle', desc: 'On boot: free Models-API catalog sync (needs ANTHROPIC_API_KEY/AUTH_TOKEN in env) + alias re-probe when the claude CLI version changed (billed, rare). Off → `:model refresh` only.' },
    { key: 'defaultPermission', label: 'Default permission mode', kind: 'cycle', options: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'], desc: 'Default for new sessions only — change a live session via :perm <mode>. bypassPermissions removes all guardrails.' },
  ]},
  { id: 'layout', title: 'LAYOUT', items: [
    { key: 'maxSlots',      label: 'Maximum live sessions', kind: 'number', min: 1, max: 64, step: 1, unit: ' slots', desc: 'Applies live. Bumping above 10 requires arrow nav or :goto N for slots 11+. Shrinking is limited to above your highest active session.' },
    { key: 'density',       label: 'Density',          kind: 'cycle',  options: ['compact', 'regular', 'spacious'] },
    { key: 'gridCols',      label: 'Grid columns',     kind: 'cycle',  options: [3, 4, 5] },
    { key: 'windowsPerPane', label: 'Max windows per pane', kind: 'number', min: 0, max: 32, step: 1, unit: ' cards', desc: 'Cards per pane before the grid pages ([ / ] to switch). 0 = fill as many as fit. Also capped by terminal height so a pane never clips.' },
    { key: 'borderStyle',   label: 'Card borders',     kind: 'cycle',  options: ['rounded', 'sharp', 'double'], desc: '╭ rounded  ┌ sharp  ╔ double' },
    { key: 'showFleetLog',  label: 'Show fleet log',   kind: 'toggle' },
    { key: 'fleetLogLines', label: 'Fleet log lines',  kind: 'number', min: 4, max: 40, step: 2 },
    { key: 'fleetLogMode',  label: 'Fleet log content', kind: 'cycle',  options: ['all', 'narrative'], desc: 'narrative: only assistant text + errors (skip bash/tools/sys). Shift+L cycles live.' },
    { key: 'cardShowTools', label: 'Card tail: show tool events',  kind: 'toggle', desc: 'Off (default): cards show user/asst/note only. Tools still visible in zoom.' },
    { key: 'hideClaudeUpdateBanner', label: 'Hide claude update banner in zoom', kind: 'toggle', desc: 'On (default): lift claude\'s own "update available" banner out of the zoom body and show it as a discrete chip on the right of the header.' },
  ]},
  { id: 'colors', title: 'COLORS', items: [
    { key: 'theme', label: 'Color theme', kind: 'cycle',
      options: ['BlueArch', 'Tokyo Night', 'Gruvbox Dark', 'Catppuccin Mocha', 'Solarized Dark', 'Amber (CRT)', 'Matrix'] },
  ]},
  { id: 'alerts', title: 'ALERTS', items: [
    { key: 'ctxThreshold', label: 'Context warning threshold', kind: 'number', min: 50000, max: null, step: 5000, unit: ' tok', desc: 'No upper cap — set above 200k for large-context models. The ± stepper moves 5k at a time (edit settings.json directly for a big jump). TODO(settings-entry): add direct numeric entry so large thresholds do not need ~160 keypresses.' },
    { key: 'warnPct',      label: 'Yellow band starts at',     kind: 'number', min: 50, max: 99, step: 5, unit: ' %' },
    { key: 'autoCompactSuggest', label: 'Suggest /compact at threshold', kind: 'toggle' },
  ]},
  { id: 'safety', title: 'SAFETY', items: [
    { key: 'broadcastConfirm', label: 'Confirm before broadcast', kind: 'toggle', desc: 'Stops a stray ↵ from blasting all sessions' },
    { key: 'costCapUSD',       label: 'Per-slot cost cap',  kind: 'number', min: 0, max: 100, step: 0.5, unit: ' USD', desc: '0 disables. When a session crosses this, further sends are refused until :resetcap <slot>.' },
    { key: 'dailyBudgetUSD',   label: 'Fleet daily budget', kind: 'number', min: 0, max: 1000, step: 1, unit: ' USD', desc: '0 disables. Refuses new launches once today\'s fleet total exceeds.' },
  ]},
  // PLUGINS — memory-management features. Each row toggles a plugin
  // declared in tui/lib/plugins.js. The `desc` column shows what the
  // plugin does so the user knows what they're enabling. Layer 1/2/3
  // grouping tracks ARCHITECTURE.md's "in-session / cross-session /
  // external" model.
  { id: 'plugins', title: 'PLUGINS · memory management', items:
    PLUGINS.map(p => ({
      key: p.key,
      label: `[L${p.layer}] ${p.label}`,
      kind: 'toggle',
      desc: p.desc,
    })),
  },
  { id: 'feedback', title: 'FEEDBACK', items: [
    // Read-only here — the URL is sensitive so we don't render it in
    // the settings UI. Configure via `:slack <url>` instead.
    { key: 'slackWebhook', label: 'Slack webhook configured', kind: 'computed',
      compute: (s) => s.slackWebhook ? '◆ yes (hidden)' : '○ no — set with `:slack <url>`',
      desc: 'Used by :feedback and :request. Configure with `:slack <url>` from the command bar.' },
  ]},
  // SUBSCRIPTIONS (0420) — placed just before NOTES so no existing tab's
  // number hotkey moves. Status rows are probed when the tab first opens.
  { id: 'subscriptions', title: 'SUBSCRIPTIONS', items: [
    subscriptionStatusRow('claude', 'Claude Code', 'Always enabled. Login belongs to the claude CLI (↵ runs `claude auth login` when not connected); mc stores no credentials.'),
    subscriptionStatusRow('cursor', 'Cursor', '↵ connect runs `cursor-agent login` (browser) · ↵ disconnect runs `cursor-agent logout`. mc stores no credentials.'),
    { key: 'subscriptions_cursor_enabled', label: 'Cursor · enabled', kind: 'toggle',
      desc: 'Offer Cursor in New Session once it is connected. Needs cursor-agent installed.',
      guard: (next, ctx) => {
        if (!next) return null;
        const st = ctx?.status?.('cursor');
        if (st?.state === 'not-installed') return subscriptionStatusText(st);
        if (!st || st.state === 'checking') return '◌ still checking cursor-agent — try again in a moment';
        return null;
      } },
    { key: 'cursorDefaultModel', label: 'Cursor · default model', kind: 'cycle', options: cursorModelOptions,
      desc: 'Model for new Cursor sessions. `auto` lets Cursor pick.' },
    { key: 'cursorDefaultMode', label: 'Cursor · default mode', kind: 'cycle', options: getProvider('cursor').permissionModes,
      desc: 'Mode for new Cursor sessions. force skips every approval.' },
    // TODO(cursor-hooks): install/remove the MC entry when this flips (Phase 5).
    { key: 'cursorStatusHooks', label: 'Cursor · status hooks', kind: 'toggle',
      desc: 'One entry in ~/.cursor/hooks.json so cards track Cursor status. Removed on disconnect.' },
    // TODO(cursor-usage): the poller that reads this lands in Phase 6.
    { key: 'cursorUsageSync', label: 'Cursor · usage sync', kind: 'toggle',
      desc: 'Polls the cursor.com usage API while a Cursor slot runs, for tokens and cost.' },
    { key: 'cursorAutoTrust', label: 'Cursor · auto-trust workspace', kind: 'toggle',
      desc: 'Passes --trust so Cursor skips its workspace-trust prompt.' },
    { key: 'defaultProvider', label: 'Default subscription', kind: 'cycle', options: PROVIDER_IDS,
      format: (id) => getProvider(id)?.label || String(id),
      desc: 'Preselected in New Session when more than one subscription is connected.' },
  ]},
  { id: 'notes', title: 'NOTES', items: [] },
];

// ── Fleet-log SUPPLY budget — derived from the schema above ──────────────────
//
// The fleet log can only draw events the agents actually SHIP. Until now every
// toJSON() shipped `tail.slice(-16)` over a 40-entry ring, so a
// `fleetLogLines: 32` + `fleetLogMode: 'narrative'` setting was unreachable by
// construction, not by budget: narrative keeps only asst/err/bcast rows with
// non-empty text. Measured live (2026-09-18, 6 sessions): 19 narrative rows out
// of 6 × 16 = 96 shipped entries — a ≈20% yield. 32 could never be filled.
//
// So both the ring and the shipped slice are sized off the schema's own ceiling
// for `fleetLogLines` instead of a hardcoded 16/40. Raising the schema max lifts
// them automatically; nothing else has to change.
export function settingMax(key, fallback) {
  for (const group of SETTINGS_SCHEMA) {
    for (const item of group.items || []) {
      if (item.key === key && Number.isFinite(item.max)) return item.max;
    }
  }
  return fallback;
}

export const FLEET_LOG_LINES_MAX = settingMax('fleetLogLines', 40);

// Fraction of tail entries that survive the narrative filter. Two data points:
//   • live fleet, 6 sessions: 19 narrative rows / 96 shipped ≈ 0.20 (average).
//   • ONE tool-using turn on the connector's own path: user + thinking +
//     asst-text + 2 tool_use + 2 tool_result = 7 entries, exactly 1 narrative
//     row ≈ 0.14. This is the shape to size for — a tool-heavy session is the
//     realistic worst case, and the log has to hold up there too.
// 1/8 takes the tool-heavy shape and adds a margin. The reciprocal is the
// headroom the ring needs so a SINGLE agent can fill the largest log the
// settings allow — the true worst case, since more sessions only add supply.
export const FLEET_LOG_NARRATIVE_YIELD = 0.125;

// Ring size == shipped slice: no point holding history that can never be
// shipped, nor shipping rows the ring cannot hold. 40 / 0.125 = 320.
export const TAIL_SHIP = Math.ceil(FLEET_LOG_LINES_MAX / FLEET_LOG_NARRATIVE_YIELD);
export const TAIL_MAX = TAIL_SHIP;

// Per-entry and per-ring text ceilings. An 8× bigger ring must not mean 8× the
// memory, and this project has a known long-uptime memory problem — so the ring
// is now bounded by CHARACTERS as well as by count. Before, only the connector
// capped entry text; appendTail() pushed raw, so a single unbounded stderr
// string could sit in the ring at any size (old bound: none).
//   TAIL_TEXT_MAX    per-entry ceiling. 8000 matches the connector's existing
//                    asst/user cap — `:compact-restart` re-injects a whole
//                    assistant summary out of tail.text (App.jsx), so this must
//                    stay well clear of a 3-5 paragraph reply.
//   TAIL_PREVIEW_MAX the preview is only ever rendered into a ONE-row slot.
//   TAIL_CHARS_MAX   hard per-agent ring budget; oldest entries evict first.
//                    400k chars ≈ 0.4 MB (one-byte) / 0.8 MB (worst-case
//                    two-byte) per agent — small next to the ~32 MB xterm
//                    scrollback each slot already holds (ptyAgent
//                    TERM_SCROLLBACK), and sized so a normal tool-heavy
//                    session reaches the COUNT cap first, not this one.
export const TAIL_TEXT_MAX = 8000;
export const TAIL_PREVIEW_MAX = 400;
export const TAIL_CHARS_MAX = 400_000;

// One-shot migrations for keys that have changed IDs across versions.
// Keeps settings files written by older versions usable.
const MODEL_ID_MIGRATIONS = {
  'sonnet-4.5': 'sonnet-4.6',
  'opus-4.1':   'opus-4.7',
};

// ── Read-time validation (0408/I4) ──────────────────────────────────────
// settings.json is hand-editable, so every value read off disk is untrusted:
// `"repoParents": "~/src"` crashed boot (`.join is not a function`),
// `"toastDurationMs": "4000"` spun the toast timer into a warning loop,
// `"tickRate": "fast"` made the tick interval NaN → a hot render loop.
// Coerce and clamp EVERY known key against SETTINGS_SCHEMA + the type of its
// default before the object reaches any consumer. Unknown keys pass through
// untouched (forward compatibility).

// Flat key → schema item map, built once. `computed` and `action` items are
// display-only and never stored.
const SCHEMA_BY_KEY = (() => {
  const map = {};
  for (const section of SETTINGS_SCHEMA) {
    for (const item of section.items || []) {
      if (item.kind !== 'computed' && item.kind !== 'action') map[item.key] = item;
    }
  }
  return map;
})();

// Toggle coercion: any falsy value is OFF (`"syncModelsOnBoot": 0` or an
// explicit null must not run boot discovery), the strings "true"/"false"
// mean what they say. Only a MISSING value (undefined — the key was never
// in the file, though the defaults-merge normally fills it first) falls
// back to the default.
function coerceToggle(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return !!def;
  if (v === 'false') return false;
  return !!v;
}

function coerceNumber(v, def, item) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = def;
  if (item) {
    if (typeof item.min === 'number' && n < item.min) n = item.min;
    if (typeof item.max === 'number' && n > item.max) n = item.max;
  }
  return n;
}

// Coerce one key. `def` is the authoritative default for the key; `item` is
// its SETTINGS_SCHEMA entry when one exists.
function coerceKey(v, def, item) {
  // cycle: value must be one of the declared options. Function options
  // (live model catalog) can't be enumerated safely at load — just require
  // a string. Numeric options ("gridCols": "4") match by string equality.
  if (item?.kind === 'cycle') {
    const options = typeof item.options === 'function' ? null : item.options;
    if (!options) return typeof v === 'string' && v ? v : def;
    const hit = options.find(o => o === v || String(o) === String(v));
    return hit !== undefined ? hit : def;
  }
  if (item?.kind === 'toggle' || typeof def === 'boolean') return coerceToggle(v, def);
  if (item?.kind === 'number' || typeof def === 'number') return coerceNumber(v, def, item);
  if (Array.isArray(def)) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length > 0) : [...def];
  }
  if (typeof def === 'string') return typeof v === 'string' ? v : def;
  return v;
}

// Validate a merged settings object in place. Exported for tests.
export function sanitizeSettings(merged) {
  for (const [key, def] of Object.entries(SETTINGS_DEFAULTS)) {
    merged[key] = coerceKey(merged[key], def, SCHEMA_BY_KEY[key]);
  }
  // Plugin toggles live outside SETTINGS_DEFAULTS; their defaults come from
  // the plugin declarations (applyPluginDefaults filled any missing keys
  // before this runs, so only garbage values need coercing here).
  for (const p of PLUGINS) {
    merged[p.key] = coerceToggle(merged[p.key], p.default);
  }
  return merged;
}

// .bak rollback — see sessionStore.js for rationale. A corrupted
// settings.json used to silently reset every preference to default,
// which is the wrong thing to do when the prior write is on disk
// and recoverable (audit #161).
function tryRead(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const merged = { ...SETTINGS_DEFAULTS, ...raw };
    applyPluginDefaults(merged);
    if (MODEL_ID_MIGRATIONS[merged.defaultModel]) {
      merged.defaultModel = MODEL_ID_MIGRATIONS[merged.defaultModel];
    }
    return sanitizeSettings(merged);
  } catch {
    return null;
  }
}

export function loadSettings() {
  return tryRead(CONFIG_FILE) || tryRead(BACKUP_FILE) || applyPluginDefaults({ ...SETTINGS_DEFAULTS });
}

export function saveSettings(settings) {
  if (isReadOnlyMode()) return; // 0408/F4: second instance must not clobber the shared file
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify(settings, null, 2);
    if (existsSync(CONFIG_FILE)) {
      try { copyFileSync(CONFIG_FILE, BACKUP_FILE); chmodSync(BACKUP_FILE, 0o600); } catch { /* best-effort */ }
    }
    writeFileSync(TMP_FILE, payload, { mode: 0o600 });
    renameSync(TMP_FILE, CONFIG_FILE);
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}
