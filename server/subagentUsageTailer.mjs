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
  updateSpark(agent, incIn + incCache + incOut);
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
export function startSubagentUsageTailer({ agent, statPollMs = POLL_MS } = {}) {
  if (!agent) throw new Error('subagentUsageTailer: agent is required');
  const offsets = new Map(); // filename → byte offset
  let stopped = false;
  let primed = false;
  let scanning = false;
  let timer = null;

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
      const dir = subagentsDir();
      if (!dir) return;
      // Dir is absent until the first sub-agent spawns — treat as "no files yet"
      // (NOT an early return), so priming still completes and a subagents/ dir
      // that appears LATER has its files read from byte 0 (fresh fan-out).
      let files = [];
      try { files = await fsp.readdir(dir); } catch { files = []; }
      let changed = false;
      for (const f of files) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
        let size;
        try { size = (await fsp.stat(join(dir, f))).size; } catch { continue; }
        if (!offsets.has(f)) {
          // First sighting. Existing-at-prime files start at EOF; new files at 0.
          offsets.set(f, primed ? 0 : size);
          if (!primed) continue;
        }
        if (await readNew(join(dir, f), f, size)) changed = true;
      }
      primed = true;
      if (changed) { try { agent.emit('change'); } catch {} }
    } finally {
      scanning = false;
    }
  }

  timer = setInterval(scan, statPollMs);
  scan();

  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
