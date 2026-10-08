// tui/lib/pausedPids.js — 0443: paused sessions must not outlive an mc crash.
//
// A paused slot is SIGSTOPped. If mc dies hard (SIGKILL, OOM) while a slot is
// paused, the stopped claude is reparented to pid 1 and stays in state T for
// good: claude leads its own session, so its group was orphaned from the start
// and the kernel never sends the orphaned-group SIGHUP+SIGCONT. Measured in the
// 2026-10-08 review (finding 4): a stopped child that handles SIGHUP stayed
// `TNs+` under pid 1 after its parent was SIGKILLed.
//
// So mc saves {pid, startTime} of every paused slot next to sessions.json, and
// the next boot ends any saved pid that is still stopped and now belongs to
// pid 1. The start time guards against pid reuse: a pid whose start time does
// not match the record is never signalled.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfigDir } from './configDir.js';
import { isReadOnlyMode } from './instanceLock.js';

export const PAUSED_FILE = join(getConfigDir(), 'paused-pids.json');
const TMP_FILE = PAUSED_FILE + '.tmp';

// One `ps` row for `pid`, argv form: {ppid, pgid, stat, startTime} or null
// when the pid is gone or ps fails. LC_ALL=C keeps lstart in one format, so a
// locale change between the run that records and the run that reaps cannot
// make every record mismatch. Whitespace is collapsed for the same reason.
export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,pgid=,stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = out.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return null;
    return { ppid: Number(m[1]), pgid: Number(m[2]), stat: m[3], startTime: m[4].replace(/\s+/g, ' ').trim() };
  } catch { return null; }
}

export function loadPaused() {
  try {
    if (!existsSync(PAUSED_FILE)) return [];
    const j = JSON.parse(readFileSync(PAUSED_FILE, 'utf8'));
    return Array.isArray(j?.paused)
      ? j.paused.filter((r) => Number.isInteger(r?.pid) && r.pid > 1 && typeof r.startTime === 'string' && r.startTime)
      : [];
  } catch { return []; }
}

// Atomic write (tmp + rename), same shape as sessionStore's persist. Honours
// read-only mode: a second instance must not touch this file either.
function persist(list) {
  if (isReadOnlyMode()) return;
  try {
    mkdirSync(dirname(PAUSED_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(TMP_FILE, JSON.stringify({ version: 1, paused: list }, null, 2), { mode: 0o600 });
    renameSync(TMP_FILE, PAUSED_FILE);
  } catch {
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}
  }
}

// Record one paused pid. A pid whose start time cannot be read is not
// recorded: the boot reaper could never verify it, so it would never act.
export function recordPaused(pid, { info = processInfo } = {}) {
  const row = info(pid);
  if (!row?.startTime) return false;
  const list = loadPaused().filter((r) => r.pid !== pid);
  list.push({ pid, startTime: row.startTime });
  persist(list);
  return true;
}

// Remove one pid (resume / kill / the slot is gone).
export function clearPaused(pid) {
  const list = loadPaused();
  const next = list.filter((r) => r.pid !== pid);
  if (next.length !== list.length) persist(next);
}

// Fleet-change watcher for tui/main.jsx: diff the set of paused slot pids
// against the last set and record / clear only what moved. 'change' fires on
// every transcript line, so the no-change path is a Set build and compare.
// PTY slots hold the process at a.pty.pid, stream-json Agent at a.proc.pid.
// Slots with no integer pid (mock, cursor) are skipped.
// 0443: read the agent's `paused` flag, never `status === 'paused'`. The JSONL
// tailer (jsonlConnector), markUserSubmitted and the send paths rewrite
// `status` while the process stays SIGSTOPped; keying on status cleared the
// record of a still-frozen process. PtyCore and Agent set `paused` only in
// pause() and clear it on resume / kill / respawn / exit.
export function pausedPidsOf(agents) {
  const s = new Set();
  for (const a of agents || []) {
    if (a?.paused !== true) continue;
    const pid = a.pty?.pid ?? a.proc?.pid;
    if (Number.isInteger(pid) && pid > 1) s.add(pid);
  }
  return s;
}

export function createPausedWatcher({ record = recordPaused, clear = clearPaused } = {}) {
  let last = new Set();
  return function onFleetChange(agents) {
    const now = pausedPidsOf(agents);
    if (now.size === last.size && [...now].every((p) => last.has(p))) return;
    for (const p of last) if (!now.has(p)) { try { clear(p); } catch {} }
    for (const p of now) if (!last.has(p)) { try { record(p); } catch {} }
    last = now;
  };
}

// Boot reaper. Run once, after the instance lock is acquired (ok:true only)
// and before any slot is launched or auto-resumed. A recorded pid is signalled
// only when ALL hold: alive, start time equals the record, ppid is 1, state T
// (task 0443 acceptance). An orphan that is no longer T (SIGCONTed by hand) is
// kept on record but not signalled.
// Then SIGCONT (a stopped process never handles SIGTERM) and SIGTERM, to its
// group when it leads one (claude under node-pty: pgid == pid), else to the
// pid alone (a stream-json child shares mc's group — never signal that).
// 0443: a claude wedged on a permission prompt ignores SIGTERM (see
// fleet.hardKillAll), so after `graceMs` any target still alive with the same
// start time gets SIGKILL, and the reaper waits for it to go. Auto-resume runs
// after this, and must not resume a session the old claude still holds.
// Records dropped: dead, start time changed (pid reused), reaped. Kept: alive,
// same start time, not orphaned — another live mc (MC_ALLOW_MULTI) may own it.
// `info`, `kill`, `sleep` and `graceMs` are injectable for tests.
// 0443: TODO(paused-descendants): claude's Bash-tool shells call setsid, so
// pause's tree walk stopped them in their own groups; SIGTERM to claude's
// group does not reach them and they can stay T under pid 1 too. Record the
// stopped tree at pause time (or walk it here) to end those as well.
export async function reapOrphanedPaused({
  info = processInfo,
  kill = process.kill.bind(process),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  graceMs = 1500,
  stepMs = 50,
} = {}) {
  const reaped = [];
  const killed = [];
  const skipped = [];
  const keep = [];
  const targets = [];
  const recs = loadPaused();
  const send = (rec, target, sig) => {
    try { kill(target, sig); } catch {
      // The group may be gone while the leader lingers; fall back to the pid.
      if (target !== rec.pid) { try { kill(rec.pid, sig); } catch {} }
    }
  };
  // Still the same process (alive, not a zombie, same start time)? Never
  // signal otherwise.
  const same = (rec) => {
    const r = info(rec.pid);
    return !!r && !/^Z/.test(r.stat || '') && r.startTime === rec.startTime;
  };
  for (const rec of recs) {
    const row = info(rec.pid);
    if (!row) { skipped.push({ pid: rec.pid, why: 'gone' }); continue; }
    if (row.startTime !== rec.startTime) { skipped.push({ pid: rec.pid, why: 'start-time' }); continue; }
    if (row.ppid !== 1 || !/^T/.test(row.stat || '')) {
      skipped.push({ pid: rec.pid, why: 'not-orphaned-stopped' });
      keep.push(rec);
      continue;
    }
    const target = row.pgid === rec.pid ? -rec.pid : rec.pid;
    send(rec, target, 'SIGCONT');
    send(rec, target, 'SIGTERM');
    targets.push({ rec, target });
    reaped.push(rec.pid);
  }
  // Grace, then SIGKILL whatever ignored SIGTERM, then wait for it to go.
  let live = targets;
  for (let waited = 0; live.length && waited < graceMs; waited += stepMs) {
    await sleep(stepMs);
    live = live.filter(({ rec }) => same(rec));
  }
  for (const { rec, target } of live) {
    if (!same(rec)) continue;
    send(rec, target, 'SIGKILL');
    killed.push(rec.pid);
  }
  for (let waited = 0; live.length && waited < graceMs; waited += stepMs) {
    live = live.filter(({ rec }) => same(rec));
    if (live.length) await sleep(stepMs);
  }
  // Not expected (SIGKILL cannot be caught), but keep the record so the next
  // boot tries again rather than forgetting a live orphan.
  for (const { rec } of live) { skipped.push({ pid: rec.pid, why: 'survived-sigkill' }); keep.push(rec); }
  if (keep.length !== recs.length) persist(keep);
  return { reaped, killed, skipped };
}
