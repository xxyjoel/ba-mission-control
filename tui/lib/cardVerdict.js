// tui/lib/cardVerdict.js — the card's "jump in?" answer (0487).
//
// The owner, 2026-11-17: "i need to know when it makes sense to jump into a
// session and continue working. clicking into a card because i thought it
// was done and it turns out there are still tasks left is a bad user
// experience." The card answers in two rows:
//   status row  what claude itself is doing (WORKING, INPUT?, IDLE …) — one
//               word, never mixed with background work (0418)
//   triage row  the verdict: does this slot need you, and what to do
//   ↳ row       the background work still running: agents, jobs, oldest age
//
// Pure: everything comes from the snapshot fields the card already reads.

import { fmtDurShort } from './format.js';

// fmtAge — a duration for the ↳ row. Days past 24 hours, so a job left
// running over a weekend reads 2d18h, not 66h24m.
export function fmtAge(ms) {
  const h = Math.floor(Math.max(0, ms || 0) / 3_600_000);
  if (h < 24) return fmtDurShort(ms);
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// triageVerdict → { action, tone }. tone is one of 'red' | 'yellow' |
// 'green' | 'dim' (the card maps it to theme colors).
//   red     needs you now
//   yellow  needs you soon, or something looks wrong
//   green   done: your turn
//   dim     leave it alone for now
// Order matters: a question waiting for you wins over background work, and
// background work wins over every "done" verdict.
export function triageVerdict({ status, approval = false, stuckMin = 0, bgLive = false, jobCount = 0, todoTotal = 0, todoDone = 0 }) {
  if (status === 'error') return { action: 'errored · see log', tone: 'red' };
  if (status === 'paused') return { action: 'paused', tone: 'dim' };
  if (status === 'waiting') {
    return approval
      ? { action: 'needs approval · answer to proceed', tone: 'red' }
      : { action: 'needs input · answer to continue', tone: 'yellow' };
  }
  if (status === 'working') {
    // stuckMin is set only for a working slot with no real event for 5+ min;
    // the status row already says STUCK Nm.
    if (stuckMin > 0) return { action: 'take a look →', tone: 'yellow' };
    // 0386: with no plan, the row stays blank — the status row already says
    // WORKING. With a plan, "check back" sits beside the burndown bar.
    return { action: todoTotal > 0 ? 'check back' : '', tone: 'dim' };
  }
  if (status !== 'idle') return { action: '', tone: 'dim' };
  // Idle: claude's own turn is over. Background work means "not yet" — the
  // same verb as working, and the ↳ row says what is still running.
  if (bgLive || jobCount > 0) return { action: 'check back', tone: 'dim' };
  if (todoTotal > 0 && todoDone >= todoTotal) return { action: 'ready to review →', tone: 'green' };
  if (todoTotal > 0) return { action: 'needs a nudge →', tone: 'yellow' };
  // Nothing running, no plan left open: the session is waiting on you.
  return { action: 'your turn →', tone: 'green' };
}

// backgroundRowText → the ↳ row, or '' when nothing runs in the background.
// Counts come first so a narrow card truncates the names, never the numbers.
//   agents   [{label}] — the named background agents (may be shorter than
//            agentCount when some are known only from their files)
//   agentCount  a number, or null when work is live but not countable
//   jobs     [{label, elapsedMs}] oldest first; label null = unnamed
export function backgroundRowText({ agents = [], agentCount = 0, bgLive = false, jobs = [], humanize = (s) => s }) {
  const nAgents = agentCount == null ? null : Math.max(agentCount || 0, agents.length);
  const nJobs = jobs.length;
  const oldest = nJobs ? fmtAge(jobs[0].elapsedMs) : '';
  const agentsLive = nAgents == null ? bgLive : nAgents > 0;
  if (nJobs > 0 && agentsLive) {
    const a = nAgents == null ? '⋔ agents' : `⋔${plural(nAgents, 'agent')}`;
    return `${a} · ${plural(nJobs, 'job')} · ${oldest}`;
  }
  if (nJobs === 1) {
    const label = jobs[0].label ? humanize(String(jobs[0].label)) : null;
    return label ? `job ${oldest}: ${label}` : `1 job · ${oldest}`;
  }
  // Short enough that the age survives the narrowest card (34 columns leave
  // 28 for this row): "2 jobs · oldest 2d18h".
  if (nJobs > 1) return `${nJobs} jobs · oldest ${oldest}`;
  if (nAgents === 1 && agents.length === 1) return `⋔ ${humanize(String(agents[0].label || 'agent'))}`;
  if (nAgents > 0) return `⋔${nAgents} agents running`;
  if (agentsLive) return '⋔ background agents running';
  return '';
}
