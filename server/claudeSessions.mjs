// server/claudeSessions.mjs — ask claude which sessions exist.
//
// Mission Control used to work out which session a slot was showing by listing
// transcript files and picking the newest one. That is guesswork, and it was
// wrong in three visible ways (measured 2026-09-19):
//
//   • A card showed a session that had stopped being written at 02:28, and so
//     showed its model, while the live conversation ran under a different id.
//   • Six sessions were running in claude's own background daemon and appeared
//     nowhere in the fleet view. Some had been waiting for input for 19 days.
//   • A slot burned its three restart attempts resuming a session that claude
//     already had open in the background, then marked itself errored, while the
//     conversation was alive the whole time.
//
// claude publishes the answer. `claude agents --json` lists every session it
// knows about, each tagged `interactive` (attached to a terminal) or
// `background` (hosted by claude's daemon). This module is the one place that
// reads it.
//
// SECURITY: CLAUDE_BIN is user-controlled, so it is only ever argv[0] of an
// execFile — never part of a shell string. Same rule as server/ptyAgent.mjs.

import { execFile } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Listing spawns a process, so a render must never trigger one. Readers get the
// last good answer; a refresh runs on a timer the caller owns.
const CACHE_MS = 5000;
const LIST_TIMEOUT_MS = 5000;

let cache = { at: 0, value: null, inFlight: null };

// parseAgentsJson — turn the command's output into the two groups the UI needs.
// Exported so the shape can be tested against a recorded copy of real output
// without spawning anything.
//
// Returns null when the output cannot be trusted. null means UNKNOWN, and every
// caller must render it as unknown — never as an empty list, which would claim
// "no background sessions" when we simply could not look.
export function parseAgentsJson(raw) {
  let rows;
  try { rows = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(rows)) return null;

  const attached = [];
  const background = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : null;
    if (!sessionId) continue;
    const entry = {
      sessionId,
      // `id` is the short form claude shows the user; it is absent on some rows.
      shortId: typeof r.id === 'string' ? r.id : sessionId.slice(0, 8),
      cwd: typeof r.cwd === 'string' ? r.cwd : null,
      name: typeof r.name === 'string' ? r.name : null,
      // Two different fields carry liveness depending on the row: `status` on an
      // attached session, `state` on a background one. Keep both rather than
      // flattening, so a caller can tell "idle" from "blocked".
      status: typeof r.status === 'string' ? r.status : null,
      state: typeof r.state === 'string' ? r.state : null,
      pid: Number.isInteger(r.pid) ? r.pid : null,
      startedAt: Number.isFinite(r.startedAt) ? r.startedAt : null,
    };
    if (r.kind === 'background') background.push(entry);
    else if (r.kind === 'interactive') attached.push(entry);
  }
  return { attached, background };
}

// listClaudeSessions — run the command once and cache the result. Never throws;
// resolves null when the list could not be read.
export async function listClaudeSessions({
  claudeBin = CLAUDE_BIN,
  timeoutMs = LIST_TIMEOUT_MS,
  now = Date.now(),
  cacheMs = CACHE_MS,
} = {}) {
  if (cache.value && now - cache.at < cacheMs) return cache.value;
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      cache.inFlight = null;
      // Only a GOOD read advances the clock. A failed read leaves the previous
      // answer in place rather than replacing it with a confident-looking
      // empty one, and retries on the next call.
      if (value) { cache = { at: Date.now(), value, inFlight: null }; }
      resolve(value);
    };
    try {
      const child = execFile(
        claudeBin,
        ['agents', '--json'],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => finish(err ? null : parseAgentsJson(String(stdout))),
      );
      // Never hold mc's exit open on an opportunistic listing.
      child?.unref?.();
    } catch { finish(null); }
  });
  return cache.inFlight;
}

// backgroundSessionCount — the number the fleet view shows. null = unknown.
export function backgroundSessionCount(list) {
  return list ? list.background.length : null;
}

// findSession — is this session id one claude currently holds, and how?
// Used when a resume fails: a session claude has open in the BACKGROUND cannot
// be resumed into a slot, and retrying it three times just errors the slot.
export function findSession(list, sessionId) {
  if (!list || !sessionId) return null;
  for (const e of list.background) if (e.sessionId === sessionId) return { ...e, kind: 'background' };
  for (const e of list.attached) if (e.sessionId === sessionId) return { ...e, kind: 'interactive' };
  return null;
}

// staleBackgroundSessions — background sessions that have been blocked longer
// than `days`. These are the ones the user called orphans: nobody is going to
// answer them, and each one holds a claude process open. Measured on this
// machine: six background sessions, the oldest blocked for 9.8 days, together
// holding 1875 MB across 13 processes.
export function staleBackgroundSessions(list, { days = 1, now = Date.now() } = {}) {
  if (!list) return null;                       // unknown, not "none"
  const cutoff = days * 86400000;
  return list.background.filter((e) => (
    e.state !== 'working' && Number.isFinite(e.startedAt) && now - e.startedAt > cutoff
  ));
}

// removeSession — delete one background session with `claude agents rm <id>`.
// This DELETES A CONVERSATION, so no caller may invoke it without the user
// having confirmed that specific id. Argv form only; the id is validated here
// as a last line of defence even though the caller picked it from our own list.
export async function removeSession(sessionId, { claudeBin = CLAUDE_BIN, timeoutMs = 15_000 } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{8,36}$/i.test(sessionId)) {
    return { ok: false, error: 'refusing to remove a session id of an unexpected shape' };
  }
  return new Promise((resolve) => {
    try {
      execFile(claudeBin, ['agents', 'rm', sessionId], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err.message).slice(0, 200) });
        cache = { at: 0, value: null, inFlight: null };   // the list just changed
        resolve({ ok: true, output: String(stdout).slice(0, 200) });
      });
    } catch (e) { resolve({ ok: false, error: e?.message || 'spawn failed' }); }
  });
}

// Test seam: drop the cache so a test never sees another test's answer.
export function _resetSessionCache() { cache = { at: 0, value: null, inFlight: null }; }
