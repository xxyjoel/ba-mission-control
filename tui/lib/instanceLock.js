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

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, lstatSync, chmodSync, statSync, renameSync, linkSync } from 'node:fs';
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

// 0445: a lock file that exists but can't be parsed yet is most likely a
// racer's lock mid-write ('wx' creates the file, THEN writes the body).
// Re-read briefly; if it stays unparseable, call it stale only once it is
// this old.
const UNREADABLE_GRACE_MS = 5000;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

// 0445: → { gone: true } (no lock file) | { raw, rec, id } (rec null when
// the body never parsed, with ageMs = how old the file is). id is the file's
// inode + mtime, stat'ed BEFORE the read: removeStaleLock deletes only that
// exact file, never a racer's fresh one that happens to read the same.
function readHolder(path) {
  let raw = '', ageMs = 0, id = null;
  for (let i = 0; i < 20; i++) {
    let st;
    try { st = statSync(path); }
    catch (e) { if (e?.code === 'ENOENT') return { gone: true }; st = null; }
    id = st ? `${st.ino}:${st.mtimeMs}` : null;
    try { raw = readFileSync(path, 'utf8'); }
    catch (e) { if (e?.code === 'ENOENT') return { gone: true }; raw = ''; }
    try { return { raw, rec: JSON.parse(raw), id }; } catch {}
    ageMs = st ? Date.now() - st.mtimeMs : 0;
    if (ageMs >= UNREADABLE_GRACE_MS) break;
    sleepSync(10);
  }
  return { raw, rec: null, ageMs, id };
}

// 0445: remove a STALE lock without clobbering a fresh one a racer wrote in
// between (two mc can judge the same dead lock stale at once). rename() moves
// whatever is at the path right now to a name only we own; if that is not
// the exact stale file we judged (same inode + mtime AND same body — a
// racer's just-created empty lock can read the same as a long-unreadable
// stale one), a racer already replaced it — link it back (link() never
// overwrites) and report the lock as taken.
// TODO(0445-3way): three mc taking over one stale lock at once can still
// crown two (C creates in the gap between B's rename and link-back); fix by
// serialising takeover behind a 'wx'-created mc.lock.takeover file.
// → true when the path is free to retry the 'wx' create.
function removeStaleLock(stale) {
  const mine = `${LOCK_FILE}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(LOCK_FILE, mine); }
  catch (e) { return e?.code === 'ENOENT'; } // already gone → retry the create
  let moved = null, movedId = null;
  try { const st = statSync(mine); movedId = `${st.ino}:${st.mtimeMs}`; } catch {}
  try { moved = readFileSync(mine, 'utf8'); } catch {}
  if (stale.id && movedId === stale.id && moved === stale.raw) { try { unlinkSync(mine); } catch {} return true; }
  try { linkSync(mine, LOCK_FILE); } catch {}
  try { unlinkSync(mine); } catch {}
  return false;
}

function lockedOut(holderPid, extra = {}) {
  setReadOnlyMode(true);
  return { ok: false, holderPid, ...extra };
}

/**
 * acquireInstanceLock() → { ok: true } | { ok: false, holderPid, error? }
 * ok:false means another live mc owns this config dir, or the lock could not
 * be created — read-only mode is armed here so every store's persist() is
 * refused; the caller surfaces the warning.
 *
 * 0445: the lock is created with flag 'wx' (O_CREAT|O_EXCL), so of two mc
 * booting at the same instant the kernel picks exactly one winner. The old
 * read-then-write let both win (5/5 in the 2026-10-08 review). A stale
 * holder is removed and the create retried ONCE.
 */
export function acquireInstanceLock() {
  if (process.env.MC_ALLOW_MULTI === '1') return { ok: true };
  try { mkdirSync(dirname(LOCK_FILE), { recursive: true, mode: 0o700 }); } catch {}
  // 0445: when this process started — a lock naming our pid but stamped
  // before this is a crashed mc's leftover whose pid we inherited (reboot,
  // container), not ours.
  const myStartMs = Date.now() - process.uptime() * 1000;
  let staleTries = 0;
  // 0445: a lock released between our create and our read ("gone") does not
  // use up the one stale retry — bounded so a flapping lock can't spin us.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
      return { ok: true };
    } catch (e) {
      // 0445: any failure other than "already exists" (EACCES, EROFS, ENOSPC…)
      // means we do NOT hold the lock — never report ok:true for it.
      if (e?.code !== 'EEXIST') return lockedOut(undefined, { error: e?.code || String(e) });
    }
    const h = readHolder(LOCK_FILE);
    if (h.gone) continue;                                  // released between create and read
    const ownPid = h.rec?.pid === process.pid;
    // Ours only if written by THIS process. An inherited-pid leftover is
    // treated as stale and replaced: kept as-is, its old startedAt makes a
    // second mc judge us recycled and take the lock (review defect 1).
    if (ownPid && Number(h.rec.startedAt) >= myStartMs - STALE_START_SKEW_MS) return { ok: true };
    if (!ownPid && h.rec && lockHolderIsLive(h.rec)) return lockedOut(h.rec.pid);
    if (!h.rec && h.ageMs < UNREADABLE_GRACE_MS) return lockedOut(undefined); // racer mid-write
    // Stale (dead / recycled / inherited pid, or long-unreadable): remove it,
    // retry once.
    if (staleTries++ > 0) break;
    if (!removeStaleLock(h)) return lockedOut(readHolder(LOCK_FILE).rec?.pid);
  }
  // Retried and still can't create it — don't claim ownership.
  return lockedOut(readHolder(LOCK_FILE).rec?.pid);
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
