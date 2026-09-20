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
import { StringDecoder } from 'node:string_decoder';
import { parseEvent, pushTail } from './jsonlConnector.mjs';
// 0408-F1/M6: the rotation hunt classifies every candidate transcript so a
// BACKGROUND FORK (sessionKind:'bg') is never adopted as the slot's session.
// This import closes the module cycle bgSessions.mjs documents (sessionFileTailer
// → bgSessions → statusHookTailer → sessionFileTailer); it is safe because
// nothing in the cycle runs at module-eval time — tests/bgSessions.test.mjs
// pins the co-load.
import { classifyTranscript } from './bgSessions.mjs';

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
// Pure: should the (expensive) rotation hunt run this poll? Once the pinned file
// is dead AND a prior hunt found no replacement, we back off so a permanently-
// idle session doesn't readdir + per-file-stat the whole (possibly 1600+ file)
// project dir every 1.5s poll — the dominant idle CPU/disk drain (audit
// 2026-07-30). `missTicks` = polls since we started missing; hunt on 0, then
// every `backoff`-th poll (so a late rotation is still caught, just less
// promptly). backoff<=1 disables the backoff (always hunt). Exported for tests.
export function shouldHuntRotation(missTicks, backoff) {
  if (!(backoff > 1)) return true;
  return missTicks % backoff === 0;
}

// Pure: given the project dir's current mtime and the one recorded at the last
// hunt, is the (expensive) per-file hunt worth running? A rotation necessarily
// creates a new file in the project dir, which bumps the dir's own mtime — so
// an unchanged mtime proves there is nothing new to find and the whole
// readdir + per-file-stat fan-out (140+ serial stats on real project dirs) can
// be skipped for the cost of ONE stat (energy review 2026-08, finding 2:
// ~119 wakeups/s at full idle). An unconditional hunt still runs every
// `unconditionalEvery`-th poll-tick as a backstop for cloud-synced paths where
// dir mtimes are unreliable. dirMtimeMs=0 (stat failed) disables the gate.
// Exported for tests.
export function shouldHuntDirMtime(dirMtimeMs, lastHuntDirMtimeMs, missTicks, unconditionalEvery = DIR_HUNT_UNCONDITIONAL_EVERY) {
  if (!dirMtimeMs) return true;                       // can't stat the dir — don't trust the gate
  if (dirMtimeMs !== lastHuntDirMtimeMs) return true; // dir changed since our last hunt
  if (!(unconditionalEvery > 1)) return true;
  return missTicks % unconditionalEvery === 0;        // slow unconditional backstop
}

// Poll-ticks between unconditional (gate-bypassing) hunts: 40 × 1.5s = every
// ~60s an idle slot re-hunts even with an unchanged dir mtime.
const DIR_HUNT_UNCONDITIONAL_EVERY = 40;

// Pure: creation-poll delay for the Nth attempt. The watched file appears
// within seconds when the user prompts right after launch; a
// launched-but-unprompted slot otherwise creation-polls 2×/s forever —
// +4 wakeups/s per such slot (energy review 2026-08, finding 4). Fast for the
// first `fastAttempts` (10s of coverage at the defaults), slow after.
// Shared by sessionFileTailer and statusHookTailer. Exported for tests.
export function creationPollDelay(attempt, fastMs = 500, fastAttempts = 20, slowMs = 2000) {
  return attempt < fastAttempts ? fastMs : slowMs;
}

export async function findRotatedSession(cwd, currentSid, minMtime = 0, excludeSids = []) {
  const dir = claudeProjectDir(cwd);
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  const exclude = excludeSids instanceof Set ? excludeSids : new Set(excludeSids || []);
  const floor = minMtime || 0;
  const candidates = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -'.jsonl'.length);
    if (sid === currentSid || exclude.has(sid) || !UUID_SHAPE.test(sid)) continue;
    let mt;
    try { mt = (await fsp.stat(join(dir, f))).mtimeMs; } catch { continue; }
    if (mt > floor) candidates.push({ sid, mt, path: join(dir, f) });
  }
  // Newest first, then take the first candidate that is NOT a background fork.
  // 0408-F1: claude forks conversations into the background under a fresh sid
  // in the SAME project dir; adopting one re-pointed the slot (and, via the
  // store, `--resume`) onto a conversation the user never opened. classify-
  // Transcript fails OPEN ('normal' on any read failure/ambiguity — see the
  // FAIL-OPEN rule in bgSessions.mjs), so /clear rotations and zoomSession's
  // minted sids still rotate exactly as before.
  candidates.sort((a, b) => b.mt - a.mt);
  for (const c of candidates) {
    if (await classifyTranscript(c.path, c.sid) === 'bg') continue;
    return c.sid;
  }
  return null;
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
// 0416/6: how much of the HEAD to read for the conversation's start time.
// Claude writes a metadata preamble — `mode`, `ai-title`, `permission-mode`,
// `file-history-snapshot` — before the first record that carries a `timestamp`.
// Surveyed 20 real transcripts: only 4 had a timestamp on line 1; the rest
// needed 319 B to 402 KiB of head, and in one file the first timestamped
// record was itself a 65 KB `user` line. So read the head in CHUNKS and stop
// at the first timestamp; HEAD_MAX bounds the worst case so a multi-MB
// transcript is never read end to end.
const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 1024 * 1024;

export function startSessionTailer({
  agent,
  fromStart = false,
  statPollMs = STAT_POLL_MS,
  // 0187: how many consecutive no-growth stat-polls before we go looking for a
  // rotated transcript. Keeps the (cheap) readdir off the hot path for active
  // sessions; injectable so the rotation path is testable without real waits.
  rotateAfterFrozenPolls = 3,
  // Once frozen and a rotation hunt has found nothing, only re-hunt every
  // Nth poll instead of every poll (audit 2026-07-30 idle-drain fix). Injectable
  // so the backoff cadence is testable; <=1 disables it (hunt every poll).
  repointBackoff = 8,
  // 0188: a getter returning the sessionIds owned by OTHER live slots, so a
  // rotation hunt never re-points onto a sibling slot's transcript. A function
  // (not a snapshot) so it reflects re-points that happen after attach. Default
  // claims nothing — single-slot behaviour is unchanged.
  claimedSids = () => [],
  // 0381: 'self' (default) owns its stat-poll interval as before; 'external'
  // creates NO backstop timer — the caller (Fleet's single tailer driver)
  // invokes tick() instead, collapsing 3 timers × N agents into one wakeup.
  drive = 'self',
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
  let lastHuntDirMtime = 0; // project-dir mtime recorded at the last hunt (dir-mtime gate)
  let repointMissTicks = 0;       // polls since a rotation hunt last found nothing (drives backoff)

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

  // 0416/1: the primed window is HISTORY, not a counter. The scratch object in
  // primeStatusFromDisk absorbs the ADDITIVE fields (tokens/cost/spark); its
  // `tail` was absorbed too and thrown away, which is why the fleet log was
  // empty after every resume and every mc restart. Measured against a real
  // 24-record transcript: after prime, agent.tail.length === 0; after one live
  // event, 1.
  //
  // Appending it blind is wrong. PtyAgent.start() also runs on auto-restart,
  // changeModel and changePermissionMode, where the ring ALREADY holds these
  // entries — and start() pushes its own `spawn/resume pid=` sys line BEFORE it
  // builds the tailer, so "agent.tail is empty" cannot stand in for "fresh
  // attach": it never is. Key each replayed entry by its content instead and
  // keep only what the ring does not hold. That also covers the rotation
  // repoint below, where claude's new transcript can be a --resume copy of the
  // old one.
  //
  // Everything goes back through pushTail, so TAIL_MAX and the _tailChars
  // budget stay exact (jsonlConnector:71-84) and both production classes
  // account the same way (agent.mjs / ptyAgent.mjs appendTail are pushTail).
  // Its front-eviction is also what makes a full-ring re-attach a no-op:
  // replayed entries go in FRONT, so a full ring drops them again.
  //
  // TODO(tail-clock): front placement fixes the RING's order, not the rendered
  // one — pushTail stamps each replayed entry ts=now and deriveFleetLog sorts
  // rows by ts (FleetLog.jsx:62), so a restored row shows the attach-time clock.
  // Carrying ev.timestamp through parseEvent into pushTail is the real fix;
  // scratch's own front-eviction makes index arithmetic over the 256 KiB
  // window unreliable from out here.
  function tailKey(e) {
    return `${e?.kind || ''}\u0000${e?.tool || ''}\u0000${e?.text || ''}`;
  }
  function mergeReplayedTail(replayed) {
    if (!Array.isArray(replayed) || !replayed.length) return;
    if (!Array.isArray(agent.tail)) agent.tail = [];
    const held = new Set(agent.tail.map(tailKey));
    const fresh = replayed.filter((e) => !held.has(tailKey(e)));
    if (!fresh.length) return;
    // splice, not reassign: FleetLog and toJSON read agent.tail by reference.
    const existing = agent.tail.splice(0, agent.tail.length);
    agent._tailChars = 0;
    for (const e of fresh) pushTail(agent, e);
    for (const e of existing) pushTail(agent, e);
  }

  // 0416/6: the conversation's true age. Both card clocks were anchored to the
  // moment mc constructed the agent object, so seven slots launched together
  // all read the same hourglass and a conversation whose first record is dated
  // 2026-08-30 rendered as `46m`. primeStatusFromDisk can never supply this —
  // it seeks to (size - REPLAY_BYTES) and drops the partial first line, so it
  // has never seen record 0. Read the head instead. Returns epoch ms, or null
  // when the file is missing, empty, or carries no timestamp in HEAD_MAX.
  async function readSessionStartedAt() {
    let fh;
    try { fh = await fsp.open(path, 'r'); } catch { return null; }
    try {
      const buf = Buffer.alloc(HEAD_CHUNK);
      // StringDecoder, not buf.toString(): a multi-byte character straddling a
      // chunk boundary would otherwise decode to U+FFFD on both sides and could
      // cost us the record we came for.
      const decoder = new StringDecoder('utf8');
      let pos = 0;
      let rest = '';
      while (pos < HEAD_MAX) {
        const { bytesRead } = await fh.read(buf, 0, HEAD_CHUNK, pos);
        if (!bytesRead) return null;
        pos += bytesRead;
        rest += decoder.write(buf.subarray(0, bytesRead));
        let nl;
        while ((nl = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          if (!line.trim()) continue;
          let ms;
          // Preamble records (mode/ai-title/permission-mode/file-history-
          // snapshot) parse fine and simply have no timestamp — keep scanning.
          try { ms = Date.parse(JSON.parse(line)?.timestamp ?? ''); } catch { continue; }
          if (Number.isFinite(ms)) return ms;
        }
        if (bytesRead < HEAD_CHUNK) return null;   // EOF, nothing timestamped
      }
      return null;
    } catch { return null; } finally { try { await fh.close(); } catch {} }
  }

  // Set the shared-contract field. Never clobbers a known start with null: a
  // transient read failure on re-attach must not blank a card's age.
  async function primeSessionStartedAt() {
    const ms = await readSessionStartedAt();
    if (stopped) return;              // 0408-F7: no agent mutation after stop()
    if (ms != null) agent.sessionStartedAt = ms;
    else agent.sessionStartedAt ??= null;
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
      tail: [], tokensIn: 0, tokensCacheRead: 0, tokensOut: 0, costSession: 0, // absorb the additive side-effects
    };
    let any = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { if (parseEvent(JSON.parse(line), scratch)) any = true; } catch { /* skip junk */ }
    }
    // Did this primed region contain a /clear? On /clear claude rotates to a NEW
    // transcript, so the reset almost always lands at the TOP of the file we're
    // (re)attaching to — never in the live forward-tail. The scratch replay reset
    // its counters at the /clear and re-accumulated only the post-clear turns, so
    // scratch's totals ARE the correct "current session" figures. Without this the
    // real agent kept its pre-clear totals and the new conversation piled on top
    // (the "tokens way too high after /clear" bug). Matches jsonlConnector's
    // /clear pattern. Only triggers when a /clear is actually in the window, so
    // non-clear primes keep the existing accumulate-forward behavior.
    const sawClear = /<command-name>\s*\/clear\b/.test(text);
    if (any) {
      agent.status = scratch.status;
      agent.awaitingPrompt = scratch.awaitingPrompt ?? null;
      if (scratch.activity) agent.activity = scratch.activity;
      if (Array.isArray(scratch.todos)) agent.todos = scratch.todos;
      if (sawClear) {
        // Adopt the post-clear re-accumulated totals (forward tail continues on
        // top from EOF). Context copied even when 0 (a trailing /clear leaves it 0).
        agent.tokensIn        = scratch.tokensIn        || 0;
        agent.tokensCacheRead = scratch.tokensCacheRead || 0;
        agent.tokensOut       = scratch.tokensOut       || 0;
        agent.costSession     = scratch.costSession     || 0;
        agent.context         = scratch.context         || 0;
        agent._usageByMsg?.clear?.();
        agent.lastTokRate     = 0;
      } else if (scratch.context) {
        agent.context = scratch.context;
      }
      if (scratch.resolvedModel) agent.resolvedModel = scratch.resolvedModel;
      mergeReplayedTail(scratch.tail);
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
    // 0408-F7: stop() can land while any await above/below is in flight; without
    // these gates the continuation kept mutating agent state (and init() kept
    // arming timers) after the tailer was stopped.
    if (stopped) return;
    if (size > lastSize) { lastSize = size; frozenPolls = 0; repointMissTicks = 0; return; }
    if (++frozenPolls < rotateAfterFrozenPolls) return;
    // Frozen: only run the expensive hunt on the backoff cadence (skips still
    // increment the miss counter). Our own file's growth is detected by the cheap
    // stat above every poll, so active/revived slots always reset promptly.
    if (!shouldHuntRotation(repointMissTicks, repointBackoff)) { repointMissTicks++; return; }
    // Dir-mtime gate: one stat of the project dir replaces the whole per-file
    // fan-out when nothing in the dir has changed since our last hunt.
    let dirMt = 0;
    try { dirMt = (await fsp.stat(claudeProjectDir(agent.cwd))).mtimeMs; } catch {}
    if (stopped) return; // 0408-F7
    if (!shouldHuntDirMtime(dirMt, lastHuntDirMtime, repointMissTicks)) { repointMissTicks++; return; }
    lastHuntDirMtime = dirMt;
    // Follow rotations FORWARD only: the replacement must be newer than the
    // (dead) file we're on — otherwise two files both newer than spawnedAt
    // would flip-flop the tailer back and forth every poll.
    const floor = Math.max(agent.spawnedAt || 0, mtimeMs);
    let excl = [];
    try { excl = claimedSids() || []; } catch {}
    const sid = await findRotatedSession(agent.cwd, agent.sessionId, floor, excl);
    if (stopped) return; // 0408-F7: never re-point (or mutate the agent) after stop()
    if (!sid) { repointMissTicks++; return; } // no replacement yet — back off the next polls
    try { agent.appendTail?.({ kind: 'sys', text: `tailer: session rotated ${String(agent.sessionId).slice(0, 8)} → ${sid.slice(0, 8)}` }); } catch {}
    agent.sessionId = sid;
    let nextPath;
    try { nextPath = claudeSessionPath({ cwd: agent.cwd, sessionId: sid }); } catch { return; }
    path = nextPath;
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    offset = 0; buffer = ''; lastSize = 0; frozenPolls = 0; repointMissTicks = 0; lastHuntDirMtime = 0;
    await primeSessionStartedAt();   // 0416/6: new transcript, new record 0
    const primedTo = await primeStatusFromDisk();
    if (stopped) return; // 0408-F7: don't re-attach a watcher on a stopped tailer
    offset = primedTo != null ? primedTo : 0;
    attachWatcher();
    await readNew();
  }

  async function init() {
    // 0416/6: conversation age comes from the HEAD of the transcript; the status
    // prime below only ever sees its tail. Both attach paths need it.
    await primeSessionStartedAt();
    if (stopped) return;
    // Default attach: prime the CURRENT status from the tail of the file
    // (0178), then continue from exactly the EOF we read to. When the tailer is
    // rebuilt after a sid rotation (zoomSession detected claude minted its own
    // id), fromStart=true replays the WHOLE new file into the real agent — the
    // user prompt + first assistant reply that happened before our detection.
    if (fromStart) {
      offset = 0;
    } else {
      const primedTo = await primeStatusFromDisk();
      if (stopped) return; // 0408-F7: stop() during the prime read must not arm
                           // the watcher, the creation poll, or the backstop
                           // interval — they leaked for the life of the process.
      if (primedTo != null) {
        offset = primedTo;
      } else {
        // File not present yet — start at 0 so the creation-poll picks up
        // everything once it appears.
        offset = 0;
      }
    }
    if (stopped) return; // 0408-F7 (the fromStart path only awaits the head read)

    if (!attachWatcher()) {
      // File not created yet — poll until it appears, then switch to fs.watch.
      // Fast (500ms) for the first ~10s, then 2s: claude doesn't write the
      // JSONL until the first user message commits, so an unprompted slot
      // would otherwise poll 2×/s for its whole life (creationPollDelay).
      let creationAttempts = 0;
      const pollCreate = () => {
        if (stopped) return;
        if (attachWatcher()) {
          pollTimer = null;
          // The file did not exist at attach, so the head read returned null.
          // It exists now — read record 0 or the slot stays ageless for life.
          primeSessionStartedAt();
          readNew();
          return;
        }
        pollTimer = setTimeout(pollCreate, creationPollDelay(++creationAttempts));
      };
      pollTimer = setTimeout(pollCreate, creationPollDelay(0));
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
    if (drive !== 'external') {
      statPollTimer = setInterval(() => {
        if (stopped) return;
        readNew();
        maybeRepoint();
      }, statPollMs);
    }
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
    // 0381: one externally-driven backstop pass (drive: 'external'). Same body
    // as the self-owned interval; safe to call on a stopped tailer.
    tick() {
      if (stopped) return;
      readNew();
      maybeRepoint();
    },
  };
}
