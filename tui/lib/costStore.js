// tui/lib/costStore.js — weekly cost bucket persisted to disk.
//
// Each launched `claude` subprocess reports a monotonic `costSession`
// (USD, summed from the `total_cost_usd` field in stream-json `result`
// events). That number resets when the process exits, so the fleet can't
// give a true week-over-week figure on its own.
//
// We solve that here by tracking the delta from each agent's last-seen
// costSession and adding it to a per-ISO-week bucket on disk. The store
// is keyed by ISO week (e.g. "2026-W21") so a rotation happens
// automatically every Monday 00:00 UTC.
//
// File: ~/.config/claude-mc/costs-week.json
//   {
//     "currentWeek": "2026-W21",
//     "weeks": { "2026-W21": 12.45, "2026-W20": 3.10 },
//     "lastSeen": { "<sessionId>": 0.42 }  // memory of last costSession per session
//   }
//
// `lastSeen` is intentionally NOT keyed by week — it tracks the
// monotonic position of a still-live session, regardless of which week
// the deltas land in.
//
// 0408/F2: `lastSeen` is keyed by SESSION id (stable across resumes), not
// agent id (minted fresh per launch). A resumed session restores its saved
// costSession total; under agent-id keying every resume made that restored
// total look like brand-new spend and double-counted the week/day buckets.
// Belt-and-braces: the FIRST sight of any session key is a baseline, never
// a delta — so even a session whose lastSeen entry was gc'd (or a store
// wiped between runs) can't re-count its restored total.
//
// 0408/F4: persist() merges the deltas accrued since the last write onto
// whatever is on disk instead of blind-overwriting — two instances sharing
// one config dir no longer last-writer-wins each other's spend — and a
// read-only instance (instanceLock lost) never writes at all.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';
import { isReadOnlyMode } from './instanceLock.js';

const CONFIG_DIR  = getConfigDir();
const STORE_FILE  = join(CONFIG_DIR, 'costs-week.json');
const BACKUP_FILE = STORE_FILE + '.bak';
const TMP_FILE    = STORE_FILE + '.tmp';

// Return ISO-week string for a given Date, e.g. "2026-W21".
// Uses the standard "Thursday of the same week" rule (ISO 8601).
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;             // 1=Mon..7=Sun
  t.setUTCDate(t.getUTCDate() + 4 - day);     // shift to Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// UTC date stamp for the day, e.g. "2026-05-31". Used as the daily
// budget key so spend rolls over at 00:00 UTC.
export function isoDay(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function emptyStore() {
  return { currentWeek: isoWeek(), currentDay: isoDay(), weeks: {}, days: {}, lastSeen: {} };
}

// See sessionStore.js for the rationale on the .bak rollback pattern
// — a corrupted costs-week.json used to silently zero out the user's
// week-to-date spend, which is the wrong default when the data is
// trivially recoverable from the prior write (audit #161).
// Legacy `lastSeen` keys from the agent-id era ("s3-lkj4x2", "slot-3").
// Agent ids are re-minted every launch, so these entries can never match a
// live agent again — drop them at load (0408/F2 migration).
const LEGACY_AGENT_ID_RX = /^(s\d+-|slot-\d+$)/;

function tryRead(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw.weeks)    raw.weeks = {};
    if (!raw.days)     raw.days = {};
    if (!raw.lastSeen) raw.lastSeen = {};
    for (const k of Object.keys(raw.lastSeen)) {
      if (LEGACY_AGENT_ID_RX.test(k)) delete raw.lastSeen[k];
    }
    if (!raw.currentWeek) raw.currentWeek = isoWeek();
    if (!raw.currentDay)  raw.currentDay  = isoDay();
    return raw;
  } catch {
    return null;
  }
}

function loadStore() {
  return tryRead(STORE_FILE) || tryRead(BACKUP_FILE) || emptyStore();
}

// Fold the deltas accrued since the last successful write onto the CURRENT
// on-disk buckets (another instance may have written since we loaded), then
// write the merged result. Returns the merged store on success, null when
// nothing was written (read-only mode or write failure) — the caller decides
// whether to clear its pending deltas.
function persist(store, pending = { weeks: {}, days: {} }) {
  if (isReadOnlyMode()) return null; // 0408/F4: second instance never writes
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true, mode: 0o700 });
    // Merge: for bucket keys that exist on disk, disk is the shared base and
    // our unpersisted delta is added on top; keys only we know keep our
    // in-memory value. lastSeen is ours (the seed-on-first-sight rule in
    // update() protects any other instance whose entries this drops).
    const disk = tryRead(STORE_FILE) || tryRead(BACKUP_FILE);
    if (disk) {
      for (const [name, mine] of [['weeks', store.weeks], ['days', store.days]]) {
        for (const k of Object.keys(disk[name])) {
          mine[k] = disk[name][k] + (pending[name]?.[k] || 0);
        }
      }
    }
    // Retention applies to the merged view too, so a merge can't resurrect
    // pruned keys past the rolling window.
    pruneOldest(store.weeks, WEEKS_KEEP);
    pruneOldest(store.days, DAYS_KEEP);
    const payload = JSON.stringify(store, null, 2);
    if (existsSync(STORE_FILE)) {
      try { copyFileSync(STORE_FILE, BACKUP_FILE); chmodSync(BACKUP_FILE, 0o600); } catch { /* best-effort */ }
    }
    writeFileSync(TMP_FILE, payload, { mode: 0o600 });
    renameSync(TMP_FILE, STORE_FILE);
    return store;
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
    return null;
  }
}

// Rolling retention for the historical cost buckets. Without a cap `weeks`/`days`
// accrue one key forever (one/week, one/day) and are re-serialized on every
// persist() — unbounded over the install lifetime (audit 2026-07-30, task 0354).
// The window keeps enough recent history for any dashboard view while bounding
// growth: ~1 year of weeks, ~3 months of days. Current week/day are always the
// largest keys, so they survive the prune.
export const WEEKS_KEEP = 53;
export const DAYS_KEEP = 90;

// Drop all but the most-recent `keep` keys from a bucket map. ISO-week
// ("YYYY-Www") and UTC-day ("YYYY-MM-DD") keys sort lexicographically =
// chronologically, so the tail of the sorted keys is the recent window. Returns
// true if anything was removed. Safe: buckets are historical totals with no
// re-read/double-count semantics (unlike subagent tailer offsets, task 0350).
function pruneOldest(bucket, keep) {
  const keys = Object.keys(bucket);
  if (keys.length <= keep) return false;
  keys.sort();
  let changed = false;
  for (const k of keys.slice(0, keys.length - keep)) { delete bucket[k]; changed = true; }
  return changed;
}

// CostStore — singleton-ish. Constructed once and mutated via `update()`.
export class CostStore {
  constructor() {
    this.store = loadStore();
    this.dirty = false;
    // Deltas applied to weeks/days since the last SUCCESSFUL persist. What
    // persist() folds onto the current on-disk value for shared keys, so a
    // concurrent instance's spend isn't overwritten (0408/F4).
    this.pending = { weeks: {}, days: {} };
  }

  // The lastSeen key for one agent: the SESSION id when it has one (stable
  // across relaunches / resumes — 0408/F2), the agent id as a fallback for
  // mocks/tests that carry no session.
  static seenKey(a) { return a.sessionId || a.id; }

  #addDelta(bucket, key, delta) {
    this.store[bucket][key] = (this.store[bucket][key] || 0) + delta;
    this.pending[bucket][key] = (this.pending[bucket][key] || 0) + delta;
  }

  // Apply a snapshot's agents to the store. For each live agent:
  // - delta = costSession - lastSeen[sessionId]   (clamped at 0)
  // - add delta to the current ISO week + UTC day
  // - update lastSeen[sessionId]
  // The FIRST sight of a session key is always a BASELINE, never a delta: a
  // resumed session restores its persisted costSession total, and counting
  // that restored total as fresh spend double-counted the week on every
  // resume (0408/F2). A genuinely fresh session is first observed at ~$0,
  // so baselining loses nothing there.
  //
  // Returns { weekCost, dayCost } so the caller can render the fleet totals.
  update(agents) {
    const wk = isoWeek();
    const day = isoDay();
    if (wk !== this.store.currentWeek) {
      this.store.currentWeek = wk;
      this.dirty = true;
    }
    if (day !== this.store.currentDay) {
      this.store.currentDay = day;
      this.dirty = true;
    }
    if (!this.store.weeks[wk]) this.store.weeks[wk] = 0;
    if (!this.store.days[day]) this.store.days[day] = 0;

    for (const a of agents) {
      if (!a || a.status === 'empty') continue;
      // 0420: null = the provider cannot measure cost (yet). Reading it as 0
      // would baseline at 0, or re-anchor a known total to 0 and re-count it
      // when the figure returns. Skip it: no baseline, no delta, no reset.
      // TODO(provider-usage-cost): a fresh non-Claude session's first synced
      // figure lands as a baseline under the first-sight rule, so spend before
      // the first usage sync is not counted. Decide in the usage-sync phase.
      if (a.costSession === null) continue;
      const key = CostStore.seenKey(a);
      const cur = Number(a.costSession || 0);
      if (!(key in this.store.lastSeen)) {
        // First sight → baseline. Restored totals (resume) land here and are
        // absorbed; new spend accrues as deltas from this anchor.
        this.store.lastSeen[key] = cur;
        if (cur > 0) this.dirty = true; // persist a non-zero baseline
        continue;
      }
      const last = Number(this.store.lastSeen[key] || 0);
      if (cur > last) {
        const delta = cur - last;
        this.#addDelta('weeks', wk, delta);
        this.#addDelta('days', day, delta);
        this.store.lastSeen[key] = cur;
        this.dirty = true;
      } else if (cur < last) {
        // Process restarted or crashed and reset its counter — re-anchor.
        this.store.lastSeen[key] = cur;
        this.dirty = true;
      }
    }

    if (this.dirty) {
      this.#persist();
      this.dirty = false;
    }
    return {
      weekCost: this.store.weeks[wk] || 0,
      dayCost: this.store.days[day] || 0,
    };
  }

  // Write-through with delta merge; clears pending only when the write landed
  // (a failed / read-only write keeps the deltas for the next attempt).
  #persist() {
    if (persist(this.store, this.pending)) {
      this.pending = { weeks: {}, days: {} };
    }
  }

  // Drop any lastSeen entries whose session isn't in the live agents list.
  // Called when sessions exit so the store doesn't grow unboundedly across
  // long sessions.
  gc(agents) {
    const liveKeys = new Set(
      agents.filter(a => a && a.status !== 'empty').map(a => CostStore.seenKey(a)),
    );
    let changed = false;
    for (const key of Object.keys(this.store.lastSeen)) {
      if (!liveKeys.has(key)) { delete this.store.lastSeen[key]; changed = true; }
    }
    // Bound the historical cost buckets (task 0354) — they otherwise grow one
    // key per week/day forever. Current week/day are the largest keys, so the
    // rolling-window prune never drops the live buckets.
    if (pruneOldest(this.store.weeks, WEEKS_KEEP)) changed = true;
    if (pruneOldest(this.store.days, DAYS_KEEP)) changed = true;
    if (changed) { this.#persist(); }
  }

  weekCost() {
    return this.store.weeks[this.store.currentWeek] || 0;
  }

  // Today's fleet-wide spend total (UTC day). Used by the daily budget
  // guardrail in App.launchSession() to refuse new launches once the
  // configured budget is exceeded.
  dayCost() {
    // Recompute current day at read time so a long-running app picks up
    // the date rollover even if no update() has been called yet today.
    const day = isoDay();
    return this.store.days[day] || 0;
  }
}
