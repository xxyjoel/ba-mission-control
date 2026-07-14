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

// Mirror sessionFileTailer.mjs intervals (0179 pattern).
const CREATION_POLL_MS = 500;  // poll until file appears, then switch to fs.watch
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
export function startStatusHookTailer({ agent }) {
  const filePath = statusFilePath({ sessionId: agent.sessionId });
  const core = createReadCore(filePath);

  let stopped = false;
  let watcher = null;
  let creationPollTimer = null;
  let statPollTimer = null;
  let readingLock = false;

  async function doRead() {
    if (stopped || readingLock) return;
    readingLock = true;
    try {
      const events = await core.readNew();
      for (const ev of events) {
        const s = mapEventToStatus(ev);
        if (s != null) {
          const changed = agent.hookStatus !== s;
          agent.hookStatus = s;
          agent.hookStatusTs = Date.now();
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
    creationPollTimer = setInterval(() => {
      if (stopped) return;
      if (attachWatcher()) {
        clearInterval(creationPollTimer);
        creationPollTimer = null;
        doRead();
      }
    }, CREATION_POLL_MS);
  }

  // Stat-poll backstop: fs.watch silently never fires on many cloud-synced
  // paths (sync daemon writes via temp+rename). Poll doRead() on a modest
  // interval; it early-returns cheaply when nothing grew.
  statPollTimer = setInterval(() => {
    if (stopped) return;
    doRead();
  }, STAT_POLL_MS);

  return {
    stop() {
      if (stopped) return; // idempotent
      stopped = true;
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
 *   { ts: number, session_id: string, event: string, notification_type?: string }
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

  if (event === 'Notification') {
    if (notification_type === 'permission_prompt') return 'waiting';
    if (notification_type === 'idle_prompt') return 'idle';
    return null;
  }

  if (event === 'Stop') return 'idle';

  return null;
}
