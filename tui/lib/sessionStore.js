// tui/lib/sessionStore.js — persist slot→session metadata so the user
// can resume yesterday's sessions tomorrow, PLUS a rolling history of
// the last N sessions for historical reference.
//
// We only persist what's needed to relaunch a claude session that picks up
// where it left off:
//   - sessionId   : the UUID we passed to `claude --session-id`. Reusing it
//                   on relaunch lets claude rehydrate the conversation
//                   history from its own on-disk transcript.
//   - cwd, branch, model, name, permissionMode : pass-through to launch.
//
// File: ~/.config/claude-mc/sessions.json
//   {
//     "version": 2,
//     "savedAt": <unix ms>,
//     "bySlot": {
//       "1": { "sessionId":"...","cwd":"...","branch":"main","model":"sonnet-4.5","name":"repo","permissionMode":"acceptEdits","lastSeen": 1716000000000 }
//     },
//     "history": [
//       { "sessionId":"...","cwd":"...","branch":"main","model":"sonnet-4.6","name":"repo","permissionMode":"acceptEdits","firstSeen":1716000000000,"lastSeen":1716000000000 }
//       // … capped at settings.sessionHistoryLimit (default 20), newest first
//     ]
//   }
//
// v1 → v2 migration: add `history: []` on first read. Bumped silently —
// older mc versions just ignore the new field.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';

const CONFIG_DIR  = getConfigDir();
const STORE_FILE  = join(CONFIG_DIR, 'sessions.json');
const BACKUP_FILE = STORE_FILE + '.bak';
const TMP_FILE    = STORE_FILE + '.tmp';

function emptyStore() { return { version: 2, savedAt: 0, bySlot: {}, history: [], openSlots: [] }; }

// Expiry window for LEGACY resume records that predate the per-record `live`
// flag: such a record counts as "open at last close" only if it synced within
// this window of the store's most-recent write (measured relative to that write,
// not wall-clock now). Keeps recent migration-era records resumable while aging
// out ancient leftovers. Records that carry `live` ignore this entirely.
const RESUME_RECENCY_MS = 120_000;

// Quit mode governs what a persist writes. 'save' (the default during a running
// session) records the FULL resumable record per open slot — sessionId plus the
// in/out/cost totals — so a slot that crashes can be resumed and a proper
// quit+save restores the live conversations. 'clear' records only the LOCATION
// (cwd/branch/model/name); `:resume-all` then reopens those repos as fresh
// sessions with no history and zeroed totals.
//
// The mc-exit paths set 'clear' just before the final write so that "save is
// opt-in": only the explicit [s] save & quit leaves the mode at 'save'. Every
// other exit — [d] quit-no-save, terminal close (SIGHUP), Ctrl-C (SIGINT),
// SIGTERM — calls setQuitMode('clear') in main.jsx's shutdown path.
let quitMode = 'save';
export function setQuitMode(mode) {
  quitMode = mode === 'save' ? 'save' : 'clear';
}
export function getQuitMode() { return quitMode; }

// Strict UUID v4-ish check. claude --resume / --session-id reject
// anything that isn't a UUID with "Error: Invalid session ID. Must be
// a valid UUID." — so any record with a non-UUID sessionId (legacy
// fixture data, hand-edits, MockAgent leakage) is unusable. We drop
// these at load time so the auto-resume flow doesn't burn the
// 3-attempt restart budget on a record claude will never accept.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(sid) {
  return typeof sid === 'string' && UUID_RE.test(sid);
}

// Migrate model IDs that have changed across versions. Kept here (rather
// than imported from settings.js) so this module stays standalone.
const MODEL_ID_MIGRATIONS = {
  'sonnet-4.5': 'sonnet-4.6',
  'opus-4.1':   'opus-4.7',
};

function migrate(rec) {
  if (!rec) return rec;
  if (MODEL_ID_MIGRATIONS[rec.model]) return { ...rec, model: MODEL_ID_MIGRATIONS[rec.model] };
  return rec;
}

// Try to read+parse a candidate file. Returns the parsed store on
// success, null on any failure (file missing, JSON corrupt, etc.). The
// caller uses null as a signal to try the next candidate (.bak then
// emptyStore) so a corrupted main file never silently wipes the user's
// resume records (audit #160).
function tryRead(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw.bySlot) raw.bySlot = {};
    if (!Array.isArray(raw.history)) raw.history = [];
    if (!Array.isArray(raw.openSlots)) raw.openSlots = [];
    // Drop any record whose sessionId isn't a valid UUID. These come
    // from MockAgent fixtures leaking into the real config or from
    // hand-edits — claude rejects them with "Must be a valid UUID."
    // and the auto-resume loop pointlessly retries. EXCEPTION: a
    // location-only ("fresh") record intentionally carries no sessionId —
    // it reopens the repo as a brand-new session — so keep those as long
    // as they name a cwd.
    for (const slot of Object.keys(raw.bySlot)) {
      const r = raw.bySlot[slot];
      const keep = (r && r.fresh && r.cwd) || isValidSessionId(r?.sessionId);
      if (!keep) delete raw.bySlot[slot];
    }
    raw.history = raw.history.filter(h => isValidSessionId(h?.sessionId));
    return raw;
  } catch {
    return null;
  }
}

export function loadSessions() {
  // Read order: main → backup → empty. The .bak file is the previous
  // good state; if main is corrupt we recover the previous snapshot
  // rather than silently dropping every resume record.
  const main = tryRead(STORE_FILE);
  if (main) return main;
  const bak = tryRead(BACKUP_FILE);
  if (bak) {
    // Surface the recovery on next write (the .bak becomes the new main
    // via persist's tmp+rename below).
    return bak;
  }
  return emptyStore();
}

function persist(store) {
  // Atomic write pattern with .bak rotation. Steps:
  //   1. Ensure config dir exists
  //   2. Copy current main → .bak (so we have a rollback target if a
  //      future load finds the new main corrupt)
  //   3. Write the new state to .tmp
  //   4. Rename .tmp → main (atomic on POSIX)
  // Step 2 is best-effort — if main doesn't exist or copy fails, we
  // proceed with the write rather than blocking persistence.
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    store.savedAt = Date.now();
    const payload = JSON.stringify(store, null, 2);
    if (existsSync(STORE_FILE)) {
      try { copyFileSync(STORE_FILE, BACKUP_FILE); } catch { /* best-effort backup */ }
    }
    writeFileSync(TMP_FILE, payload);
    renameSync(TMP_FILE, STORE_FILE);
  } catch {
    // Persistence failed entirely — clean up any stray .tmp so the
    // next attempt isn't blocked by a half-written file.
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}

// Sync the on-disk store with the live fleet. For each live (non-empty)
// slot, we replace the record with the current parameters — including the
// session UUID — so a relaunch resumes the right transcript. Empty slots
// keep their previous record so the user can resume a session that just
// crashed or was killed.
//
// Returns true if anything actually changed (used by the caller to
// decide whether to bump the React state — but writes are debounced so
// even noisy callers don't hammer the disk).
export function syncFromSnapshot(agents, { historyLimit = 20 } = {}) {
  const store = loadSessions();
  const saving = quitMode === 'save';
  let dirty = false;
  for (const a of agents) {
    if (!a || a.status === 'empty') continue;
    // A full save needs the session UUID to resume the conversation; without
    // one we can only record the location. (Live agents always have a sid, so
    // this only guards odd transient states.)
    if (saving && !a.sessionId) continue;

    const base = {
      cwd: a.cwd,
      branch: a.branch,
      model: a.model,
      name: a.name,
      permissionMode: a.permissionMode || 'acceptEdits',
      lastSeen: Date.now(),
      live: true,
    };
    // SAVE → full record: resumes the conversation AND its running totals.
    // CLEAR (default) → location-only: reopen the repo as a fresh session,
    // with no conversation history and no token/cost carryover.
    const rec = saving
      ? {
          ...base,
          fresh: false,
          sessionId: a.sessionId,
          tokensIn: a.tokensIn || 0,
          tokensCacheRead: a.tokensCacheRead || 0,
          tokensOut: a.tokensOut || 0,
          costSession: a.costSession || 0,
        }
      : { ...base, fresh: true };

    const prev = store.bySlot[a.slot];
    const identityChanged = !prev
      || prev.cwd !== rec.cwd
      || !!prev.fresh !== !!rec.fresh
      || (saving && prev.sessionId !== rec.sessionId);
    if (identityChanged) {
      store.bySlot[a.slot] = rec;
      dirty = true;
    } else if (Date.now() - (prev.lastSeen || 0) > 60_000 || prev.live === false || saving) {
      // Refresh lastSeen periodically, immediately when a closed slot reopens,
      // and always on an explicit save (so the persisted totals are current).
      store.bySlot[a.slot] = { ...prev, ...rec };
      dirty = true;
    }

    // History upsert — REFERENCE ONLY, keyed on sessionId, never consumed by
    // `:resume-all`. Recorded for any identified session (even a clear-mode
    // breadcrumb) so the user can see where they've been.
    if (a.sessionId) {
      const hrec = { ...base, sessionId: a.sessionId };
      const hi = store.history.findIndex(h => h.sessionId === a.sessionId);
      if (hi === -1) {
        store.history.push({ ...hrec, firstSeen: hrec.lastSeen, lastSlot: a.slot });
        dirty = true;
      } else if (Date.now() - (store.history[hi].lastSeen || 0) > 60_000) {
        const firstSeen = store.history[hi].firstSeen || hrec.lastSeen;
        store.history[hi] = { ...store.history[hi], ...hrec, firstSeen, lastSlot: a.slot };
        dirty = true;
      }
    }
  }
  // Mark CLOSED slots so `:resume-all` skips them. A slot counts as closed
  // when it is empty in a snapshot that still has at least one live session
  // (a deliberate kill/close). We co-locate this `live` flag ON each bySlot
  // record rather than tracking a separate `openSlots` array: a parallel array
  // silently desyncs from bySlot — e.g. a long-running process whose code
  // predates the array faithfully updates bySlot but never the array, leaving
  // `:resume-all` pointed at a frozen, wrong set. Liveness on the record can't
  // desync, and the recency window in listOpenResumeRecords backstops a flag
  // that was never cleared (crash before the final sync).
  //
  // Guard: only mark closed when SOME slot is live. An all-empty snapshot is
  // boot / terminal-close (children all died at once), NOT a per-slot kill —
  // marking those closed would wipe the resume set.
  const liveSlots = new Set(
    agents.filter(a => a && a.status !== 'empty' && a.sessionId).map(a => a.slot),
  );
  if (liveSlots.size > 0) {
    for (const slot of Object.keys(store.bySlot)) {
      if (!liveSlots.has(Number(slot)) && store.bySlot[slot].live !== false) {
        store.bySlot[slot] = { ...store.bySlot[slot], live: false };
        dirty = true;
      }
    }
  }

  // Trim history to the configured limit, newest first. Dropped
  // entries are gone forever — that's the point of "LITE memory."
  if (store.history.length > historyLimit) {
    store.history.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    store.history = store.history.slice(0, historyLimit);
    dirty = true;
  }
  if (dirty) persist(store);
  return dirty;
}

export function getResumeRecord(slot) {
  const store = loadSessions();
  return migrate(store.bySlot[slot] || null);
}

export function listResumeRecords() {
  const store = loadSessions();
  return Object.entries(store.bySlot).map(([slot, rec]) => ({
    slot: parseInt(slot, 10),
    ...migrate(rec),
  })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

// The records for ONLY the slots that were open (live) at the last close —
// i.e. the sessions running when mc last closed. This is what `:resume-all`
// restarts: NOT every slot that ever held a session (those linger in bySlot
// for manual `:resume <slot>` / crash recovery). Newest-active first.
//
// Derived straight from bySlot, no separate index to desync. The `live` flag
// (set at the last sync that observed the slot) is authoritative:
//   - live === false  → explicitly closed/killed → skip.
//   - live === true   → open at the last close → restore, regardless of age.
//                       (Age must NOT matter here: after a partial resume, the
//                       resumed slots advance the store's timeline, and the
//                       still-dormant ones must not get aged out of resume-all.)
//   - live === undefined → a legacy record from an mc version before this flag.
//                       Treat as open only if it synced near the last close, so
//                       ancient leftovers expire instead of resurrecting. This
//                       branch stops mattering once every record carries `live`
//                       (i.e. after one run on this version).
// Recency is measured against the store's most-recent activity, not wall-clock
// now, so a resume the next day still restores everything that was live at close.
export function listOpenResumeRecords() {
  const store = loadSessions();
  const records = Object.entries(store.bySlot)
    .map(([slot, rec]) => ({ slot: parseInt(slot, 10), ...migrate(rec) }));
  const ref = Math.max(store.savedAt || 0, ...records.map(r => r.lastSeen || 0), 0);
  return records
    .filter(r => {
      if (r.live === false) return false;
      if (r.live === true) return true;
      return r.lastSeen && ref - r.lastSeen <= RESUME_RECENCY_MS;
    })
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

export function clearResumeRecord(slot) {
  const store = loadSessions();
  let changed = false;
  if (store.bySlot[slot]) { delete store.bySlot[slot]; changed = true; }
  // TODO(resume-cleanup): `openSlots` is vestigial — resume now derives from
  // bySlot's per-record `live` flag + recency window. This prune (and the
  // field in emptyStore/tryRead) can be dropped once no on-disk store still
  // carries a stale openSlots array from a pre-`live` mc version.
  if (Array.isArray(store.openSlots) && store.openSlots.includes(Number(slot))) {
    store.openSlots = store.openSlots.filter(s => Number(s) !== Number(slot));
    changed = true;
  }
  if (changed) persist(store);
}

// View-only: the rolling history of the last N sessions (newest first).
// REFERENCE ONLY — there is no `restoreFromHistory` and `:resume-all`
// deliberately ignores this array. If the user wants to revive an old
// session, they read the cwd/branch/model out of this list and launch
// a NEW session against the same repo via `:resume <slot>` (after
// `:forget`ing the slot) or NewSession. This deliberately omitted
// restore-from-history is what makes the LITE memory "lite": we keep
// the breadcrumbs, we don't auto-revive arbitrarily old transcripts
// that claude may have already aged out on disk.
export function listHistory(limit = 20) {
  const store = loadSessions();
  const sorted = [...store.history].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return sorted.slice(0, limit).map(migrate);
}

export function clearHistory() {
  const store = loadSessions();
  store.history = [];
  persist(store);
}
