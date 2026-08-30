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
// holder and boots read-only for the session store (it still runs — killing
// the UX for a sandbox/test launch would be worse — but it cannot corrupt
// the shared store). MC_ALLOW_MULTI=1 skips the check entirely for users
// who know what they're doing. A dead holder's lock is stale and replaced.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from './configDir.js';

export const LOCK_FILE = configPath('mc.lock');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  // EPERM = the process exists but belongs to someone we can't signal —
  // that's ALIVE. Only ESRCH (no such process) means the lock is stale.
  catch (e) { return e?.code === 'EPERM'; }
}

/**
 * acquireInstanceLock() → { ok: true } | { ok: false, holderPid }
 * ok:false means another live mc owns this config dir — the caller should
 * mark the session store read-only and surface a warning.
 */
export function acquireInstanceLock() {
  if (process.env.MC_ALLOW_MULTI === '1') return { ok: true };
  try {
    const prev = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (prev?.pid !== process.pid && pidAlive(prev?.pid)) {
      return { ok: false, holderPid: prev.pid };
    }
  } catch { /* no lock or unreadable → treat as free */ }
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
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
