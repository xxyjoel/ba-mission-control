// server/subagentUsageTailer.mjs — fold sub-agent (sidechain) token usage
// into the PARENT session's totals + tok/min.
//
// Why this exists: the main JSONL tailer reads exactly ONE file, the parent
// `<sessionId>.jsonl`. Sub-agent (Task/Workflow) turns are written to a
// SEPARATE tree:
//   ~/.claude/projects/<encoded-cwd>/<parentSessionId>/subagents/agent-<id>.jsonl
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
export function startSubagentUsageTailer({ agent, statPollMs = POLL_MS, settleIdleMs = 30_000, autoStart = true } = {}) {
  if (!agent) throw new Error('subagentUsageTailer: agent is required');
  const offsets = new Map(); // filename → byte offset
  // Completed sub-agent files stop growing once the sidechain finishes. Without
  // this, scan() re-stats EVERY file the dir has ever held on every poll — O(all
  // sub-agents) I/O forever, the dominant idle-energy cost on long sessions with
  // heavy fan-out. Once a file is fully read AND its size hasn't changed for
  // SETTLE_IDLE_MS we `settled` it and skip it (never evicted — re-reading from 0
  // would double-count its usage). Per-poll cost then tracks ACTIVE files, not
  // all-time. Time-based (not poll-count) so it's robust to any poll cadence.
  // `settled` is reset on SID rotation (see scan()), which bounds its dominant
  // growth path — the old session's filenames no longer leak forever. The residual
  // (a single session that spawns thousands of sub-agents) is task 0350: an
  // in-session count/age cap, which needs care because re-reading an evicted file
  // from offset 0 would double-count its usage — deferred there with a before-fix
  // fixture rather than risk corrupting cost/token totals here.
  const settled = new Set();
  const lastSize = new Map();     // filename → last observed size
  const lastGrowTs = new Map();   // filename → last time the size changed
  const SETTLE_IDLE_MS = settleIdleMs;
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
      }
      // Dir-absent backoff: after the grace window, only re-check every ABSENT_BACKOFF-th
      // tick instead of ENOENT-readdir'ing every poll for the tailer's whole life.
      if (absentTicks > ABSENT_GRACE && absentTicks % ABSENT_BACKOFF !== 0) { absentTicks++; return; }
      // Dir is absent until the first sub-agent spawns. A missing dir = "no files
      // yet": complete priming (so a dir that appears LATER reads from byte 0 —
      // fresh fan-out) and back off. Present → resume full cadence.
      let files;
      try {
        files = await fsp.readdir(dir);
        absentTicks = 0;
      } catch {
        absentTicks++;
        primed = true;
        return;
      }
      let changed = false;
      for (const f of files) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
        if (settled.has(f)) continue; // completed sidechain — no more stat/read
        let size;
        try { size = (await fsp.stat(join(dir, f))).size; } catch { continue; }
        if (!offsets.has(f)) {
          // First sighting. Existing-at-prime files start at EOF; new files at 0.
          offsets.set(f, primed ? 0 : size);
          if (!primed) continue;
        }
        // Track growth so an idle, fully-read file can settle out of the poll.
        const now = Date.now();
        if (lastSize.get(f) !== size) { lastSize.set(f, size); lastGrowTs.set(f, now); }
        if (await readNew(join(dir, f), f, size)) changed = true;
        if ((offsets.get(f) || 0) >= size && now - (lastGrowTs.get(f) || now) >= SETTLE_IDLE_MS) {
          settled.add(f); offsets.delete(f); lastSize.delete(f); lastGrowTs.delete(f);
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
  };
}
