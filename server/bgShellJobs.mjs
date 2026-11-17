// server/bgShellJobs.mjs — background shell jobs (0483).
//
// claude runs a Bash command in the background when the call sets
// run_in_background (or the user backgrounds a running command). The main
// turn then ends, the Stop hook fires, and the card read IDLE with nothing
// else on it while the command kept running for half an hour
// (outbound-orchestrator, 2026-11-12). Background AGENTS already show on the
// card (0403/0411); shell jobs were never read.
//
// claude's session log records both ends of a shell job:
//   start   a Bash tool_result whose text BEGINS with a receipt START_RE knows
//   finish  a <task-notification> block naming the job's <task-id>, written as
//           • a user record whose string content begins with the block (claude
//             was idle, so the notice starts a turn), or
//           • a queue-operation record's `content` (claude was busy, so the
//             notice was queued), repeated as an attachment of type
//             queued_command (`prompt`).
//
// Both parsers are anchored to the start of the text. A tool_result or a
// reply that merely QUOTES these strings (a session reading another session's
// log, as this file's own tests do) must never start or end a job.
//
// Some stops leave no finish record at all: claude's own note says a job
// stopped from its task list or with TaskStop "leave[s] no completion record".
// TaskStop is caught from its tool_use; everything else is caught by the
// process check below, which Fleet runs on its process-sampling tick.
//
// 0484: the process check is also the COUNT of last resort. The log misses
// jobs a sub-agent starts (its Bash calls are in its own file), jobs from
// before mc started (the startup replay never copies jobs), and any receipt
// wording claude adds later. A shell claude started for a Bash command shows
// in the process list whatever started it. Measured on 2026-11-17: slot 3
// read IDLE for 2 days 18 hours over two wait loops a finished sub-agent had
// left running; the log replay found 0 open jobs.
//
// This module is pure except sampleProcessRows (one argv-form `ps`).

import { execFile } from 'node:child_process';

// 0485: every receipt claude 2.1.322 writes when a Bash command goes to the
// background, read from its program on 2026-11-17. Counted across all local
// logs the same day: "running in background" 1,245, "did not complete within
// its Ns timeout" 421, "moved … after running for Ns" 75; the other two had no
// hits yet. Ids claude mints are short alphanumerics (b29pqjo69); the id group
// is bounded so a junk line cannot plant a huge key.
export const START_RE = new RegExp('^Command (?:'
  + 'running in background with ID: '
  + '|was manually backgrounded by user with ID: '
  + '|was moved to the background \\(ID: '            // "… after running for Ns" / "… so that a message …"
  + '|did not complete within its \\d+s timeout and was moved to the background \\(ID: '
  + ')([A-Za-z0-9_-]{1,64})');

// A job map larger than this means something leaked; drop the oldest.
export const BG_JOBS_MAX = 64;
// Recent Bash tool_use ids → label, so a start can be paired with its call.
const BASH_USES_MAX = 64;

// The tools that stop a background task by id. TaskStop is current; the
// others are older names for the same thing.
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

// jobIdFromStart(text) → the job id when `text` is a background-start
// receipt, else null. Anchored: the phrase must open the text.
export function jobIdFromStart(text) {
  if (typeof text !== 'string') return null;
  return text.trimStart().match(START_RE)?.[1] ?? null;
}

// claude sometimes delivers a notice as a user message behind a fixed header
// paragraph: "[SYSTEM NOTIFICATION - NOT USER INPUT]\n…\n\n<task-notification>…".
// Counted 2026-11-17 over 30 days of local logs: 67 in main logs and 75 in
// sub-agent logs; every other notice opens with the block itself.
const NOTICE_WRAPPER = '[SYSTEM NOTIFICATION - NOT USER INPUT]';

// noticeText — the text from its first notice block on, when the text opens
// with a block (or with the header paragraph and then a block), else null.
function noticeText(text) {
  if (typeof text !== 'string') return null;
  let t = text.trimStart();
  if (t.startsWith(NOTICE_WRAPPER)) {
    const gap = t.indexOf('\n\n');
    if (gap < 0) return null;
    t = t.slice(gap + 2).trimStart();
  }
  return t.startsWith('<task-notification>') ? t : null;
}

// finishedJobs(text) → [{ id, status }] for every <task-notification> block
// in `text`, but only when the text BEGINS with one (after the header
// paragraph above, if present). A notice whose status is 'running' is a
// progress report, not a finish, and is left out.
export function finishedJobs(raw) {
  const text = noticeText(raw);
  if (text == null) return [];
  const out = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1].match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1];
    const status = m[1].match(/<status>\s*([^<]*?)\s*<\/status>/)?.[1] || '';
    if (id && status !== 'running') out.push({ id, status });
  }
  return out;
}

// noteBashUse — remember a Bash tool_use so its tool_result can be paired.
// 0485: `ts` is the tool_use record's time. The shell starts then, not when
// the receipt lands: a command moved to the background after its 180 s limit
// started 3 minutes before its receipt (slot 3, 2026-11-15 00:47:29Z).
export function noteBashUse(agent, part, ts = Date.now()) {
  if (part?.name !== 'Bash' || typeof part.id !== 'string') return;
  const map = (agent._bashUses ??= new Map());
  const input = part.input || {};
  const label = String(input.description || input.command || 'shell command').slice(0, 200);
  map.set(part.id, { label, useTs: ts });
  while (map.size > BASH_USES_MAX) map.delete(map.keys().next().value);
}

// trackJobStart — a Bash tool_result that opens with a start receipt adds a
// job. Only for a tool_use this connector saw as Bash. Returns true on add.
// `ts` is the receipt's record time. The job keeps both times: the shell
// started between them, which is how the process check matches it.
export function trackJobStart(agent, toolUseId, text, ts = Date.now()) {
  const use = agent._bashUses?.get(toolUseId);
  if (use === undefined) return false;
  agent._bashUses.delete(toolUseId);
  const id = jobIdFromStart(text);
  if (!id) return false;
  const jobs = (agent.bgJobs ??= new Map());
  jobs.set(id, { label: use.label, startTs: Math.min(use.useTs ?? ts, ts), resultTs: ts });
  while (jobs.size > BG_JOBS_MAX) jobs.delete(jobs.keys().next().value);
  return true;
}

// trackJobEnds — drop every job a notification text reports as finished.
// Safe to run again: the same finish arrives in two or three records.
// Returns the jobs removed, with their labels, for the fleet log.
export function trackJobEnds(agent, text) {
  const jobs = agent.bgJobs;
  if (!jobs?.size) return [];
  const removed = [];
  for (const { id, status } of finishedJobs(text)) {
    const job = jobs.get(id);
    if (!job) continue;
    jobs.delete(id);
    removed.push({ id, status, label: job.label });
  }
  return removed;
}

// trackJobStop — a TaskStop (or older KillShell) call ends the job it names.
// 0486: TaskStop also takes a background agent's id.
export function trackJobStop(agent, part) {
  if (!STOP_TOOLS.has(part?.name)) return false;
  const id = part.input?.task_id ?? part.input?.shell_id ?? part.input?.bash_id;
  if (typeof id !== 'string') return false;
  const job = !!agent.bgJobs?.delete(id);
  const ag = !!agent.bgAgents?.delete(id);
  return job || ag;
}

// trackSubagentJobs — 0488: a sub-agent's Bash calls are in its own file
// (subagents/agent-<id>.jsonl), which the usage tailer reads. Track the
// background jobs it starts on the parent slot, so the card can name them;
// the process check then matches them to their shells like any other job.
// Returns true when a job was added or ended.
export function trackSubagentJobs(agent, ev) {
  // Finish notices that arrive while the sub-agent is busy: queued, then
  // repeated as a queued_command attachment (962 of the sub-agent notices
  // counted on 2026-11-17 came this way).
  if (ev?.type === 'queue-operation') return trackJobEnds(agent, ev.content).length > 0;
  if (ev?.type === 'attachment') {
    return ev.attachment?.type === 'queued_command' && trackJobEnds(agent, ev.attachment.prompt).length > 0;
  }
  // Only conversation records. An api-request-blob record repeats text the
  // model was sent, old notices included.
  if (ev?.type !== 'user' && ev?.type !== 'assistant') return false;
  const content = ev.message?.content;
  if (typeof content === 'string') return ev.type === 'user' && trackJobEnds(agent, content).length > 0;
  if (!Array.isArray(content)) return false;
  const t = Date.parse(ev.timestamp || '');
  const ts = Number.isFinite(t) ? t : Date.now();
  let changed = false;
  for (const p of content) {
    if (ev.type === 'assistant' && p?.type === 'tool_use') {
      noteBashUse(agent, p, ts);
      if (trackJobStop(agent, p)) changed = true;
    } else if (p?.type === 'tool_result') {
      const text = typeof p.content === 'string'
        ? p.content
        : Array.isArray(p.content) ? p.content.map((c) => c?.text || '').join('\n') : '';
      if (trackJobStart(agent, p.tool_use_id, text, ts)) changed = true;
    } else if (ev.type === 'user' && p?.type === 'text' && trackJobEnds(agent, p.text).length > 0) {
      changed = true;
    }
  }
  return changed;
}

// ── Background agents (0486) ─────────────────────────────────────────────
// A background agent's Agent tool_result is its launch receipt, not its end:
//   "Async agent launched successfully. (…)\nagentId: <id> (internal ID …"
// (1,242 seen in local logs, 2026-10-17 to 2026-11-17). Its end is a
// <task-notification> whose <task-id> is that agentId, with the same statuses
// as a shell job. mc used to count an agent only while its file grew in the
// last 60 s; measured over 3,233 sub-agent files, 51% went quiet longer than
// that while running, and 21% of agent run time was spent in such gaps.
const AGENT_LAUNCH = 'Async agent launched successfully';
const AGENT_ID_RE = /\bagentId: ([A-Za-z0-9_-]{1,64})/;
const BG_AGENTS_MAX = 64;

// agentIdFromLaunch(text) → the agentId when `text` OPENS with a launch
// receipt, else null. Anchored like the job receipts.
export function agentIdFromLaunch(text) {
  if (typeof text !== 'string') return null;
  const t = text.trimStart();
  if (!t.startsWith(AGENT_LAUNCH)) return null;
  return t.match(AGENT_ID_RE)?.[1] ?? null;
}

// trackAgentLaunch — open a background agent from its launch receipt.
// `info` is the pending Agent call ({label, type}) when the connector saw it.
export function trackAgentLaunch(agent, text, info, ts = Date.now()) {
  const id = agentIdFromLaunch(text);
  if (!id) return false;
  const map = (agent.bgAgents ??= new Map());
  map.set(id, { label: info?.label || 'agent', type: info?.type || 'agent', startTs: ts });
  while (map.size > BG_AGENTS_MAX) map.delete(map.keys().next().value);
  return true;
}

// trackAgentEnds — close every open agent a finish notice names. An agent can
// be resumed and notify again; a repeat for a closed agent changes nothing.
export function trackAgentEnds(agent, text) {
  const map = agent.bgAgents;
  if (!map?.size) return [];
  const removed = [];
  for (const { id, status } of finishedJobs(text)) {
    const a = map.get(id);
    if (!a) continue;
    map.delete(id);
    removed.push({ id, status, label: a.label });
  }
  return removed;
}

// liveOpenAgents(bgAgents, lastGrowthOf, now, maxQuietMs) → open agents still
// believed to run, oldest first. A stop from claude's task list leaves no
// finish notice, so an open agent whose file has not grown for `maxQuietMs`
// (and that started longer ago than that) is not counted.
export function liveOpenAgents(bgAgents, lastGrowthOf, now, maxQuietMs) {
  if (!bgAgents?.size) return [];
  const out = [];
  for (const [id, a] of bgAgents) {
    let grew = 0;
    try { grew = Number(lastGrowthOf?.(id)) || 0; } catch { grew = 0; }
    if (now - Math.max(a.startTs || 0, grew) > maxQuietMs) continue;
    out.push({ id, ...a });
  }
  return out.sort((x, y) => x.startTs - y.startTs);
}

// jobsSnapshot — the open jobs, oldest first, for the card and zoom.
export function jobsSnapshot(jobs, now) {
  if (!jobs?.size) return [];
  return [...jobs.entries()]
    .map(([id, j]) => ({ id, label: j.label, elapsedMs: Math.max(0, now - j.startTs) }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}

// ── Process check (0484) ─────────────────────────────────────────────────
// claude runs each Bash command in a shell it starts as its own direct child:
//   /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-….sh … && eval '…' && pwd -P >| …
// The trailing pwd keeps that shell alive until the command ends, so a live
// job always has a live shell under claude. The snapshot path in the shell's
// arguments tells claude's Bash shells apart from its other children: an MCP
// server, or a hook's `bash <script>` (seen under another slot on
// 2026-11-17). The arguments hold the full command, so they are tested here
// and never kept or shown.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const CLAUDE_SHELL_RE = / -c source \S*\/\.claude\/shell-snapshots\/snapshot-/;

// A tracked job matches a shell that started between the job's tool_use
// (less this slack) and its receipt (plus this slack). ps reports elapsed
// time in whole seconds, so a computed start can be up to 1 s late.
const MATCH_SLACK_MS = 3000;
// An untracked shell younger than this is not shown: it may be a foreground
// command whose turn is just ending.
export const UNTRACKED_MIN_AGE_MS = 5000;

// parseEtime — ps elapsed time "[[dd-]hh:]mm:ss" → ms, or null.
export function parseEtime(text) {
  const m = String(text || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = 0, h = 0, mi, se] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se)) * 1000;
}

// parseProcessRows — `ps -A -o pid=,ppid=,etime=,comm=` → [{pid, ppid, etimeMs, comm}].
// comm is the rest of the line: a path with spaces must survive.
export function parseProcessRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etimeMs: parseEtime(m[3]), comm: m[4] });
  }
  return rows;
}

function isShell(comm) {
  const base = String(comm || '').split('/').pop().replace(/^-/, '');
  return SHELLS.has(base);
}

// shellCandidates(rows, rootPids, sampleTs) → Map(root → [{pid, startTs}]),
// the shells that are DIRECT children of each claude. A root missing from
// `rows` gets no entry: an empty or cut-short `ps` is no evidence that its
// jobs died.
export function shellCandidates(rows, rootPids, sampleTs) {
  const roots = new Set(rootPids || []);
  const out = new Map();
  for (const r of rows || []) if (roots.has(r?.pid)) out.set(r.pid, []);
  for (const r of rows || []) {
    if (!out.has(r?.ppid) || r.pid === r.ppid || !isShell(r.comm) || r.etimeMs == null) continue;
    out.get(r.ppid).push({ pid: r.pid, startTs: sampleTs - r.etimeMs });
  }
  return out;
}

// parseShellArgs — `ps -o pid=,args= -p …` → Set of pids that are claude
// Bash shells. Only the verdict leaves this function.
export function parseShellArgs(text) {
  const ok = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s(.*)$/);
    if (m && CLAUDE_SHELL_RE.test(m[2])) ok.add(Number(m[1]));
  }
  return ok;
}

// matchShells(jobs, shells, sampleStartTs) → { ended, untracked }.
//   ended      ids of tracked jobs with no live shell. A job whose receipt is
//              newer than the sample start is never ended here.
//   untracked  live shells no tracked job claims, [{pid, startTs}].
// Each job takes the unclaimed shell closest to its tool_use time inside its
// window, oldest job first.
export function matchShells(jobs, shells, sampleStartTs) {
  const free = [...(shells || [])];
  const ended = [];
  const tracked = [...(jobs?.entries?.() || [])].sort((a, b) => a[1].startTs - b[1].startTs);
  for (const [id, j] of tracked) {
    const lo = j.startTs - MATCH_SLACK_MS;
    const hi = (j.resultTs ?? j.startTs) + MATCH_SLACK_MS;
    let best = -1;
    for (let i = 0; i < free.length; i++) {
      const t = free[i].startTs;
      if (t < lo || t > hi) continue;
      if (best < 0 || Math.abs(t - j.startTs) < Math.abs(free[best].startTs - j.startTs)) best = i;
    }
    if (best >= 0) free.splice(best, 1);
    else if ((j.resultTs ?? j.startTs) + MATCH_SLACK_MS < sampleStartTs) ended.push(id);
  }
  return { ended, untracked: free };
}

// visibleJobs — what the card and zoom show, oldest first.
// Tracked jobs always show. An untracked shell shows only when
// `countUntracked`: claude's turn is over (idle or waiting) and no background
// agent is live. Then no foreground command can own a shell, so every claude
// Bash shell left is a background job. While an agent runs, its own foreground
// commands also have shells, and the card says "check back" anyway.
export function visibleJobs(tracked, untracked, { countUntracked, now }) {
  const out = [...(tracked || [])];
  if (countUntracked) {
    for (const s of untracked || []) {
      const elapsedMs = now - s.startTs;
      if (elapsedMs >= UNTRACKED_MIN_AGE_MS) out.push({ id: `pid:${s.pid}`, label: null, elapsedMs });
    }
  }
  return out.sort((a, b) => b.elapsedMs - a.elapsedMs);
}

const PS_OPTS = { timeout: 4000, maxBuffer: 8 * 1024 * 1024 };

// sampleClaudeShells(rootPids) → Map(root → [{pid, startTs}]) of claude Bash
// shells, or null on any failure (the caller then changes nothing). Two
// argv-form `ps` calls: names for every process (about 25 ms, 62 KB on
// 2026-11-17), then arguments for the few shell children only.
export async function sampleClaudeShells(rootPids, run = runPs) {
  const sampleTs = Date.now();
  const rowsText = await run(['-A', '-o', 'pid=,ppid=,etime=,comm=']);
  if (rowsText == null) return null;
  const cands = shellCandidates(parseProcessRows(rowsText), rootPids, sampleTs);
  const pids = [...cands.values()].flat().map((s) => s.pid);
  if (!pids.length) return cands;
  const argsText = await run(['-o', 'pid=,args=', '-p', pids.join(',')]);
  // ps -p exits 1 when every listed pid is gone; an empty answer is fine.
  const ok = parseShellArgs(argsText || '');
  for (const [root, list] of cands) cands.set(root, list.filter((s) => ok.has(s.pid)));
  return cands;
}

function runPs(args) {
  return new Promise((resolve) => {
    execFile('ps', args, PS_OPTS, (err, stdout) => resolve(err && !stdout ? (args[0] === '-A' ? null : '') : String(stdout || '')));
  });
}
