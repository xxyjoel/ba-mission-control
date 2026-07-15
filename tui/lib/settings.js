// tui/lib/settings.js — TUI settings: defaults, schema, persistence on disk.
//
// Persisted to ~/.config/claude-mc/settings.json so layout/theme survives a
// restart. Schema matches Mission Control TUI.html so future menu additions
// stay 1:1 with the design.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';
import { PLUGINS, applyPluginDefaults } from './plugins.js';

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
  defaultModel: 'opus-4.8',
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
};

export const SETTINGS_SCHEMA = [
  { id: 'general', title: 'GENERAL', items: [
    { key: 'tickRate',     label: 'Update rate',          kind: 'number', min: 200, max: 5000, step: 100, unit: ' ms', desc: 'How often the UI re-samples derived stats' },
    { key: 'gitPollSec',   label: 'Git status poll',      kind: 'number', min: 1, max: 60, step: 1, unit: ' s' },
    { key: 'broadcastStaggerMs', label: 'Broadcast stagger', kind: 'number', min: 0, max: 2000, step: 50, unit: ' ms', desc: 'Delay between each per-session send in a broadcast / resume-all, so mc does not open many API connections at once. 0 = all at once.' },
    { key: 'vimKeys',      label: 'Vim keys (h j k l)',   kind: 'toggle', desc: 'Use hjkl alongside arrow keys' },
    { key: 'clock24',      label: '24-hour clock',        kind: 'toggle' },
    { key: 'autoResumeOnStart', label: 'Auto-resume sessions on startup', kind: 'toggle', desc: 'On boot, restore every saved session whose slot is empty. Off → just shows a `:resume-all` hint instead.' },
    { key: 'sessionHistoryLimit', label: 'Session history limit', kind: 'number', min: 0, max: 200, step: 5, unit: ' sessions', desc: 'View-only history for `:history`. NOT used by :resume-all — that only restores the last-active state.' },
    { key: 'defaultModel', label: 'Default model',        kind: 'cycle',  options: ['opus-4.8', 'sonnet-4.6', 'opus-4.7', 'haiku-4.5'], desc: 'New-session default. `:model refresh` re-probes the live catalog (ctx window, resolved name).' },
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
    { key: 'ctxThreshold', label: 'Context warning threshold', kind: 'number', min: 50000, max: 200000, step: 5000, unit: ' tok' },
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
  { id: 'notes', title: 'NOTES', items: [] },
];

// One-shot migrations for keys that have changed IDs across versions.
// Keeps settings files written by older versions usable.
const MODEL_ID_MIGRATIONS = {
  'sonnet-4.5': 'sonnet-4.6',
  'opus-4.1':   'opus-4.7',
};

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
    return merged;
  } catch {
    return null;
  }
}

export function loadSettings() {
  return tryRead(CONFIG_FILE) || tryRead(BACKUP_FILE) || applyPluginDefaults({ ...SETTINGS_DEFAULTS });
}

export function saveSettings(settings) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    const payload = JSON.stringify(settings, null, 2);
    if (existsSync(CONFIG_FILE)) {
      try { copyFileSync(CONFIG_FILE, BACKUP_FILE); } catch { /* best-effort */ }
    }
    writeFileSync(TMP_FILE, payload);
    renameSync(TMP_FILE, CONFIG_FILE);
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}
