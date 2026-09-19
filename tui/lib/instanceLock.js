// tui/lib/instanceLock.js — one mc per config dir (0365).
//
// Two mc instances sharing one sessions.json interleave load→merge→persist
// and clobber each other's records — the drifted-store substrate behind the
// slot-identity crossover (duplicate repos under different slot numbers,
// 15 slots on a 10-slot fleet). This happened for real during the
// stray-~/node_modules era: `mc` resolved to two different installs and the
// user ran both against the same config dir.
//
// Mechanism: a pidfile in the config dir. Second instance detects a LIVE
// holder and boots read-only for EVERY on-disk store (it still runs — killing
// the UX for a sandbox/test launch would be worse — but it cannot corrupt
// the shared stores). MC_ALLOW_MULTI=1 skips the check entirely for users
// who know what they're doing. A dead holder's lock is stale and replaced;
// so is a lock whose pid was RECYCLED by an unrelated process (the pid is
// alive but its process started after the lock was written — 0408/F4).

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, lstatSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configPath, getConfigDir } from './configDir.js';

export const LOCK_FILE = configPath('mc.lock');

// ── Read-only mode ──────────────────────────────────────────────────────
// 0408/F4: the single source of truth for "this instance must not write any
// on-disk store". Set when another live mc owns the config dir. EVERY store
// (sessionStore, costStore, settings, templateStore) gates its persist on
// this — previously only sessionStore honoured the flag, so a second
// instance still last-writer-wins'd costs-week.json / settings.json /
// templates.json. Lives here (not in sessionStore) so the stores can import
// it without importing each other.
let readOnlyMode = false;
export function setReadOnlyMode(v) { readOnlyMode = !!v; }
export function isReadOnlyMode() { return readOnlyMode; }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  // EPERM = the process exists but belongs to someone we can't signal —
  // that's ALIVE. Only ESRCH (no such process) means the lock is stale.
  catch (e) { return e?.code === 'EPERM'; }
}

// When the process now owning the lock's pid started this much LATER than
// the lock was written, the pid was recycled — the real holder is gone.
const STALE_START_SKEW_MS = 5000;

// Start time (unix ms) of a live process, via `ps -o lstart=` (argv-form,
// no shell). Returns null when it can't be determined — callers must treat
// null as "unknown", i.e. assume the holder is genuine.
function processStartMs(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Exported for the stale-lock test: true when the lock record describes a
// LIVE holder — pid alive AND, when both timestamps are knowable, the pid's
// process started before (or within skew of) the lock write. A recycled pid
// (process started well after startedAt) is NOT a holder.
export function lockHolderIsLive(rec, { startMsOf = processStartMs } = {}) {
  if (!rec || !pidAlive(rec.pid)) return false;
  const stamp = Number(rec.startedAt);
  if (!Number.isFinite(stamp)) return true; // legacy lock without a stamp — assume genuine
  const started = startMsOf(rec.pid);
  if (started == null) return true;         // can't tell — assume genuine
  return started - stamp <= STALE_START_SKEW_MS;
}

/**
 * acquireInstanceLock() → { ok: true } | { ok: false, holderPid }
 * ok:false means another live mc owns this config dir — read-only mode is
 * armed here so every store's persist() is refused; the caller surfaces
 * the warning.
 */
export function acquireInstanceLock() {
  if (process.env.MC_ALLOW_MULTI === '1') return { ok: true };
  try {
    const prev = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (prev?.pid !== process.pid && lockHolderIsLive(prev)) {
      setReadOnlyMode(true);
      return { ok: false, holderPid: prev.pid };
    }
  } catch { /* no lock or unreadable → treat as free */ }
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  } catch { /* lock write failing must never block boot */ }
  return { ok: true };
}

/** Best-effort release on clean shutdown; a crash leaves a stale lock that
 *  the next boot detects as dead and replaces. */
export function releaseInstanceLock() {
  try {
    const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (cur?.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

// ── One-time boot chmod pass (0408/S4) ──────────────────────────────────
// mc's on-disk state holds secrets (settings.json can carry the Slack
// webhook; transcripts under ~/.local/state/claude-mc hold whole
// conversations) and historically everything was written with the default
// umask → 0644/0755. New writes now pass explicit modes; this pass tightens
// what EXISTING installs already have on disk. Follows the heapProbe
// pattern: dirs 0700, files 0600, all best-effort, never throws.
// Symlinks are skipped (never chmod through a link).
function defaultStateDir() {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'claude-mc',
  );
}

export function tightenStateModes({ configDir = getConfigDir(), stateDir = defaultStateDir(), maxDepth = 3 } = {}) {
  let dirs = 0, files = 0;
  const walk = (dir, depth) => {
    let st;
    try { st = lstatSync(dir); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    try { if ((st.mode & 0o077) !== 0) { chmodSync(dir, 0o700); dirs++; } } catch {}
    if (depth <= 0) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let s;
      try { s = lstatSync(p); } catch { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) { walk(p, depth - 1); continue; }
      if (!s.isFile()) continue;
      try { if ((s.mode & 0o077) !== 0) { chmodSync(p, 0o600); files++; } } catch {}
    }
  };
  try { walk(configDir, maxDepth); } catch {}
  try { walk(stateDir, maxDepth); } catch {}
  return { dirs, files };
}
