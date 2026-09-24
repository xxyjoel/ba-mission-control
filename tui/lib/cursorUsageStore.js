// tui/lib/cursorUsageStore.js — Cursor dashboard usage totals per chat, on disk.
//
// File: ~/.config/claude-mc/cursor-usage.json (mode 0o600). Token counts only;
// never log this file's contents. The session token stays in the keychain — mc
// reads it in memory for API polls only.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';
import { isReadOnlyMode } from './instanceLock.js';

const CONFIG_DIR = getConfigDir();
const STORE_FILE = join(CONFIG_DIR, 'cursor-usage.json');
const BACKUP_FILE = STORE_FILE + '.bak';
const TMP_FILE = STORE_FILE + '.tmp';
const MAX_CHATS = 200;

const FIELDS = ['tokensIn', 'tokensCacheRead', 'tokensOut', 'context', 'costSession', 'estimated', 'lastEventTs'];

export function storeFilePath() {
  return STORE_FILE;
}

function emptyStore() {
  return { byChatId: {} };
}

function tryRead(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw.byChatId || typeof raw.byChatId !== 'object') raw.byChatId = {};
    return raw;
  } catch {
    return null;
  }
}

export function load() {
  return tryRead(STORE_FILE) || tryRead(BACKUP_FILE) || emptyStore();
}

function normalizeRow(row) {
  if (!row) return null;
  const out = { seen: new Set(Array.isArray(row.seen) ? row.seen : []) };
  for (const f of FIELDS) out[f] = row[f] ?? null;
  if (out.estimated === null) out.estimated = false;
  return out;
}

export function get(chatId, store = load()) {
  if (!chatId) return null;
  return normalizeRow(store.byChatId?.[chatId]);
}

function prune(store) {
  const ids = Object.keys(store.byChatId || {});
  if (ids.length <= MAX_CHATS) return;
  ids.sort((a, b) => (store.byChatId[b].lastEventTs ?? 0) - (store.byChatId[a].lastEventTs ?? 0));
  for (const id of ids.slice(MAX_CHATS)) delete store.byChatId[id];
}

function persist(store) {
  if (isReadOnlyMode()) return;
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true, mode: 0o700 });
    prune(store);
    const payload = JSON.stringify(store, null, 2);
    if (existsSync(STORE_FILE)) {
      try { copyFileSync(STORE_FILE, BACKUP_FILE); chmodSync(BACKUP_FILE, 0o600); } catch { /* best-effort */ }
    }
    writeFileSync(TMP_FILE, payload, { mode: 0o600 });
    renameSync(TMP_FILE, STORE_FILE);
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}

function seenToArray(seen) {
  if (seen instanceof Set) return [...seen];
  if (Array.isArray(seen)) return seen;
  return [];
}

/** Merge poller totals onto disk; union `seen` so re-polls cannot double-count. */
export function upsert(chatId, totals) {
  if (!chatId || !totals) return;
  const store = load();
  const prev = store.byChatId[chatId] || {};
  const mergedSeen = new Set([...seenToArray(prev.seen), ...seenToArray(totals.seen)]);
  const row = { seen: [...mergedSeen] };
  for (const f of FIELDS) {
    row[f] = totals[f] !== undefined ? totals[f] : (prev[f] ?? null);
  }
  store.byChatId[chatId] = row;
  persist(store);
}

/** Restore null card fields from disk after restart (costStore first-sight = baseline). */
export function seedAgentFromStore(agent) {
  if (!agent || agent.provider !== 'cursor' || !agent.sessionId) return false;
  const stored = get(agent.sessionId);
  if (!stored) return false;
  let changed = false;
  for (const f of FIELDS) {
    if (f === 'estimated' || f === 'lastEventTs') continue;
    if (agent[f] == null && stored[f] != null) {
      agent[f] = stored[f];
      changed = true;
    }
  }
  if (agent.estimated == null && stored.estimated != null) agent.estimated = stored.estimated;
  return changed;
}

/** Poller seed shape (Set seen) from a stored chat row. */
export function pollerTotalsFromStore(chatId) {
  const row = get(chatId);
  if (!row) return null;
  return { ...row, seen: new Set(row.seen) };
}
