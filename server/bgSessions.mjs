// server/bgSessions.mjs — recognise a claude BACKGROUND FORK and read its status.
//
// 0403: claude can fork a conversation into the background under a NEW session
// id. MC pins its status tailer to the sid it launched, so the card read IDLE
// forever while a fleet of background agents worked. Measured 2026-09-16
// 10:00:55 on slot [12] labor-market-app: df4c967a (MC's sid) last fired a hook
// event on Sep 10; fork 93c118d4 was firing every few seconds. The settled
// decision is NOT to follow the fork — the parent's own status stays the card's
// primary status and the forks are summarised beside it ("IDLE · 2bg WORKING").
//
// FAIL-OPEN RULE — read this before changing any return value. One classifier
// serves two callers whose safe directions are OPPOSITE: rotation
// (sessionFileTailer.findRotatedSession) must ALLOW on doubt or 0187's /clear
// rotation and zoomSession's minted-sid path break, while the bg scan must
// DECLINE on doubt or it counts noise. One rule serves both: return 'normal' on
// any read failure or ambiguity. Rotation permits 'normal', the scan requires
// 'bg', so both degrade to today's behaviour together. There is no 'unknown'
// state — do not add one.

import { promises as fsp } from 'node:fs';
import { mapEventToStatus } from './statusHookTailer.mjs';
// No import from sessionFileTailer.mjs: classifyTranscript takes an ABSOLUTE
// PATH so this module needs no export from it, which is what lets slice 2
// import classifyTranscript back. The module GRAPH still cycles —
// statusHookTailer.mjs imports creationPollDelay from sessionFileTailer — and
// it resolves only because nothing in that cycle runs at module-eval time.
// Keep it that way; tests/bgSessions.test.mjs pins the co-load.

// MEASURED 2026-09-16 over the five real transcripts in
// ~/.claude/projects/…-labor-market-app: a 16 KiB tail discriminates every one
// of them AT REST (forks 31385158 / 93c118d4 carry a bg record 664 / 529 bytes
// from EOF; parents 9eed5575 / a9386068 / df4c967a carry none anywhere).
//
// But bg records are NOT evenly spread. Same measurement: 42 gaps wider than
// 16 KiB on 31385158 (widest 919_224 bytes) and 22 on 93c118d4. A tail read
// SAMPLED mid-gap therefore returns 'normal' for a genuine fork. That is a
// property of the data, not a bug to tune away with a bigger budget — 919 KiB
// of tail per sample is not affordable. It is instead the whole reason a
// negative verdict below must stay provisional FOREVER (see classifyTranscript).
export const KIND_TAIL_BYTES = 16 * 1024;
export const STATUS_TAIL_BYTES = 4 * 1024;
// A fork whose last status-bearing hook event is older than this reads idle.
// Without it a 'working' mapping from an hour ago pins the chip forever — the
// exact failure 0394/0399 kept producing on the main card.
export const BG_STALE_MS = 10 * 60_000;
export const BG_SUB_ACTIVE_MS = 60_000;
// TODO(bg-sub-window): deliberately NOT ptyAgent's SUB_ACTIVE_MS (15s, 0398).
// That clock is EVENT-driven (written on every hook event, read at render);
// this one is SAMPLED every ~6-12s, so a 15s window is ~1.25 sample periods
// wide and the count would flicker 2<->1 with a change-emit per flip.
const KIND_CACHE_MAX = 512;

// sid -> { kind, size }. Module-level so a respawn doesn't re-read and two
// slots pointed at one repo share the verdict. `size` is the file size the
// verdict was computed from, so a negative is re-tested whenever the file
// changes. There is deliberately NO attempt cap — see classifyTranscript.
const kindCache = new Map();

/** Test-only: drop every cached verdict. */
export function _resetKindCache() { kindCache.clear(); }

/**
 * classifyTail(tailText) — pure. tailText is utf8 of the last KIND_TAIL_BYTES
 * of a transcript. Returns 'bg' if ANY parsed record carries a top-level
 * sessionKind:'bg', else 'normal'.
 *
 * ANY, not the last: the real 16 KiB tail of fork 93c118d4 is two bg-tagged
 * `attachment` records followed by five undefined-kind ones (last-prompt,
 * ai-title, agent-name, mode, permission-mode). A "check the last record"
 * shortcut calls that fork NORMAL and reopens 0403.
 *
 * Substring matching is FORBIDDEN — the literal `"sessionKind":"bg"` can sit
 * inside the quoted content of a perfectly normal transcript (this repo's own
 * sessions contain it), and a false positive makes slice 2 refuse a legitimate
 * rotation. Parse, then read the field.
 *
 * partialFirstLine defaults true because a byte-offset tail always starts
 * mid-record; classifyTranscript passes false when it read the whole file, so
 * a transcript smaller than the tail budget doesn't silently lose record 0.
 */
export function classifyTail(tailText, { partialFirstLine = true } = {}) {
  const lines = String(tailText ?? '').split('\n');
  if (partialFirstLine) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // malformed → skip silently
    if (r && typeof r === 'object' && r.sessionKind === 'bg') return 'bg';
  }
  return 'normal';
}

/**
 * classifyTranscript(jsonlPath, sid) — cached bounded tail read.
 *
 * TAIL, not head: fork 31385158's FIRST bg record sits at byte 161201, past any
 * plausible head budget — and it misses by construction, not by margin, because
 * a fork opens with an inherited non-bg history prefix.
 *
 * A POSITIVE is permanent and free: sessionKind never changes for a sid.
 * A NEGATIVE is provisional forever, re-tested on every size change, with NO
 * attempt cap. Two measured reasons, either alone sufficient:
 *   1. Discovery fires ~1.5s after the fork's jsonl appears, while its tail is
 *      still the inherited non-bg prefix.
 *   2. bg records leave gaps wider than the tail budget (42 of them on
 *      31385158, widest 919 KiB), so ANY given sample can legitimately miss.
 * A capped negative therefore wedges a real fork into permanent invisibility —
 * 0403 again, which is the bug this module exists to fix. The cost of no cap is
 * one bounded read per CHANGED transcript per sample, off the render path.
 */
export async function classifyTranscript(jsonlPath, sid) {
  const hit = kindCache.get(sid);
  if (hit?.kind === 'bg') return 'bg';
  let fh;
  try {
    // Open FIRST, then fstat that same descriptor, then read it. Sizing from a
    // separate fsp.stat() opens a window where the file is rewritten between
    // the two calls, leaving `size - len` past EOF and yielding a short read
    // whose verdict then gets cached — a fork permanently 'normal', i.e. 0403
    // again. Holding one fd removes the race rather than guarding it, so there
    // is no partial-read branch here to leave untested.
    fh = await fsp.open(jsonlPath, 'r');
    const { size } = await fh.stat();
    // Re-test on ANY size change, not just growth: a transcript that is
    // truncated or replaced by a smaller file at the same path must not be
    // pinned to a verdict computed from bytes that are gone.
    if (hit && size === hit.size) return 'normal';
    const len = Math.min(KIND_TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    const kind = classifyTail(buf.toString('utf8', 0, bytesRead), { partialFirstLine: size > len });
    if (kindCache.size >= KIND_CACHE_MAX) kindCache.clear();
    kindCache.set(sid, { kind, size });
    return kind;
  } catch {
    return 'normal'; // fail open — and neither write nor evict, so a throw can't
  } finally {         // lose an existing 'bg' or cache a miss on a not-yet-created file
    try { await fh?.close(); } catch {}
  }
}

/**
 * bgStatusFromEvents(events, nowMs) — pure. events are parsed NDJSON records
 * from one bg sid's OWN status file. Returns 'working' | 'waiting' | 'idle'.
 */
export function bgStatusFromEvents(events, nowMs) {
  let mapped = null;
  let mappedTs = 0;
  let lastSub = 0;
  for (const e of Array.isArray(events) ? events : []) {
    // Mirrors statusHookTailer.mjs:52 — a SUBAGENT's tool events say nothing
    // about the main thread, so they feed the liveness clock ONLY. Letting them
    // reach the mapping would return 'working' off a stale event while
    // bypassing BG_SUB_ACTIVE_MS entirely. Notification/Stop from a sub still flow.
    if (e?.sub && (e.event === 'PreToolUse' || e.event === 'PostToolUse')) {
      if (typeof e.ts === 'number' && e.ts > lastSub) lastSub = e.ts;
      continue;
    }
    // LAST NON-NULL mapping wins, never the last event: PostToolUse is
    // null-mapping by contract (0223-AC3) precisely so it cannot clear
    // 'working'. Same rule doRead() applies when it writes agent.hookStatus.
    const s = mapEventToStatus(e);
    if (s != null) { mapped = s; if (typeof e?.ts === 'number') mappedTs = e.ts; }
  }
  // STALENESS. A mapping older than BG_STALE_MS describes a fork that stopped
  // reporting, not one that is busy or blocked. Measured case: the 2026-09-16
  // screenshot listed forks "awaiting input" for 6 and 16 DAYS — counting those
  // would pin a permanent chip on an idle card, the same lie 0403 set out to
  // remove, only inverted. Applied to 'waiting' as well as 'working': a prompt
  // nobody answered for six days is abandoned, not pending.
  const fresh = mappedTs > 0 && (nowMs - mappedTs) < BG_STALE_MS;
  if (fresh && mapped === 'waiting') return 'waiting';
  if (fresh && mapped === 'working') return 'working';
  // 0398 one level down: a bg fork runs its OWN subagents (measured: 2456
  // sub-tagged PreToolUse on 93c118d4), so its main thread Stops while they
  // work. Without this a busy fork reads idle and vanishes from the chip.
  if (nowMs - lastSub < BG_SUB_ACTIVE_MS) return 'working';
  return 'idle';
}

/**
 * aggregateBg(records) — pure. records are [{ sid, status }]. Returns the
 * { count, status } pair the card chip renders.
 *
 * DECIDED: idle bg agents are NOT counted. 0403 is "the card hid work that is
 * HAPPENING"; a finished fork is not happening, and the card's own IDLE is then
 * correct. This also makes "17bg IDLE" accumulation structurally impossible.
 * (The go-harvest-the-finished-work signal is a separate, deferred feature.)
 */
export function aggregateBg(records) {
  const live = (Array.isArray(records) ? records : [])
    .filter((r) => r?.status === 'working' || r?.status === 'waiting');
  if (!live.length) return { count: 0, status: null };
  // waiting outranks working, matching Card's urgency ranking.
  return { count: live.length, status: live.some((r) => r.status === 'waiting') ? 'waiting' : 'working' };
}
