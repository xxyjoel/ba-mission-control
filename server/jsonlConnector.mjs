// server/jsonlConnector.mjs — pure event parser for claude's native
// session JSONL format. The PTY-canonical rewrite uses this as the
// single connector: every fleet-state field (status, activity,
// tokensIn/Out, context, costSession, tail, todos, resolvedModel,
// permissionMode) is derived from JSONL events parsed here.
//
// Stream-json had per-token deltas, an explicit `result` turn-marker,
// and a `total_cost_usd` field. JSONL has none of those. We derive
// cost from `message.usage` + the model pricing table, and we
// approximate turn boundaries via the `system/turn_duration` subtype
// (when claude writes one). Status decay is handled by callers via a
// short timer — see `sessionFileTailer.mjs` for the polling shape.
//
// This module is PURE — no file I/O, no timers, no event emission.
// `parseEvent(ev, agent)` mutates the agent fields directly and
// returns true if anything changed. Callers decide when to
// emit('change').

import { MODELS } from '../tui/lib/models.js';
import { summarizeToolInput, SUBAGENT_TOOLS, subagentLabel } from './eventShapes.mjs';
import { detectPrompt, promptFromToolUse } from './detectPrompt.mjs';
import { updateSpark } from './spark.mjs';

// Cap on tail length so memory stays flat across long sessions.
// Mirrors `TAIL_MAX` in agent.mjs.
const TAIL_MAX = 40;

// Push a tail entry without exceeding TAIL_MAX. We add ts here so
// callers don't have to. Direct array mutation rather than
// agent.appendTail() to keep this module pure (agent might be a
// plain object in tests).
function pushTail(agent, entry) {
  if (!Array.isArray(agent.tail)) agent.tail = [];
  agent.tail.push({ ...entry, ts: Date.now() });
  while (agent.tail.length > TAIL_MAX) agent.tail.shift();
}

// Track Task/Workflow tool_use → tool_result as a live pending map (NOT the
// bounded tail, which can't pair a use with its result). Keyed by tool_use_id;
// entries are added on tool_use and removed when the matching tool_result lands.
// Drives the ⋔{n} card indicator + Zoom list of active sub-agents.
function trackSubagentStart(agent, part) {
  if (!SUBAGENT_TOOLS.has(part.name) || typeof part.id !== 'string') return;
  (agent.pendingSubagents ??= new Map()).set(part.id, {
    label: subagentLabel(part.name, part.input),
    type: part.name === 'Workflow' ? 'workflow' : (part.input?.subagent_type || 'agent'),
    startTs: Date.now(),
  });
}
function trackSubagentEnd(agent, toolUseId) {
  if (typeof toolUseId === 'string') agent.pendingSubagents?.delete(toolUseId);
}

// Pull whatever text is in a claude message.content payload. The
// shape varies by event — strings in user events, arrays of
// {type:text|tool_use|...} in assistant events. Returns null when
// there's no surfaceable text.
function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const p of content) {
    if (typeof p === 'string') text += p;
    else if (p?.type === 'text' && typeof p.text === 'string') text += p.text;
    else if (p?.type === 'thinking' && typeof p.thinking === 'string') text += p.thinking;
  }
  text = text.trim();
  return text || null;
}

// First non-empty line, capped at maxLen. Used for activity preview.
function firstLine(text, maxLen = 200) {
  if (!text) return '';
  const line = text.split('\n').find((l) => l.trim()) || text;
  return line.slice(0, maxLen);
}

// deriveCost — compute a per-turn USD cost from the JSONL
// `assistant.message.usage` block + the model pricing table.
//
// Math:
//   inputPrice          × input_tokens
// + cacheCreationPrice  × cache_creation_input_tokens   (1.25 × inputPrice typical)
// + cacheReadPrice      × cache_read_input_tokens       (0.10 × inputPrice typical)
// + outputPrice         × output_tokens
// all divided by 1_000_000.
//
// Returns 0 (not null) when the model is unknown or usage is missing,
// so the caller can do `agent.costSession += deriveCost(...)` without
// guarding.
//
// modelId can be the friendly id ('opus-4.7') OR the CLI model name
// ('claude-opus-4-7') — JSONL events carry the CLI form in
// `message.model` so we accept both.
export function deriveCost(usage, modelId) {
  if (!usage || !modelId) return 0;
  const m = MODELS[modelId] || lookupByCliModel(modelId);
  if (!m) return 0;
  const inTok = usage.input_tokens || 0;
  const ccTok = usage.cache_creation_input_tokens || 0;
  const crTok = usage.cache_read_input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return (
    inTok  * (m.costPerMTokIn || 0) +
    ccTok  * (m.costPerMTokCacheCreation || (m.costPerMTokIn || 0) * 1.25) +
    crTok  * (m.costPerMTokCacheRead     || (m.costPerMTokIn || 0) * 0.10) +
    outTok * (m.costPerMTokOut || 0)
  ) / 1_000_000;
}

function lookupByCliModel(cliModel) {
  for (const m of Object.values(MODELS)) {
    if (m.cliModel === cliModel) return m;
  }
  return null;
}

// parseEvent — interpret one JSONL event and mutate agent state.
// Returns true if anything material changed (caller should emit
// 'change' if true). Unknown/noise events return false silently.
//
// Mutations are confined to fields that agent.toJSON() exposes, so
// the existing 100+ UI read sites keep working unchanged. Match the
// stream-json #handle() contract from agent.mjs so swap is
// behavior-preserving.
export function parseEvent(ev, agent) {
  if (!ev || typeof ev !== 'object' || !ev.type) return false;
  agent.lastEventTs = Date.now();
  // 0229-fix: JSONL-only activity clock. Unlike lastEventTs (also bumped by the
  // PTY onData handler on EVERY byte, incl. cosmetic repaints — the "update
  // available" banner, health chip, spinner), this advances ONLY on a parsed
  // JSONL event. toJSON()'s hook-vs-connector freshness merge compares against
  // THIS, so terminal chatter can't keep the connector looking "fresher" than a
  // real Stop hook and pin an idle card to 'working' (found in real-app verify).
  agent.lastConnectorTs = Date.now();

  switch (ev.type) {
    case 'user':              return handleUser(ev, agent);
    case 'assistant':         return handleAssistant(ev, agent);
    case 'system':            return handleSystem(ev, agent);
    case 'permission-mode':   return handlePermissionMode(ev, agent);

    // Noise we intentionally drop. Cataloged so future contributors
    // know they were considered.
    case 'ai-title':                return false;
    case 'last-prompt':              return false;
    case 'attachment':               return false;
    case 'file-history-snapshot':    return false;
    case 'queue-operation':          return false;
    case 'agent-name':               return false;
    default:                         return false;
  }
}

function handleUser(ev, agent) {
  const content = ev.message?.content;

  // Tool results land as user events with array content carrying
  // {type:'tool_result', tool_use_id, content}. Surface those as
  // 'sys' entries so Ctrl+T sees the round-trip.
  if (Array.isArray(content)) {
    let changed = false;
    for (const p of content) {
      if (p?.type === 'tool_result') {
        trackSubagentEnd(agent, p.tool_use_id);
        const text = typeof p.content === 'string'
          ? p.content
          : Array.isArray(p.content) ? p.content.map(c => c.text || '').join('\n') : '';
        pushTail(agent, {
          kind: 'sys',
          text: `← tool_result ${p.is_error ? '(error)' : ''}\n${text.slice(0, 4000)}`,
          preview: `← tool_result ${p.is_error ? '(error)' : ''} ${text.slice(0, 160).replace(/\s+/g, ' ')}`,
        });
        changed = true;
      }
    }
    if (changed) {
      // A tool_result means claude received what it was blocked on — either a
      // tool's output OR the user's answer to AskUserQuestion / a plan
      // approval — and is now processing it, i.e. working again. Without this,
      // a card sat on 'waiting' (INPUT) from when the question was asked until
      // claude's NEXT assistant record landed — observed ~14s of stale "INPUT
      // shows after I already answered". Clearing awaitingPrompt drops the
      // chips at the same instant.
      agent.status = 'working';
      agent.awaitingPrompt = null;
    }
    return changed;
  }

  // Plain user prompt.
  const text = extractMessageText(content);
  if (!text) return false;

  // /clear resets the conversation. It arrives as a user message wrapped in
  // `<command-name>/clear</command-name>` (the local_command system event only
  // carries stdout, so it can't be detected there). Reset the ctx gauge AND the
  // per-session consumption summaries: a clear starts a fresh conversation, so
  // in/out/cost no longer describe what's on screen and re-accumulate from 0 on
  // the next turn. Lifetime totals survive only a proper quit+save, never /clear.
  if (/<command-name>\s*\/clear\b/.test(text)) {
    agent.context = 0;
    agent.tokensIn = 0;
    agent.tokensCacheRead = 0;
    agent.tokensOut = 0;
    agent.costSession = 0;
    agent.pendingSubagents?.clear();
    agent.activity = '';
    agent.status = 'idle';
    pushTail(agent, { kind: 'sys', text: 'context cleared (/clear)' });
    return true;
  }

  pushTail(agent, { kind: 'user', text: text.slice(0, 8000), preview: firstLine(text, 240) });
  agent.messageCount = (agent.messageCount || 0) + 1;
  agent.status = 'working';
  agent.activity = firstLine(text, 200);
  return true;
}

function handleAssistant(ev, agent) {
  const msg = ev.message;
  if (!msg) return false;
  let changed = false;

  // Resolved model name — claude reports the resolved cli model in
  // every assistant event. Capture on the first one so the card can
  // surface alias drift.
  if (msg.model && agent.resolvedModel !== msg.model) {
    agent.resolvedModel = msg.model;
    changed = true;
  }

  const parts = Array.isArray(msg.content) ? msg.content : [];
  // Track the last assistant text in this message so an end_turn can be
  // classified as a question/needs-input prompt (→ 'waiting') below.
  let lastText = '';
  // A human-blocking tool_use (AskUserQuestion / ExitPlanMode) means claude
  // is BLOCKED on the user even though stop_reason is 'tool_use', not
  // 'end_turn'. When set, it overrides the working/idle logic → 'waiting'.
  let blockingPrompt = null;
  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      const text = p.text;
      lastText = text;
      pushTail(agent, {
        kind: 'asst',
        text: text.slice(0, 8000),
        preview: firstLine(text, 240),
      });
      agent.activity = firstLine(text, 200);
      changed = true;
    } else if (p.type === 'thinking' && p.thinking) {
      pushTail(agent, {
        kind: 'think',
        text: p.thinking.slice(0, 8000),
        preview: firstLine(p.thinking, 240),
      });
      changed = true;
    } else if (p.type === 'tool_use' && typeof p.name === 'string') {
      const summary = summarizeToolInput(p.name, p.input);
      pushTail(agent, { kind: 'tool', tool: p.name, text: summary });
      agent.activity = `${p.name}: ${summary}`.slice(0, 200);
      trackSubagentStart(agent, p);
      // Does this tool block on the user? (AskUserQuestion / ExitPlanMode)
      const tp = promptFromToolUse(p.name, p.input);
      if (tp) blockingPrompt = tp;
      // TodoWrite snapshot — same shape as the stream-json branch
      // in agent.mjs.
      if (p.name === 'TodoWrite' && Array.isArray(p.input?.todos)) {
        agent.todos = p.input.todos
          .filter((t) => t && typeof t.content === 'string')
          .map((t) => ({
            content: String(t.content).slice(0, 200),
            status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
            activeForm: typeof t.activeForm === 'string' ? t.activeForm.slice(0, 200) : '',
          }));
      }
      changed = true;
    }
  }

  // Token + cost accounting from `usage`. JSONL events carry the
  // same shape as stream-json (`input_tokens`, `cache_creation_input_tokens`,
  // `cache_read_input_tokens`, `output_tokens`).
  const u = msg.usage;
  if (u) {
    // Fresh input (input + cache_creation) is counted separately from cache
    // reads: cache_read_input_tokens re-counts the same context window on every
    // message, so folding it into tokensIn inflates the headline ~100x.
    const incIn    = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const incCache = u.cache_read_input_tokens || 0;
    const incOut   = u.output_tokens || 0;
    if (incIn)    agent.tokensIn        = (agent.tokensIn        || 0) + incIn;
    if (incCache) agent.tokensCacheRead = (agent.tokensCacheRead || 0) + incCache;
    if (incOut)   agent.tokensOut       = (agent.tokensOut       || 0) + incOut;
    // Context = the live conversation window, which is ONLY the main thread.
    // Sub-agent (Task) turns carry `isSidechain:true` and their own, smaller
    // `usage` — letting one overwrite agent.context makes the ctx gauge dive to
    // the sub-agent's size mid-turn. Current claude writes sidechains to a
    // separate subagents/*.jsonl the tailer never reads, so this is defensive,
    // but it keeps the gauge correct if an inline sidechain ever reaches us.
    if (!ev.isSidechain && u.input_tokens != null) agent.context = incIn + incCache;
    agent.costSession = (agent.costSession || 0) + deriveCost(u, msg.model);
    // tok/min sparkline — the PTY pipeline used to skip this entirely, so
    // the fleet t/min readout was a constant ~8000/agent (#26). Same
    // normalizer as agent.mjs via server/spark.mjs.
    updateSpark(agent, incIn + incCache + incOut);
    changed = true;
  }

  // stop_reason='end_turn' means the turn finished. But "finished" splits
  // two ways: claude answered (→ 'idle'), or claude asked the user a
  // question / posed an option list and is BLOCKED on their reply
  // (→ 'waiting', a.k.a. needs-input). Without this, the PTY pipeline only
  // ever produced working/idle/error and the 'waiting' state never showed
  // on a card. detectPrompt is the same conservative classifier the
  // stream-json path uses (agent.mjs); awaitingPrompt is stored so the
  // Zoom modal can render selectable chips. tool_use (no end_turn) means
  // claude wants to run another tool — stay 'working'.
  if (blockingPrompt) {
    // A tool that blocks on the user (e.g. AskUserQuestion) — claude is
    // 'waiting', not 'working', even though this isn't an end_turn.
    agent.awaitingPrompt = blockingPrompt;
    agent.status = 'waiting';
  } else if (msg.stop_reason === 'end_turn') {
    const prompt = detectPrompt(lastText);
    agent.awaitingPrompt = prompt || null;
    agent.status = prompt ? 'waiting' : 'idle';
  } else {
    agent.status = 'working';
  }
  return changed;
}

function handleSystem(ev, agent) {
  const sub = ev.subtype;
  if (sub === 'api_error') {
    // A JSONL api_error is claude's TRANSIENT-retry signal: it carries
    // retryAttempt/maxRetries and a cause code (ECONNRESET, overloaded, …)
    // and claude keeps working through the retry. Flipping the card to a
    // terminal 'error' on every one of these made active sessions flash red
    // while they were merely retrying (user-reported; 1200+ transient
    // ECONNRESETs seen across the on-disk session logs). Stay 'working'
    // until retries are actually exhausted; genuine terminal failure surfaces
    // separately via PTY exit → ptyAgent.#onExit (auto-restart, then 'error').
    const attempt = Number(ev.retryAttempt) || 0;
    const max = Number(ev.maxRetries) || 0;
    const code = ev.error?.cause?.code || ev.cause?.code || ev.error?.type || '';
    // Track api-error rate so the fleet header can show a "N retrying (api)"
    // heartbeat — transport noise (ECONNRESET/502) that claude auto-retries,
    // so the user reads it as retrying, not as failed work.
    agent.apiErrorCount = (agent.apiErrorCount || 0) + 1;
    agent.lastApiErrorTs = Date.now();
    if (max > 0 && attempt >= max) {
      // Retries exhausted — a real, terminal error. Red 'err' line + errored card.
      pushTail(agent, {
        kind: 'err',
        text: `api error${code ? ' · ' + code : ''} — retries exhausted (${attempt}/${max})`,
      });
      agent.status = 'error';
    } else {
      // Still retrying — claude is alive and working. Emit a CALM 'sys' line, not
      // a red 'err' one: a transient ECONNRESET/overload claude auto-retries isn't
      // failed work, and painting every one red flooded the log with alarming
      // "api error" lines (1200+ ECONNRESETs seen in a single session). The retry
      // also shows in the activity line so the card explains the slowdown.
      pushTail(agent, {
        kind: 'sys',
        text: `api retry${code ? ' · ' + code : ''}${attempt ? ` (${attempt}/${max || '?'})` : ''}`,
      });
      agent.status = 'working';
      agent.activity = `retrying api · ${code || 'error'} ${attempt || '?'}/${max || '?'}`.slice(0, 200);
    }
    return true;
  }
  if (sub === 'turn_duration') {
    // claude marks the end of a turn with this; align status to idle
    // so the card doesn't sit on 'working' forever. Per-call boundary —
    // matches the `result` event on the stream-json pipeline, so this
    // is the canonical turnCount increment point on the PTY path.
    agent.turnCount = (agent.turnCount || 0) + 1;
    agent.status = 'idle';
    return true;
  }
  if (sub === 'compact_boundary') {
    // /compact summarized the conversation — context just dropped sharply. We
    // don't know the post-compact size until the next turn's `usage`, so reset
    // the ctx gauge to 0 now (it self-corrects on the next turn) rather than
    // leaving it pinned at the stale pre-compact value. `agent.context` is the
    // ONLY source of the ctx bar (set from usage.input_tokens elsewhere), so
    // without this the bar didn't move on /compact.
    const pre = ev.compactMetadata?.preTokens;
    agent.context = 0;
    pushTail(agent, { kind: 'sys', text: `context compacted${pre ? ` (was ${Math.round(pre / 1000)}k)` : ''}` });
    return true;
  }
  if (sub === 'local_command' && ev.content) {
    // The user ran a slash or `!`-shell command inside claude.
    // Surface so the FleetLog has visibility.
    const raw = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content);
    pushTail(agent, { kind: 'sys', text: `! ${raw.slice(0, 4000)}` });
    // NOTE: /clear is NOT detected here. This `local_command` system event's
    // `content` is only the command's STDOUT (`<local-command-stdout>…`), never
    // the command name. /clear arrives as a `type:"user"` message wrapped in
    // `<command-name>/clear</command-name>` and is handled in handleUser().
    return true;
  }
  // stop_hook_summary and away_summary are housekeeping; ignore.
  return false;
}

function handlePermissionMode(ev, agent) {
  if (typeof ev.permissionMode !== 'string') return false;
  if (agent.permissionMode === ev.permissionMode) return false;
  agent.permissionMode = ev.permissionMode;
  pushTail(agent, { kind: 'sys', text: `permission mode → ${ev.permissionMode}` });
  return true;
}
