// server/subagentUsageTailer.mjs — fold sub-agent (sidechain) token usage
// into the PARENT session's totals + tok/min.
//
// Why this exists: the main JSONL tailer reads exactly ONE file, the parent
// `<sessionId>.jsonl`. Sub-agent (Task/Agent/Workflow) turns are written to a
// SEPARATE tree, rooted at
// ~/.claude/projects/<encoded-cwd>/<parentSessionId>/subagents/ :
//   agent-<id>.jsonl                     — Task/Agent sub-agents
//   workflows/<runId>/agent-<id>.jsonl   — Workflow sub-agents (one level down)
// Each line is `isSidechain:true` and carries a full `message.usage` block.
// Because the tailer never opens those files, every sub-agent's token +
// cost consumption was invisible — a fan-out session read near-zero tok/min
// and undercounted tokens + cost (verified 2026-07-12). This watcher tails the
// subagents/ dir and attributes their usage back to the parent agent.
//
// Attribution rules (mirror jsonlConnector's main-thread accounting):
//   tokensIn        += input_tokens + cache_creation_input_tokens
//   tokensCacheRead += cache_read_input_tokens
//   tokensOut       += output_tokens
//   costSession     += deriveCost(usage, model)
//   spark           += (in + cache + out)   → tok/min reflects fan-out work
//   context         UNCHANGED — sidechains keep their own window (same rule as
//                   jsonlConnector.mjs where !ev.isSidechain gates context).

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { claudeProjectDir } from './sessionFileTailer.mjs';
import { deriveCost } from './jsonlConnector.mjs';
import { updateSpark } from './spark.mjs';

// Same backstop cadence as the main tailer's stat-poll. The subagents/ dir is
// tiny (a handful of files) so a periodic readdir is cheap; we only do work
// when a file actually grows.
const POLL_MS = 1500;

// Pure: fold one sidechain usage block into the parent agent. Exported for unit
// tests. Returns true if anything was added.
export function applySidechainUsage(agent, usage, modelId) {
  if (!usage) return false;
  const incIn    = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const incCache = usage.cache_read_input_tokens || 0;
  const incOut   = usage.output_tokens || 0;
  if (!incIn && !incCache && !incOut) return false;
  agent.tokensIn        = (agent.tokensIn        || 0) + incIn;
  agent.tokensCacheRead = (agent.tokensCacheRead || 0) + incCache;
  agent.tokensOut       = (agent.tokensOut       || 0) + incOut;
  agent.costSession     = (agent.costSession     || 0) + deriveCost(usage, modelId);
  updateSpark(agent, incIn + incOut);   // fresh throughput only — cache reads re-count context, would inflate ~100×
  // NB: context intentionally untouched.
  return true;
}

// List every agent-*.jsonl under subagents/, as paths RELATIVE to that dir.
//
// Claude Code writes Task sub-agents flat and Workflow sub-agents one level
// deeper, under workflows/<runId>/. The old scan was a name-only readdir of the
// top dir, so "workflows" failed the agent-*.jsonl filter and every workflow
// agent was dropped: measured on the stonks slot (add052b8) 2026-09-19 22:40,
// 20 files scanned / 60 skipped, and inside the 60s liveAgents window 0 scanned
// vs 4 skipped (the newest written 1s earlier). The card read zero background
// agents while workflows ran, and their tokens never reached the parent.
//
// Bounded at exactly that one extra level — not a general tree walk. Every
// agent-*.jsonl on this machine sits at depth 1 or depth 3 (across all
// ~/.claude/projects sessions: 1271 flat, 624 under workflows/<runId>/).
// Cost is 1 + <run dirs> readdirs per poll; a session's run dirs go away with
// the rest of the per-file state on SID rotation.
//
// Relative path, not basename: two runs can hold the same agent-<id>.jsonl, and
// a shared state key makes the second file look like it is already at EOF.
const WORKFLOWS_DIR = 'workflows';
const isAgentFile = (e) => !e.isDirectory() && e.name.startsWith('agent-') && e.name.endsWith('.jsonl');

// 0350: returns { files, complete }. `complete` is false when a run-dir readdir
// failed, so the listing may be missing live files — scan() must not prune
// per-file state off an incomplete listing (a pruned file that comes back would
// re-read from byte 0 and double-count its usage).
// TODO(0350): the listing itself (1 + workflows + <run dirs> readdirs) still
// runs every scan; only the per-file stats are gated. Gating it on the top-dir
// mtime would delay new workflows/<runId>/ agents up to settledRecheckMs. CPU
// effect of what remains is task 0466's to measure.
async function listAgentFiles(dir) {
  const out = [];
  let complete = true;
  // The top-level readdir is deliberately NOT caught here — scan() reads its
  // throw as "dir absent" and drives the backoff off it.
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (isAgentFile(e)) { out.push(e.name); continue; }
    if (e.name !== WORKFLOWS_DIR || !e.isDirectory()) continue;
    let runs;
    try { runs = await fsp.readdir(join(dir, WORKFLOWS_DIR), { withFileTypes: true }); } catch { complete = false; continue; }
    for (const r of runs) {
      if (!r.isDirectory()) continue;
      let files;
      try { files = await fsp.readdir(join(dir, WORKFLOWS_DIR, r.name), { withFileTypes: true }); } catch { complete = false; continue; }
      for (const f of files) if (isAgentFile(f)) out.push(`${WORKFLOWS_DIR}/${r.name}/${f.name}`);
    }
  }
  return { files: out, complete };
}

// startSubagentUsageTailer — poll <parentSessionId>/subagents/ and fold each
// agent-*.jsonl file's new usage lines into the parent.
//
// Offset model (avoids double-counting on resume):
//   - Files present on the FIRST scan (priming) start at EOF — a resumed
//     session must not re-count historical sub-agent spend already in its
//     persisted totals.
//   - Files that APPEAR AFTER priming are fresh fan-out → read from byte 0 so
//     the whole sub-agent's usage is captured.
// Per-file byte offsets are tracked, and we only advance past COMPLETE lines
// (last '\n'), so a partial trailing line is re-read once it's finished.
// 0350: how often settled files are re-stat'd when nothing else says to look.
// On macOS APFS an append to an existing file does NOT change the dir mtime
// (checked 2026-10-08), so the dir-mtime gate alone would miss a resumed
// sub-agent (0408-F6). A parent active in the last settleIdleMs forces a sweep
// every scan (see scan()), so a resume is normally seen on the next poll. This
// slow sweep is the backstop: worst-case pickup of a resumed sub-agent whose
// first write lands after the parent went quiet is this long.
const SETTLED_RECHECK_MS = 60_000;

// `clock` is injectable so the gate's timing tests do not race a real timer.
export function startSubagentUsageTailer({ agent, statPollMs = POLL_MS, settleIdleMs = 30_000, settledRecheckMs = SETTLED_RECHECK_MS, clock = Date.now, autoStart = true } = {}) {
  if (!agent) throw new Error('subagentUsageTailer: agent is required');
  // Keyed by the path relative to subagentsDir() — a bare filename is ambiguous
  // now that workflows/<runId>/ can repeat an agent-<id>.jsonl basename.
  const offsets = new Map(); // relative path → byte offset
  // Completed sub-agent files stop growing once the sidechain finishes. Without
  // this, scan() re-opened and re-read EVERY file the dir has ever held on every
  // poll — the dominant idle-energy cost on long sessions with heavy fan-out.
  // Once a file's size hasn't changed for SETTLE_IDLE_MS (0350: fully read or
  // stuck on an unfinished last line) we
  // `settled` it: from then on it costs ONE cheap stat per scan (no open/read).
  // 0408-F6: settled files keep their byte offset and un-settle the moment the
  // stat sees growth — a resumed sub-agent (SendMessage continues a spawned
  // agent) appends to the same file, and its new usage resumes from the kept
  // offset with no re-read and no double count.
  // Time-based (not poll-count) so it's robust to any poll cadence.
  // 0350: a settled file is NOT stat'd every scan any more — see the dir-mtime
  // gate in scan(). Bounds: `settled`/`offsets`/`lastSize`/`lastGrowTs` are reset
  // on SID rotation, and entries for files no longer on disk are pruned on each
  // gate sweep, so they hold about one entry per file currently in the dir. No FIFO
  // cap: evicting a live file's offset would re-read it from 0 (double count),
  // and keeping the offset without `settled` would stat it every scan forever.
  const settled = new Set();
  const lastSize = new Map();     // relative path → last observed size
  const lastGrowTs = new Map();   // relative path → last time the size changed
  const SETTLE_IDLE_MS = settleIdleMs;
  // 0350 dir-mtime gate state. Measured before the gate: 64 sessions x 137
  // settled files = 8,768 stats per tick (2,989 stat/s, 5.94% of a core).
  let lastDirMtimeMs = null;  // subagents dir mtime at the last scan
  let lastSweepTs = 0;        // last time settled files were re-stat'd
  let stopped = false;
  let primed = false;
  let scanning = false;
  let timer = null;
  // SID-rotation guard: when the parent sessionId is reassigned, the subagents dir
  // path changes; we drop all per-file state and re-prime so the NEW dir's existing
  // files start at EOF (their spend is already in the resumed session's totals).
  let lastSid = null;
  // Dir-absent backoff: a slot that never fans out has no subagents dir. Rather than
  // ENOENT-readdir every poll forever (the dominant idle drain across up to 10 slots),
  // once the dir has been continuously absent past a GRACE window we only re-check
  // every ABSENT_BACKOFF-th tick. The grace keeps detection PROMPT while a slot is
  // active/recent (a sub-agent that spawns is picked up on the next poll); only a
  // long-idle slot with no fan-out backs off. Appearance is never missed — backoff
  // re-checks, it doesn't stop. At the default 1.5s poll: grace ≈ 30s, then ~1 check/12s.
  let absentTicks = 0;
  const ABSENT_GRACE = 20;
  const ABSENT_BACKOFF = 8;

  // The subagents dir is keyed by the CURRENT parent sessionId; resolved each
  // scan so a SID rotation (agent.sessionId reassigned by the main tailer)
  // repoints us automatically.
  function subagentsDir() {
    const sid = agent.sessionId;
    if (typeof sid !== 'string') return null;
    return join(claudeProjectDir(agent.cwd), sid, 'subagents');
  }

  async function readNew(full, name, size) {
    const off = offsets.get(name) || 0;
    if (size <= off) return false;
    const fh = await fsp.open(full, 'r');
    let text;
    try {
      const len = size - off;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, off);
      text = buf.toString('utf8');
    } finally { await fh.close(); }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return false; // no complete line yet — leave offset put
    // Advance only past complete lines (byte-accurate for multibyte content).
    offsets.set(name, off + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
    let changed = false;
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const u = ev?.message?.usage;
      if (u && applySidechainUsage(agent, u, ev.message?.model)) changed = true;
    }
    return changed;
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const sid = agent.sessionId;
      const dir = subagentsDir();
      if (!dir) return;
      // SID rotation: the parent sessionId was reassigned (main tailer repointed us
      // to a new subagents dir). Drop all per-file state and re-prime so the new
      // dir's PRE-EXISTING files start at EOF — their spend is already in the
      // resumed session's persisted totals and must not be re-counted — and so the
      // old session's filenames don't linger in `settled`/`offsets` forever.
      if (sid !== lastSid) {
        lastSid = sid;
        offsets.clear(); settled.clear(); lastSize.clear(); lastGrowTs.clear();
        primed = false;
        absentTicks = 0;
        lastDirMtimeMs = null; lastSweepTs = 0;
      }
      // Dir-absent backoff: after the grace window, only re-check every ABSENT_BACKOFF-th
      // tick instead of ENOENT-readdir'ing every poll for the tailer's whole life.
      if (absentTicks > ABSENT_GRACE && absentTicks % ABSENT_BACKOFF !== 0) { absentTicks++; return; }
      // Dir is absent until the first sub-agent spawns. A missing dir = "no files
      // yet": complete priming (so a dir that appears LATER reads from byte 0 —
      // fresh fan-out) and back off. Present → resume full cadence.
      let files, complete, dirMtimeMs;
      try {
        // 0350: stat the dir BEFORE listing it, so an entry added after this
        // stat moves the mtime seen by the next scan.
        dirMtimeMs = (await fsp.stat(dir)).mtimeMs;
        ({ files, complete } = await listAgentFiles(dir));
        absentTicks = 0;
      } catch {
        absentTicks++;
        primed = true;
        return;
      }
      // 0350 dir-mtime gate: re-stat settled files only when
      //   - the dir's entries changed (mtime moved),
      //   - a sub-agent file grew in the last settleIdleMs, or
      //   - the parent was active in the last settleIdleMs (a resume is driven
      //     by the parent: SendMessage in the transcript, SUB hook events), or
      //   - the slow fallback sweep is due — an append alone does not move the
      //     dir mtime on APFS.
      // Unsettled files are stat'd every scan regardless. Top-dir mtime only: a
      // nested workflows/<runId>/ change does not move it, and the sweep covers
      // those. "Grew recently", not "not yet settled": a file that never
      // settles (a stat that keeps failing) must not force a sweep forever —
      // review probe A measured 695 stats over 5 quiet scans that way.
      // The parent check keeps liveAgents() (the card's bg count) current for
      // a resumed sub-agent; a gated settled file has no fresh lastGrowTs.
      const now0 = clock();
      const recent = (ts) => now0 - (ts || 0) < SETTLE_IDLE_MS;
      let fileActive = false;
      for (const ts of lastGrowTs.values()) if (recent(ts)) { fileActive = true; break; }
      const sweep = dirMtimeMs !== lastDirMtimeMs
        || fileActive
        || recent(agent.lastEventTs) || recent(agent.lastSubHookTs)
        || now0 - lastSweepTs >= settledRecheckMs;
      lastDirMtimeMs = dirMtimeMs;
      if (sweep) lastSweepTs = now0;
      // 0350 bound: drop state for files no longer on disk. Only off a complete
      // listing — a transient run-dir readdir failure must not prune live
      // files. A per-file stat failure never prunes either. Only on a sweep: a
      // delete moves the dir mtime (nested run dirs wait for the fallback).
      if (sweep && complete) {
        const present = new Set(files);
        for (const f of offsets.keys()) {
          if (present.has(f)) continue;
          offsets.delete(f); settled.delete(f); lastSize.delete(f); lastGrowTs.delete(f);
        }
      }
      let changed = false;
      for (const f of files) {   // f is relative to `dir` — bare name, or workflows/<runId>/<name>
        if (!sweep && settled.has(f)) continue; // 0350: gated — no stat this scan
        let size;
        let st;
        try { st = await fsp.stat(join(dir, f)); size = st.size; } catch { continue; }
        // 0408-F6: a settled file is NOT dead — the parent can resume that
        // sub-agent (Agent tool: SendMessage continues a spawned agent) and its
        // new turns append to the SAME file. Settling used to drop the offset
        // and skip the file forever, so every resumed sub-agent's usage
        // vanished. Now a settled file is stat'd when the 0350 gate sweeps;
        // on growth it un-settles and resumes from its KEPT offset, so
        // nothing is ever re-read or double-counted.
        if (settled.has(f)) {
          if (size === lastSize.get(f)) continue; // still settled — stat only
          settled.delete(f);
        }
        if (!offsets.has(f)) {
          // First sighting. Existing-at-prime files start at EOF; new files at 0.
          offsets.set(f, primed ? 0 : size);
          // 0411 FIX: seed the growth clock from the FILE, never from now.
          // The priming pass `continue`d before the bookkeeping below, so on
          // the NEXT pass `lastSize.get(f)` was undefined, every pre-existing
          // file looked like it had just grown, and its clock was stamped with
          // the current time. Measured on this machine: 137 historical
          // sub-agent files, newest untouched for 13.8 hours, reported as 67
          // agents all aged 0.0 seconds. That is how a hardcoded "1" became a
          // confident, wrong 67 — worse, because it looks like real data.
          // A file's age belongs to the file.
          lastSize.set(f, size);
          lastGrowTs.set(f, st.mtimeMs);
          if (!primed) continue;
        }
        // Track growth so an idle, fully-read file can settle out of the poll.
        const now = clock();
        if (lastSize.get(f) !== size) { lastSize.set(f, size); lastGrowTs.set(f, now); }
        if (await readNew(join(dir, f), f, size)) changed = true;
        // 0350: settle on idle alone, even with an unfinished last line (a
        // sub-agent that crashed mid-write). Re-reading that fragment every
        // scan learns nothing; finishing it changes the size, which un-settles
        // the file and reads on from the kept offset — once.
        if (now - (lastGrowTs.get(f) || now) >= SETTLE_IDLE_MS) {
          // Keep offsets + lastSize: the offset is where a resume continues
          // from (no double count) and lastSize is the growth check above.
          settled.add(f); lastGrowTs.delete(f);
        }
      }
      primed = true;
      if (changed) { try { agent.emit('change'); } catch {} }
    } finally {
      scanning = false;
    }
  }

  // Backstop poll. No fs.watch (kept deliberately simple): active fan-out files are
  // read at statPollMs, and the dir-absent backoff in scan() keeps idle/never-fan-out
  // slots from ENOENT-readdir'ing every tick. A promptness-oriented fs.watch (mirror
  // statusHookTailer's watch+creation-poll) is a possible follow-up, not needed for
  // the idle-battery fix. `autoStart:false` lets tests drive scan() deterministically.
  // Workflow files under workflows/<runId>/ ride this same stat-poll. There is no
  // watch here to make recursive, and adding one for the nested dirs would need a
  // watch per run dir that is created and torn down as runs come and go — the poll
  // already finds a new run dir on the next tick (≤1.5s), which is the same
  // promptness the flat files get.
  if (autoStart) {
    timer = setInterval(scan, statPollMs);
    scan();
  }

  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    // Exposed for tests: run one scan pass synchronously-awaitable.
    scan,
    // Exposed for the heap probe (heapProbe.fleetCounts): `settled` holds one
    // entry per completed sub-agent file still on disk — bounded by SID
    // rotation and by the 0350 prune. Surfacing its size lets the OOM watchdog
    // NDJSON confirm whether it ever grows large in practice.
    settledCount: () => settled.size,
    // 0350: files with per-file state (offsets). Exposed for the bound test.
    trackedCount: () => offsets.size,
    // 0411 CONNECTOR — the live fan-out, read from the files this tailer is
    // ALREADY watching. Every sub-agent writes its own agent-<id>.jsonl; a file
    // that grew inside `withinMs` has an agent actively producing output. This
    // is the only source that can COUNT them: the transcript's tool_use/
    // tool_result pairing cannot, because a BACKGROUND launch's tool_result is
    // the launch receipt (claude prints "Backgrounded agent"), not the finish,
    // so the pairing map empties the instant the agents start. That is why the
    // card hardcoded "1bg" for any fan-out of any size.
    liveAgents({ withinMs = 60_000, now = clock() } = {}) {
      const out = [];
      for (const [rel, ts] of lastGrowTs) {
        if (now - ts > withinMs) continue;
        // rel may be workflows/<runId>/agent-<id>.jsonl — the id lives in the basename.
        const base = rel.slice(rel.lastIndexOf('/') + 1);
        const id = base.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        out.push({ id, lastGrowTs: ts });
      }
      return out.sort((a, b) => a.lastGrowTs - b.lastGrowTs);
    },
  };
}
