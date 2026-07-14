// tui/lib/configDir.js — single source of truth for where mc stores
// state on disk.
//
// Default: ~/.config/claude-mc/  (matches the historical layout, so
// existing users see no change).
//
// Override: MC_CONFIG_DIR=/some/path forces mc to read+write all state
// (settings.json, sessions.json, costs-week.json, templates.json, and
// the debug-keys log) under that path instead. This is the safe-dev-on-
// mc workflow (audit #380-382): running `MC_CONFIG_DIR=/tmp/mc-dev tsx
// bin/mc.mjs` against this repo edits an isolated copy of state without
// risking the user's production sessions / settings / cost history.
//
// The directory is created on first access by callers using
// fs.mkdirSync(getConfigDir(), { recursive: true }) — we don't do it
// here because the helper is import-time pure (cheap, no I/O).

import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_OVERRIDE = process.env.MC_CONFIG_DIR;

let cached = null;

export function getConfigDir() {
  if (cached) return cached;
  cached = ENV_OVERRIDE && ENV_OVERRIDE.length > 0
    ? ENV_OVERRIDE
    : join(homedir(), '.config', 'claude-mc');
  return cached;
}

// True when mc is running with an isolated config dir — used to render
// a "DEV — sandboxed" banner so the operator never confuses a sandboxed
// session with their real one.
export function isSandboxed() {
  return !!(ENV_OVERRIDE && ENV_OVERRIDE.length > 0);
}

// Resolve a file path inside the active config dir. Pure string join;
// caller is responsible for creating intermediate dirs.
export function configPath(...parts) {
  return join(getConfigDir(), ...parts);
}
