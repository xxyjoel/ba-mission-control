// server/statusHookTailer.mjs
//
// Decision core for the status-hook feed.  This module will grow:
//   0262 — read-core (parse NDJSON file tail)  ← implemented here
//   0263 — watcher (fs.watch integration)       ← implemented here
//   0222 — assemble into Fleet/Agent status updates ← implemented here
//
// For task 0220 mapEventToStatus was implemented; 0262 adds createReadCore.
// 0263 + 0222 add startStatusHookTailer (watch lifecycle + agent mutation).

import { promises as fsp, watch as fsWatch } from 'node:fs';
import { statusFilePath } from './statusFile.mjs';
import { creationPollDelay } from './sessionFileTailer.mjs';
import { knownClaudeMode } from './permissionModes.mjs';

// Mirror sessionFileTailer.mjs intervals (0179 pattern).
const STAT_POLL_MS = 1500;     // backstop for cloud-synced paths where fs.watch never fires

/**
 * startStatusHookTailer({ agent }) — watch the session's NDJSON status file
 * and map each appended hook event to agent.hookStatus.
 *
 * Mirrors sessionFileTailer.mjs's watch + creation-poll + stat-poll backstop
 * pattern so it works on cloud-synced (GoogleDrive/CloudStorage) paths.
 *
 * Returns { stop() } — stop() is idempotent (safe to call twice).
 *
 */
// drive: 'self' (default) owns its 1500ms backstop interval; 'external' creates
// no timer — the caller (Fleet's single tailer driver, 0381) invokes tick().
export function startStatusHookTailer({ agent, drive = 'self' }) {
  let filePath = statusFilePath({ sessionId: agent.sessionId });
  let core = createReadCore(filePath);
  let lastSid = agent.sessionId;

  // 0439: a rebuilt tailer replays the hook file from offset 0. A mode in a
  // record OLDER than the argv mc last spawned claude with is history — after
  // changePermissionMode restarts claude with `--permission-mode NEW`, the old
  // records must not put the old mode back. ptyAgent stamps the spawn; an
  // unstamped agent falls back to this tailer's start.
  const modeFloorFallback = Date.now();

  let stopped = false;
  let watcher = null;
  let creationPollTimer = null;
  let awaitingCreate = false; // 0465: drive:'external' — tick() runs the creation check
  let statPollTimer = null;
  let readingLock = false;

  // 0408-F3: the hook-file path used to be pinned at start. After a /clear
  // rotation or a claude-minted sid the session tailer reassigns
  // agent.sessionId, and every hook event (permission prompts, PostToolUse,
  // sub-agent liveness) then landed in a file nobody read. Re-resolve the sid
  // on every read pass — the same shape subagentUsageTailer uses per scan —
  // and rebuild the read core + watcher when it changed. The stat-poll /
  // tick() backstop keeps reading even when the new file doesn't exist yet
  // (createReadCore.readNew returns [] on ENOENT).
  function maybeRepoint() {
    const sid = agent.sessionId;
    if (sid === lastSid) return;
    let nextPath;
    try { nextPath = statusFilePath({ sessionId: sid }); } catch { return; } // garbage sid — keep the old feed
    lastSid = sid;
    filePath = nextPath;
    core = createReadCore(filePath);
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    // TODO(0465): under drive:'self' a pending pollCreate is not cancelled here;
    // if this attach succeeds, that timer's later attachWatcher() overwrites
    // `watcher` and this one is never closed (pre-existing; external drive is
    // safe — tick() attaches only while !watcher).
    attachWatcher(); // failure is fine — the stat-poll backstop covers creation
  }

  async function doRead() {
    if (stopped || readingLock) return;
    readingLock = true;
    try {
      maybeRepoint();
      const events = await core.readNew();
      if (stopped) return;
      for (const ev of events) {
        // 0395: a SUBAGENT's tool events (record.sub, from agent_id in the
        // hook payload) say nothing about the MAIN thread's state — a
        // background agent hammering Bash/Edit must not overwrite 'waiting'
        // while the main thread sits on a permission box (focus-duck,
        // 2026-08-29). Notifications/Stop still flow: a subagent tool's
        // permission prompt surfaces in the main UI and genuinely blocks.
        if (ev?.sub && (ev.event === 'PreToolUse' || ev.event === 'PostToolUse')) {
          // 0398: invisible to hookStatus, but NOT to liveness — background
          // Agent launches return their tool_result instantly and the main
          // thread then Stops, so these events are the ONLY evidence that
          // background agents are still working. toJSON keeps an idle card
          // on 'working' while this clock is fresh (focus-duck read IDLE
          // with three builders running, 2026-08-30).
          // 0449: the record's own time, never the read time — a replay from
          // offset 0 must not make a 14 h old sub event look live. max() so an
          // older record (repointed file) can't move the clock backwards.
          agent.lastSubHookTs = Math.max(agent.lastSubHookTs || 0, eventTs(ev));
          continue;
        }
        // 0439: claude reports its permission mode on the hook payload, so a
        // Shift+Tab inside claude (zoom) moves mc's record — the zoom chip, the
        // saved session and the mode a resume restarts in. Read here, before
        // the 0390 / P3 branches (P3 `continue`s). Subagent records are skipped
        // above: a subagent's mode says nothing about the main thread's.
        applyHookPermissionMode(agent, ev, modeFloorFallback);
        // 0390: PostToolUse for a human-blocking tool = the ask was ANSWERED —
        // protocol truth from claude itself, the only channel that reports it
        // explicitly. Clear the pending prompt so a resolved ask can never pin
        // the card on INPUT? (stale-prompt inverse of 0384).
        if (ev?.event === 'PostToolUse'
          && (ev.tool_name === 'AskUserQuestion' || ev.tool_name === 'ExitPlanMode')
          && agent.awaitingPrompt) {
          agent.awaitingPrompt = null;
          agent.emit?.('change');
        }
        // 0408-P3: a MAIN-THREAD PostToolUse while hookStatus==='waiting' means
        // the permission prompt was ANSWERED and the approved tool already ran —
        // yet nothing status-bearing fires until the next PreToolUse or Stop, so
        // the card sat on NEEDS INPUT while claude streamed (median 15.1s, p90
        // 41.6s over 368 recorded prompts). Resolve it to 'working' here.
        // PostToolUse stays NULL-MAPPING for every other prior state (0223-AC3
        // contract, enforced in mapEventToStatus) — this branch only lifts a
        // stale 'waiting'. Sub-tagged PostToolUse never reaches here (0395 gate
        // above).
        if (ev?.event === 'PostToolUse' && agent.hookStatus === 'waiting') {
          agent.hookStatus = 'working';
          agent.hookStatusTs = eventTs(ev); // 0449
          agent.emit?.('change');
          continue;
        }
        const s = mapEventToStatus(ev);
        if (s != null) {
          const changed = agent.hookStatus !== s;
          agent.hookStatus = s;
          // 0449: working/waiting stamp the EVENT time (clamped to now).
          // Replay from offset 0 used to stamp read time, so a 14 h old
          // PreToolUse looked 0.3 s old. IDLE keeps the read time on purpose:
          // its only reader is deriveStatus's hook-idle branch, which compares
          // it with lastConnectorTs — and that clock (jsonlConnector.mjs:238)
          // is the time mc READ the transcript line. Stamping a Stop with its
          // own ts let any transcript record read after the Stop beat it (up to
          // 1.5 s of stat-poll on cloud paths), turning a finished turn into
          // WAITING/WORKING. Both sides of that comparison must share a clock.
          // TODO(0449): move lastConnectorTs to the record's own time too, then
          // drop this idle exception (jsonlConnector is another lane's file).
          agent.hookStatusTs = s === 'idle' ? Date.now() : eventTs(ev);
          if (changed) agent.emit?.('change');
        }
        // null-mapping events leave hookStatus/hookStatusTs unchanged and do not emit
      }
    } finally {
      readingLock = false;
    }
  }

  function attachWatcher() {
    try {
      watcher = fsWatch(filePath, { persistent: false }, () => doRead());
      return true;
    } catch {
      return false;
    }
  }

  // Try to attach immediately; if file doesn't exist yet, poll for creation.
  if (attachWatcher()) {
    // File exists — kick an initial read in case something was appended
    // between our stat and the watch attachment.
    doRead();
  } else {
    // Creation poll with backoff: the status NDJSON only appears on the first
    // hook event, so an unprompted slot would otherwise poll 2×/s forever.
    // Fast for ~10s, then 2s (creationPollDelay — shared with sessionFileTailer).
    // 0465: under drive:'external' the Fleet tick runs the check instead — no
    // per-slot timer (was 2 per never-prompted slot, 20 at 10).
    if (drive === 'external') {
      awaitingCreate = true;
    } else {
      let creationAttempts = 0;
      const pollCreate = () => {
        if (stopped) return;
        if (attachWatcher()) {
          creationPollTimer = null;
          doRead();
          return;
        }
        creationPollTimer = setTimeout(pollCreate, creationPollDelay(++creationAttempts));
      };
      creationPollTimer = setTimeout(pollCreate, creationPollDelay(0));
    }
  }

  // Stat-poll backstop: fs.watch silently never fires on many cloud-synced
  // paths (sync daemon writes via temp+rename). Poll doRead() on a modest
  // interval; it early-returns cheaply when nothing grew.
  if (drive !== 'external') {
    statPollTimer = setInterval(() => {
      if (stopped) return;
      doRead();
    }, STAT_POLL_MS);
  }

  return {
    // 0381: one externally-driven backstop pass (drive: 'external').
    tick() {
      if (stopped) return;
      // 0465: the creation check, folded into the shared tick. A failed attach
      // still reads: doRead() returns [] on ENOENT and repoints a rotated sid.
      if (awaitingCreate && !watcher && attachWatcher()) awaitingCreate = false;
      doRead();
    },
    stop() {
      if (stopped) return; // idempotent
      stopped = true;
      awaitingCreate = false;
      if (watcher) {
        try { watcher.close(); } catch {}
        watcher = null;
      }
      if (creationPollTimer) {
        clearInterval(creationPollTimer);
        creationPollTimer = null;
      }
      if (statPollTimer) {
        clearInterval(statPollTimer);
        statPollTimer = null;
      }
    },
  };
}

// eventTs(ev) — 0449. The record's own ms timestamp (emit-status.mjs writes
// Date.now() at hook time), clamped to now so a skewed or hand-edited future
// ts can't pin freshness. The file is untrusted: anything but a finite number
// of MILLISECONDS (no coercion of true/"5"/[7]; a seconds value like 1.7e9 is
// below MIN_EVENT_TS_MS) falls back to now. Date.now() is read per call so
// tests that mock the clock (status.replay) keep working.
const MIN_EVENT_TS_MS = 1e12; // 2001-09-09 in ms; any seconds-based ts is far below
export function eventTs(ev) {
  const now = Date.now();
  const ts = ev?.ts;
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= MIN_EVENT_TS_MS
    ? Math.min(ts, now) : now;
}

// applyHookPermissionMode — 0439. Set agent.permissionMode from a hook record's
// `permission_mode` when it is a known claude mode (the file is untrusted) and
// the record is not older than the argv claude was last spawned with, and the
// record is not a subagent's. Emits
// 'change' only when the value moves.
function applyHookPermissionMode(agent, ev, floorFallback) {
  if (ev?.sub) return false; // a subagent's mode says nothing about the main thread's
  const mode = knownClaudeMode(ev?.permission_mode);
  if (!mode || mode === agent.permissionMode) return false;
  const floor = Number.isFinite(agent.permissionModeArgvTs) ? agent.permissionModeArgvTs : floorFallback;
  if (!(Number(ev.ts) >= floor)) return false;
  agent.permissionMode = mode;
  agent.emit?.('change');
  return true;
}

/**
 * createReadCore(filePath) — factory for a stateful NDJSON byte tailer.
 *
 * Returns { readNew(): Promise<object[]> }
 *
 * readNew() reads [currentOffset, fileSize) from filePath, prepends any
 * buffered trailing partial line, splits on '\n', buffers the last element
 * if it has no trailing newline, JSON.parses each complete non-empty line
 * (silently skipping malformed/blank lines), advances the internal offset,
 * and returns the array of parsed event objects in order.
 *
 * Returns [] when the file doesn't exist yet or nothing new has been written.
 * Resets offset to 0 if the file shrinks (truncation / replacement).
 *
 * No agent mutation — pure file → parsed events. Lifecycle (fs.watch) is
 * added by task 0263.
 */
export function createReadCore(filePath) {
  let offset = 0;
  let partial = ''; // trailing bytes not yet terminated by '\n'

  return {
    async readNew() {
      let stats;
      try {
        stats = await fsp.stat(filePath);
      } catch {
        return []; // file doesn't exist yet
      }

      // Defensive truncation reset
      if (stats.size < offset) {
        offset = 0;
        partial = '';
      }

      if (stats.size <= offset) return []; // nothing new

      const len = stats.size - offset;
      const buf = Buffer.alloc(len);
      const fh = await fsp.open(filePath, 'r');
      try {
        await fh.read(buf, 0, len, offset);
      } finally {
        await fh.close();
      }
      offset = stats.size;

      const text = partial + buf.toString('utf8');
      const lines = text.split('\n');
      // Last element: either '' (text ended with \n) or a partial line
      partial = lines.pop(); // store trailing partial (may be '')

      const events = [];
      for (const line of lines) {
        if (!line.trim()) continue; // skip blank lines
        try {
          events.push(JSON.parse(line));
        } catch {
          // silently skip malformed lines
        }
      }
      return events;
    },
  };
}

/**
 * mapEventToStatus(ev) — pure function, no I/O, no timers.
 *
 * Maps one parsed NDJSON hook record to a status string or null.
 * Record shape (from server/hooks/emit-status.mjs):
 *   { ts: number, session_id: string, event: string, notification_type?: string,
 *     tool_name?: string, sub?: true, permission_mode?: string }
 *
 * @param {unknown} ev — the parsed record (or any garbage)
 * @returns {'working'|'waiting'|'idle'|null}
 */
export function mapEventToStatus(ev) {
  if (ev == null || typeof ev !== 'object') return null;

  const { event, notification_type } = ev;

  // A turn has begun. Bridges the gap before the first PreToolUse (or before the
  // JSONL connector sees a streamed event) so a thinking/text-only turn doesn't
  // read 'idle'. Stop resets it to idle at turn end.
  if (event === 'UserPromptSubmit') return 'working';

  if (event === 'PreToolUse') return 'working';

  // PostToolUse stays NULL-mapping by contract (0223-AC3): hookStatus/Ts move
  // only on status-BEARING events. Its 0390 role — clearing a pending ask the
  // moment the answer lands — happens in doRead() before this mapping runs.

  if (event === 'Notification') {
    if (notification_type === 'permission_prompt') return 'waiting';
    // TODO(0363): agent_needs_input is deliberately unmapped (0451). Real hook
    // logs show it after Stop + idle_prompt (5b7a6c0d:20-22, 93c118d4:12523-31),
    // paired same-ms with agent_completed (df4c967a:655, add052b8:11610), and
    // just before a main-thread PreToolUse (add052b8:12495). Mapping it to
    // 'waiting' left idle cards WAITING with no expiry, and bgStatusFromEvents
    // shares this mapper. Unresolved, possibly real blocks: aae20e51:8094-8098,
    // fcefd2e4:3746-3749. Settle its meaning in 0363 before mapping it.
    if (notification_type === 'idle_prompt') return 'idle';
    return null;
  }

  if (event === 'Stop') return 'idle';

  return null;
}
