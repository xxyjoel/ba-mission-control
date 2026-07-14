// tui/lib/debugKeys.js — runtime-toggleable key-event logger.
//
// Initial state from MC_DEBUG_KEYS=1 env (set at launch). The user can
// flip it on/off at any time via the :debug-keys verb without
// restarting mc. Single mutable flag + a tiny module-level subscriber
// pattern so the StatusBar can render a "REC" indicator while logging.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from './configDir.js';

let active = process.env.MC_DEBUG_KEYS === '1';
let dirReady = false;
const subscribers = new Set();

export const DEBUG_KEYS_PATH = configPath('debug-keys.log');

function ensureDir() {
  if (dirReady) return;
  try {
    mkdirSync(dirname(DEBUG_KEYS_PATH), { recursive: true });
    dirReady = true;
  } catch {}
}

export function isDebugKeysActive() { return active; }

export function setDebugKeysActive(next) {
  const want = !!next;
  if (want === active) return active;
  active = want;
  // Stamp a marker line so the log shows when recording started/stopped.
  if (active) {
    ensureDir();
    try {
      appendFileSync(
        DEBUG_KEYS_PATH,
        JSON.stringify({ ts: Date.now(), event: 'debug-keys: ENABLED' }) + '\n',
      );
    } catch {}
  } else {
    try {
      appendFileSync(
        DEBUG_KEYS_PATH,
        JSON.stringify({ ts: Date.now(), event: 'debug-keys: DISABLED' }) + '\n',
      );
    } catch {}
  }
  for (const fn of subscribers) {
    try { fn(active); } catch {}
  }
  return active;
}

export function clearDebugKeysLog() {
  try {
    ensureDir();
    writeFileSync(DEBUG_KEYS_PATH, '');
    return true;
  } catch {
    return false;
  }
}

// React-side glue. Subscribers fire on every flip. Returns an
// unsubscribe function — caller calls it on unmount.
export function subscribeDebugKeys(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Append a single key event. Called by TextField.useInput. Cheap when
// inactive — single boolean check, no I/O. Errors swallowed because a
// debug logger that crashes the TUI would be a bad trade.
export function logKey(input, key, action) {
  if (!active) return;
  try {
    ensureDir();
    appendFileSync(
      DEBUG_KEYS_PATH,
      JSON.stringify({
        ts: Date.now(),
        input,
        inputBytes: [...(input || '')].map(c => c.charCodeAt(0)),
        key: Object.fromEntries(Object.entries(key).filter(([, v]) => v)),
        action,
      }) + '\n',
    );
  } catch {}
}
