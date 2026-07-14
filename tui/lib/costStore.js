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
//     "lastSeen": { "<agent.id>": 0.42 }   // memory of last costSession per agent
//   }
//
// `lastSeen` is intentionally NOT keyed by week — it tracks the
// monotonic position of a still-live session, regardless of which week
// the deltas land in.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';

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
function tryRead(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw.weeks)    raw.weeks = {};
    if (!raw.days)     raw.days = {};
    if (!raw.lastSeen) raw.lastSeen = {};
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

function persist(store) {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const payload = JSON.stringify(store, null, 2);
    if (existsSync(STORE_FILE)) {
      try { copyFileSync(STORE_FILE, BACKUP_FILE); } catch { /* best-effort */ }
    }
    writeFileSync(TMP_FILE, payload);
    renameSync(TMP_FILE, STORE_FILE);
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}

// CostStore — singleton-ish. Constructed once and mutated via `update()`.
export class CostStore {
  constructor() {
    this.store = loadStore();
    this.dirty = false;
  }

  // Apply a snapshot's agents to the store. For each live agent:
  // - delta = costSession - lastSeen[id]   (clamped at 0)
  // - add delta to the current ISO week
  // - update lastSeen[id]
  // For each `empty` slot we leave lastSeen alone so a killed-then-relaunched
  // session in the same slot starts fresh under a new id anyway.
  //
  // Returns { weekCost } so the caller can stamp it onto every live agent.
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
      const id = a.id;
      const cur = Number(a.costSession || 0);
      const last = Number(this.store.lastSeen[id] || 0);
      if (cur > last) {
        const delta = cur - last;
        this.store.weeks[wk] += delta;
        this.store.days[day] += delta;
        this.store.lastSeen[id] = cur;
        this.dirty = true;
      } else if (cur < last) {
        // Process restarted or crashed and reset its counter — re-anchor.
        this.store.lastSeen[id] = cur;
        this.dirty = true;
      }
    }

    if (this.dirty) {
      persist(this.store);
      this.dirty = false;
    }
    return {
      weekCost: this.store.weeks[wk] || 0,
      dayCost: this.store.days[day] || 0,
    };
  }

  // Drop any lastSeen entries whose id isn't in the live agents list.
  // Called when sessions exit so the store doesn't grow unboundedly across
  // long sessions.
  gc(agents) {
    const liveIds = new Set(agents.filter(a => a && a.status !== 'empty').map(a => a.id));
    let changed = false;
    for (const id of Object.keys(this.store.lastSeen)) {
      if (!liveIds.has(id)) { delete this.store.lastSeen[id]; changed = true; }
    }
    if (changed) { persist(this.store); }
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
