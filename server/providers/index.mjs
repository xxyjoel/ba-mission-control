// server/providers/index.mjs — the registry of slot backends ("subscriptions").
//
// A slot runs one interactive agent CLI in a PTY. Claude Code was the only
// backend; Cursor is the second (task 0420). Everything that differs between
// them is declared here, so the fleet grid, the card and the stores never ask
// "which vendor is this?" — they read a descriptor.
//
// A descriptor is metadata plus bounded probes. Probes take an injectable
// `exec(bin, args, { timeout }) → Promise<stdout>` so tests never spawn.
//
// SECURITY: CLAUDE_BIN and CURSOR_AGENT_BIN are user-controlled. They are only
// ever argv[0] of execFile — never part of a shell string.

import { execFile } from 'node:child_process';
import { probeAuth as probeClaudeAuth } from '../../tui/lib/auth.js';

const PROBE_TIMEOUT_MS = 5000;

function defaultExec(bin, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

async function probeVersion(bin, exec) {
  try {
    const out = await exec(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS });
    const version = String(out).trim().split('\n')[0];
    return version ? { ok: true, version } : { ok: false, error: 'empty --version output' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── Cursor ─────────────────────────────────────────────────────────────────

const CURSOR_MODES = ['default', 'plan', 'ask', 'auto-review', 'force'];

// cursorModeFor — the Cursor mode a Claude-named permission maps to (D4). Used
// when `settings.defaultPermission` (a Claude mode) seeds a Cursor launch.
export function cursorModeFor(mode) {
  if (CURSOR_MODES.includes(mode)) return mode;
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'auto-review';
  if (mode === 'bypassPermissions') return 'force';
  return 'default';
}

// cursorModeArgs — discrete argv for a Cursor mode. Unknown → no flags.
export function cursorModeArgs(mode) {
  switch (mode) {
    case 'plan': return ['--mode', 'plan'];
    case 'ask': return ['--mode', 'ask'];
    case 'auto-review': return ['--auto-review'];
    case 'force': return ['--force'];
    default: return [];
  }
}

// parseCursorStatus — `cursor-agent status --format json` → auth summary.
// Never throws; anything unreadable is "not ok" with the reason attached.
export function parseCursorStatus(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    return {
      ok: !!j.isAuthenticated,
      email: j.userInfo?.email || null,
      plan: null,
      method: j.isAuthenticated ? 'cursor login' : null,
      error: j.isAuthenticated ? null : 'not logged in — connect in Settings → SUBSCRIPTIONS',
    };
  } catch (e) {
    return { ok: false, email: null, plan: null, method: null, error: `unreadable status: ${e?.message || e}` };
  }
}

const cursor = {
  id: 'cursor',
  label: 'Cursor',
  short: 'CUR',
  bin: () => process.env.CURSOR_AGENT_BIN || 'cursor-agent',
  probeInstalled({ exec = defaultExec } = {}) { return probeVersion(this.bin(), exec); },
  async probeAuth({ exec = defaultExec } = {}) {
    try {
      return parseCursorStatus(await exec(this.bin(), ['status', '--format', 'json'], { timeout: PROBE_TIMEOUT_MS }));
    } catch (e) {
      return { ok: false, email: null, plan: null, method: null, error: e?.message || String(e) };
    }
  },
  loginArgv: ['login'],
  logoutArgv: ['logout'],
  permissionModes: CURSOR_MODES,
  defaultModelSetting: 'cursorDefaultModel',
  defaultModeSetting: 'cursorDefaultMode',
  zoomTarget: 'cursor',
  capabilities: {
    costMetered: false,      // only via the opt-in dashboard usage sync
    tokensMetered: false,
    hooks: true,
    backgroundSessions: false,
    compact: false,
    update: false,
    modelRefresh: false,
  },
};

// ── Claude ─────────────────────────────────────────────────────────────────

const claude = {
  id: 'claude',
  label: 'Claude Code',
  short: 'CC',
  bin: () => process.env.CLAUDE_BIN || 'claude',
  probeInstalled({ exec = defaultExec } = {}) { return probeVersion(this.bin(), exec); },
  // tui/lib/auth.js is the existing (sync, bounded) probe; wrapped so both
  // providers share one async shape.
  async probeAuth({ probe = probeClaudeAuth } = {}) {
    try {
      const r = probe();
      return {
        ok: !!r?.ok,
        email: r?.email || null,
        plan: r?.subscription || null,
        method: r?.method || null,
        error: r?.ok ? null : (r?.error || 'not logged in — run `claude auth login`'),
      };
    } catch (e) {
      return { ok: false, email: null, plan: null, method: null, error: e?.message || String(e) };
    }
  },
  loginArgv: ['auth', 'login'],
  logoutArgv: ['auth', 'logout'],
  permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
  defaultModelSetting: 'defaultModel',
  defaultModeSetting: 'defaultPermission',
  zoomTarget: 'claude',
  capabilities: {
    costMetered: true,
    tokensMetered: true,
    hooks: true,
    backgroundSessions: true,
    compact: true,
    update: true,
    modelRefresh: true,
  },
};

// ── Registry ───────────────────────────────────────────────────────────────

const PROVIDERS = [claude, cursor];
export const PROVIDER_IDS = PROVIDERS.map(p => p.id);

export function listProviders() { return PROVIDERS.slice(); }

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

// enabledProviders — which subscriptions the user has switched on. Claude is
// always on (it is the product's baseline). Being enabled says nothing about
// being logged in — callers that need that run probeAuth().
export function enabledProviders(settings) {
  const s = settings || {};
  return PROVIDERS.filter(p => p.id === 'claude' || s[`subscriptions_${p.id}_enabled`] === true);
}
