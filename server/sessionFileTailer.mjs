// server/sessionFileTailer.mjs — tail claude's native session JSONL
// during zoom so the agent's todos + tail stay live.
//
// Why this exists: when the user zooms into an agent we SIGSTOP the
// stream-json sibling and hand the body of the modal to an
// interactive `claude --resume <sid>` PTY child. Both processes write
// to the same on-disk session file
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where encoded-cwd is the absolute cwd with `/` replaced by `-`. The
// sibling is frozen so it never re-parses the events the PTY child
// appends — which is what made OPEN TASKS and the Ctrl+T tools
// summary frozen-at-zoom-entry in v1.
//
// This tailer watches that file via fs.watch + a tracked byte offset,
// parses each new JSON line, and forwards interesting events
// (TodoWrite + tool_use) directly back into the Agent instance:
//   - TodoWrite → agent.todos = [...] (full replace, matches the
//     live stream-json parser's behavior at agent.mjs)
//   - other tool_use → agent.appendTail({kind:'tool', tool, text})
// After each update we emit('change') so the TUI re-renders.
//
// The agent is SIGSTOP'd at the OS level but its JS object is fully
// alive in our Node process — direct mutation is safe.

import { promises as fsp, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseEvent } from './jsonlConnector.mjs';

// claude's project-dir encoding: every character that isn't [a-zA-Z0-9-]
// becomes '-'. That includes '/', '_', '.', '@', spaces, etc. The earlier
// version of this function only replaced '/' — which meant any cwd
// containing underscores (e.g. `agent_profiles` → `agent-profiles`),
// dots (`gmail.com` → `gmail-com`), or spaces silently pointed at a
// directory that doesn't exist. Symptom: zoom always span fresh sessions
// because the existence check failed, and the tailer watched nothing,
// so commands typed in zoom never reached agent.tail / FleetLog.
//
// Examples confirmed against ~/.claude/projects/ on disk:
//   /Users/you/source/git/projects/acme/agent_profiles
//   → -Users-you-source-git-projects-acme-agent-profiles
//   /Users/you/Library/CloudStorage/GoogleDrive-user@example.com/My Drive/...
//   → -Users-you-Library-CloudStorage-GoogleDrive-user-example-com-My-Drive-...
function encodeCwd(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

// claude session ids are canonical UUIDs (randomUUID() at launch, or the
// session_id claude mints and we read back on --resume). Validate the shape
// before path-joining so a tampered/garbage id read off disk can't traverse
// out of ~/.claude/projects/<cwd>/ (e.g. `../../../etc/passwd`). (0181)
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeSessionPath({ cwd, sessionId }) {
  if (typeof sessionId !== 'string' || !UUID_SHAPE.test(sessionId)) {
    throw new Error(`claudeSessionPath: refusing non-UUID sessionId ${JSON.stringify(sessionId)}`);
  }
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

// The directory claude writes session JSONL files into for a given
// cwd. Exported so zoomSession can scan the dir for files claude
// minted under its OWN id when --session-id wasn't strictly honored.
export function claudeProjectDir(cwd) {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

// 0187: find the transcript this slot ROTATED to. claude can mint a fresh
// session file mid-life — a `/clear` starts a new transcript, or `--session-id`
// isn't honored and claude writes under its own id — leaving the pinned file
// dead. The replacement is the newest `*.jsonl` in the same project dir that
// (a) isn't the current sid, (b) is UUID-shaped, (c) was last written more
// recently than `minMtime` (caller passes max(spawnedAt, current-file mtime),
// so we never re-point onto a pre-existing OLD session AND never flip-flop back
// to the file we just left), and (d) isn't a sid CLAIMED by another live slot
// (0188) — without that an idle slot sharing a cwd with an active sibling would
// yank its card onto the sibling's transcript. Mirrors zoomSession's
// mtime-snapshot heuristic. Returns a sid or null.
export async function findRotatedSession(cwd, currentSid, minMtime = 0, excludeSids = []) {
  let entries;
  try { entries = await fsp.readdir(claudeProjectDir(cwd)); } catch { return null; }
  const exclude = excludeSids instanceof Set ? excludeSids : new Set(excludeSids || []);
  let bestSid = null, bestMtime = minMtime || 0;
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -'.jsonl'.length);
    if (sid === currentSid || exclude.has(sid) || !UUID_SHAPE.test(sid)) continue;
    let mt;
    try { mt = (await fsp.stat(join(claudeProjectDir(cwd), f))).mtimeMs; } catch { continue; }
    if (mt > bestMtime) { bestMtime = mt; bestSid = sid; }
  }
  return bestSid;
}

// startSessionTailer — open a watcher on the claude session JSONL
// for the given agent and forward every JSONL event into the
// canonical jsonlConnector.parseEvent(). The connector mutates agent
// state (status, tail, todos, tokens, cost, …). We emit('change')
// when parseEvent reports a change.
//
// Note for callers: the old signature took a `summarizeToolInput`
// callback to dodge a circular import. After the eventShapes.mjs
// extraction (plan task A3), it's a direct import in jsonlConnector
// and the parameter is gone. If you previously passed it, it's
// silently ignored.
//
// Lifecycle:
//   - On start, snapshot the current file size as the initial offset
//     (or 0 if fromStart=true, used when zoomSession.mjs rebuilds the
//     tailer after detecting a claude-minted sid).
//   - fs.watch fires on append; we read [offset, currentSize), split
//     on \n, JSON.parse each line, and dispatch to parseEvent.
//   - The trailing partial line (no \n yet) is buffered until the
//     next append completes it.
//   - If the file doesn't exist yet (claude hasn't written its first
//     turn), we poll until it appears, then switch to fs.watch.
//   - stop() closes the watcher and clears any poll timer.
// 0178: how far back to replay on attach to recover the session's CURRENT
// status. Bounded so we never re-read multi-MB session files; the last events
// (which determine status) are always at the end.
const REPLAY_BYTES = 256 * 1024;
// 0179: stat-poll backstop interval. fs.watch is unreliable on cloud-synced
// (GoogleDrive/CloudStorage) paths, so we also poll for growth this often.
const STAT_POLL_MS = 1500;

export function startSessionTailer({
  agent,
  fromStart = false,
  statPollMs = STAT_POLL_MS,
  // 0187: how many consecutive no-growth stat-polls before we go looking for a
  // rotated transcript. Keeps the (cheap) readdir off the hot path for active
  // sessions; injectable so the rotation path is testable without real waits.
  rotateAfterFrozenPolls = 3,
  // 0188: a getter returning the sessionIds owned by OTHER live slots, so a
  // rotation hunt never re-points onto a sibling slot's transcript. A function
  // (not a snapshot) so it reflects re-points that happen after attach. Default
  // claims nothing — single-slot behaviour is unchanged.
  claimedSids = () => [],
} = {}) {
  if (!agent) throw new Error('sessionTailer: agent is required');
  // 0187: `path` is reassignable — claude can rotate its transcript (a `/clear`
  // mints a fresh session file, or `--session-id` isn't honored and claude
  // writes under its own id). When that happens the pinned file goes dead and
  // we re-point to the live one rather than freezing the card forever.
  let path = claudeSessionPath({ cwd: agent.cwd, sessionId: agent.sessionId });

  let stopped = false;
  let watcher = null;
  let pollTimer = null;
  let statPollTimer = null;       // 0179: cloud-path backstop
  let offset = 0;
  let buffer = '';
  let readingLock = false; // serialize concurrent reads on rapid appends
  // 0187: rotation-detection state. lastSize tracks our file's size between
  // polls; frozenPolls counts consecutive no-growth polls.
  let lastSize = 0;
  let frozenPolls = 0;

  // No status decay timer. jsonlConnector.parseEvent is canonical
  // for status transitions — stop_reason='end_turn' on the final
  // assistant event drops status to 'idle'; system/turn_duration
  // does the same; api_error → 'error'. The previous 6-second decay
  // here flipped the card to 'idle' mid-thinking on any prompt
  // claude couldn't answer within 6s, which is most non-trivial
  // prompts. Wedge detection (claude PTY alive but truly stuck) is
  // covered by toJSON()'s `stuckMin` — a 5-minute silence threshold
  // that renders a red STUCK chip on the card.

  function handleEvent(ev) {
    const changed = parseEvent(ev, agent);
    if (changed) {
      try { agent.emit('change'); } catch {}
    }
  }

  // 0178: derive the session's CURRENT status from a bounded tail of the JSONL
  // on attach. Without this the tailer started at EOF and only ever saw FUTURE
  // events, so a session quiescent when mc connected (e.g. blocked on a
  // question, or idle) showed its spawn-time `working` until the next event —
  // the leading cause of "status is a stage behind / still not accurate".
  //
  // parseEvent ACCUMULATES tokens/cost/spark/tail, so we replay into a SCRATCH
  // object and copy back only the last-writer-wins "current state" fields
  // (status/awaitingPrompt/activity/todos/context/resolvedModel). That keeps the
  // real agent's additive counters untouched. Returns the EOF offset it read to
  // (so the forward tailer continues from exactly there), or null on failure.
  async function primeStatusFromDisk() {
    let stats;
    try { stats = await fsp.stat(path); } catch { return null; }
    if (!stats.size) return 0;
    const start = Math.max(0, stats.size - REPLAY_BYTES);
    const len = stats.size - start;
    let text;
    const fh = await fsp.open(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally { await fh.close(); }
    // If we seeked back mid-file, the first line is probably partial — drop it.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const scratch = {
      status: agent.status, awaitingPrompt: agent.awaitingPrompt ?? null,
      activity: agent.activity, todos: agent.todos, context: agent.context,
      resolvedModel: agent.resolvedModel,
      tail: [], tokensIn: 0, tokensOut: 0, costSession: 0, // absorb the additive side-effects
    };
    let any = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { if (parseEvent(JSON.parse(line), scratch)) any = true; } catch { /* skip junk */ }
    }
    if (any) {
      agent.status = scratch.status;
      agent.awaitingPrompt = scratch.awaitingPrompt ?? null;
      if (scratch.activity) agent.activity = scratch.activity;
      if (Array.isArray(scratch.todos)) agent.todos = scratch.todos;
      if (scratch.context) agent.context = scratch.context;
      if (scratch.resolvedModel) agent.resolvedModel = scratch.resolvedModel;
      try { agent.emit('change'); } catch {}
    }
    return stats.size;
  }

  async function readNew() {
    if (stopped || readingLock) return;
    readingLock = true;
    try {
      let stats;
      try {
        stats = await fsp.stat(path);
      } catch {
        // File not present yet — caller's poll loop will retry.
        return;
      }
      if (stats.size <= offset) return;
      const fh = await fsp.open(path, 'r');
      try {
        const len = stats.size - offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        offset = stats.size;
        buffer += buf.toString('utf8');
      } finally {
        await fh.close();
      }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Malformed line — claude session files occasionally carry
          // non-event metadata (ai-title, last-prompt, etc.) that we
          // either ignore (no tool_use in them) or fail to parse.
          // Silent drop is correct; the next valid line will land.
        }
      }
    } finally {
      readingLock = false;
    }
  }

  function attachWatcher() {
    try {
      watcher = fsWatch(path, { persistent: false }, () => readNew());
      return true;
    } catch {
      return false;
    }
  }

  // 0187: when our pinned file has been dead for `rotateAfterFrozenPolls`
  // consecutive polls, look for the transcript claude rotated to and re-point.
  // Only hunts while frozen, so active sessions never pay the readdir; the
  // "our file dead" gate also keeps an active slot from chasing a sibling.
  async function maybeRepoint() {
    let size = -1, mtimeMs = 0;
    try { const st = await fsp.stat(path); size = st.size; mtimeMs = st.mtimeMs; } catch {}
    if (size > lastSize) { lastSize = size; frozenPolls = 0; return; }
    if (++frozenPolls < rotateAfterFrozenPolls) return;
    // Follow rotations FORWARD only: the replacement must be newer than the
    // (dead) file we're on — otherwise two files both newer than spawnedAt
    // would flip-flop the tailer back and forth every poll.
    const floor = Math.max(agent.spawnedAt || 0, mtimeMs);
    let excl = [];
    try { excl = claimedSids() || []; } catch {}
    const sid = await findRotatedSession(agent.cwd, agent.sessionId, floor, excl);
    if (!sid) return;
    try { agent.appendTail?.({ kind: 'sys', text: `tailer: session rotated ${String(agent.sessionId).slice(0, 8)} → ${sid.slice(0, 8)}` }); } catch {}
    agent.sessionId = sid;
    let nextPath;
    try { nextPath = claudeSessionPath({ cwd: agent.cwd, sessionId: sid }); } catch { return; }
    path = nextPath;
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    offset = 0; buffer = ''; lastSize = 0; frozenPolls = 0;
    const primedTo = await primeStatusFromDisk();
    offset = primedTo != null ? primedTo : 0;
    attachWatcher();
    await readNew();
  }

  async function init() {
    // Default attach: prime the CURRENT status from the tail of the file
    // (0178), then continue from exactly the EOF we read to. When the tailer is
    // rebuilt after a sid rotation (zoomSession detected claude minted its own
    // id), fromStart=true replays the WHOLE new file into the real agent — the
    // user prompt + first assistant reply that happened before our detection.
    if (fromStart) {
      offset = 0;
    } else {
      const primedTo = await primeStatusFromDisk();
      if (primedTo != null) {
        offset = primedTo;
      } else {
        // File not present yet — start at 0 so the creation-poll picks up
        // everything once it appears.
        offset = 0;
      }
    }

    if (!attachWatcher()) {
      // File not created yet — poll every 500ms until it appears,
      // then switch to fs.watch. Polling is cheap and avoids racing
      // with the PTY child's first write.
      pollTimer = setInterval(() => {
        if (stopped) return;
        if (attachWatcher()) {
          clearInterval(pollTimer);
          pollTimer = null;
          readNew();
        }
      }, 500);
    } else {
      // Watcher attached on an existing file — kick a first read in
      // case the PTY child appended between our stat and our watch.
      readNew();
    }

    // 0179: stat-poll backstop. fs.watch silently never fires on many
    // cloud-synced (GoogleDrive/CloudStorage) session files — the sync daemon
    // writes via temp+rename — so the card freezes at its last-seen status.
    // Poll readNew() on a modest interval as a safety net; it early-returns
    // when nothing grew (stats.size <= offset), so it's cheap. Runs regardless
    // of whether fs.watch attached. 0187: the same poll drives rotation
    // detection (maybeRepoint), which only does work once our file is dead.
    statPollTimer = setInterval(() => {
      if (stopped) return;
      readNew();
      maybeRepoint();
    }, statPollMs);
  }

  init();

  return {
    path,
    stop() {
      stopped = true;
      if (watcher) {
        try { watcher.close(); } catch {}
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (statPollTimer) {
        clearInterval(statPollTimer);
        statPollTimer = null;
      }
    },
  };
}
