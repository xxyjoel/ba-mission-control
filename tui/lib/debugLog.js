// tui/lib/debugLog.js — opt-in structured debug log for daily-driver users
// chasing an intermittent issue, WITHOUT trashing the Ink TUI render.
//
// Enabled ONLY when MC_DEBUG=1 (or =true). Writes one JSON object per line to
//   $XDG_STATE_HOME/claude-mc/debug.log   (default ~/.local/state/claude-mc/)
// It NEVER writes to stdout/stderr — the TUI owns the terminal — and every
// failure is swallowed: debug logging must never break the app. When MC_DEBUG
// is unset, dlog() short-circuits before any filesystem work, so users who
// aren't debugging pay zero I/O cost.
//
// appendFileSync (not a long-lived WriteStream) is deliberate: each line is
// flushed immediately, so the log survives a hard crash and tests can assert
// file contents synchronously. Volume is low (lifecycle/error events only).
//
// TODO(logging): rotate when the file exceeds ~10MB (roll to debug.log.1).

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

function enabled() {
  const v = process.env.MC_DEBUG;
  return v === '1' || v === 'true';
}

// Exported so the About/Help surfaces (and tests) can show where the log lives.
export function debugLogPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'claude-mc', 'debug.log');
}

let dirReady = false;

// dlog(scope, msg, kv?) — append a structured record. No-op unless MC_DEBUG.
//   scope: short subsystem tag, e.g. 'pty' / 'app' / 'tailer'
//   msg:   human-readable event
//   kv:    optional flat object of extra fields (merged into the record)
export function dlog(scope, msg, kv) {
  if (!enabled()) return;
  try {
    const p = debugLogPath();
    if (!dirReady) { mkdirSync(dirname(p), { recursive: true }); dirReady = true; }
    const rec = { t: new Date().toISOString(), scope: String(scope), msg: String(msg) };
    if (kv && typeof kv === 'object') Object.assign(rec, kv);
    appendFileSync(p, JSON.stringify(rec) + '\n');
  } catch { /* logging must never break the app */ }
}
