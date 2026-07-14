// server/agent.mjs — wraps a single `claude` CLI subprocess for one slot.
//
// We use claude's stream-json protocol on both sides:
//   --input-format  stream-json   (we write {"type":"user",...} JSON lines to stdin)
//   --output-format stream-json   (we read JSON event lines from stdout)
//   --include-partial-messages    (we get text deltas for live activity)
//   --session-id <uuid>           (stable id for resume across respawns)
//
// State the UI cares about (status, tokens, context, cost, activity, tail, spark)
// is derived from those events. Pause/Resume use POSIX signals so the child
// process is actually frozen — not just hidden from the UI.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeToolInput as summarizeToolInputShape, SUBAGENT_TOOLS, subagentLabel } from './eventShapes.mjs';
import { fullStatus } from './git.mjs';
import { claudeSessionPath } from './sessionFileTailer.mjs';
import { MODELS } from '../tui/lib/models.js';
import { detectPrompt } from './detectPrompt.mjs';
import { updateSpark } from './spark.mjs';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TAIL_MAX = 40;
const SPARK_LEN = 15;

// On-disk transcript directory. Each session's raw event stream lands at
// <TRANSCRIPT_DIR>/<sessionId>.jsonl — JSONL of every inbound claude event
// + every outbound user message. Survives across process restarts, slot
// reassignments, and reboots. Set MC_NO_TRANSCRIPT=1 to disable.
const TRANSCRIPT_DIR = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'claude-mc',
  'sessions',
);
const TRANSCRIPT_DISABLED = process.env.MC_NO_TRANSCRIPT === '1';

// Exported so the TUI's `:transcript` verb can tell the user exactly
// where their session's persistent log lives. Pure path math; no I/O.
export function transcriptPathFor(sessionId) {
  if (!sessionId) return null;
  return join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
}
export const TRANSCRIPT_BASE_DIR = TRANSCRIPT_DIR;

// Map the UI's friendly model ids ('opus-4.8', 'sonnet-4.6', …) to the
// CLI's --model values ('claude-opus-4-8', …). Derived from the single
// source of truth in tui/lib/models.js so a new model added to the UI
// catalog can't accidentally fall through to the literal id (which the
// CLI rejects — that's the "opus-4.8 doesn't work" regression we hit
// when this map was a hand-maintained duplicate).
const MODEL_ARG = Object.fromEntries(
  Object.entries(MODELS).map(([id, m]) => [id, m.cliModel])
);

// detectPrompt + its option-parsing helpers now live in
// ./detectPrompt.mjs so the PTY pipeline (jsonlConnector.mjs) can share
// the exact same classifier without a circular import. Re-exported here
// for back-compat with importers that still pull it from agent.mjs (e.g.
// tests/detectPrompt.test.mjs) — same pattern as summarizeToolInput below.
export { detectPrompt };

// Exported so server/sessionFileTailer.mjs can produce identical tail
// entries from JSONL events as the live stream-json parser does — keeps
// the OPEN TASKS / tools-summary panels coherent across zoom enter/exit.
// Re-exported from server/eventShapes.mjs to keep backward compat with
// any external importer; the canonical home is now eventShapes so the
// PTY-canonical rewrite can share it without circular imports.
export const summarizeToolInput = summarizeToolInputShape;

export class Agent extends EventEmitter {
  constructor({ slot, id, name, cwd, branch, model = 'sonnet-4.5', permissionMode = 'acceptEdits', sessionId, resume = false }) {
    super();
    this.slot = slot;
    this.id = id || `slot-${slot}`;
    this.name = name;
    this.cwd = cwd;
    this.branch = branch;
    this.model = model;
    // Ground-truth model claude actually resolved our --model arg to,
    // captured from the first system/init event. Stays null until that
    // event lands; once set, the Card / Zoom prefer it over the
    // user-requested `model` so a wrong alias is immediately visible.
    this.resolvedModel = null;
    this.permissionMode = permissionMode;
    // When `sessionId` is passed by the caller we reuse it instead of
    // minting a new UUID — that's what lets a relaunched process pick up
    // the prior conversation transcript from claude's own on-disk store.
    this.sessionId = sessionId || randomUUID();
    this.resuming = !!resume;

    // UI-visible state
    // Initialize workingStartTs BEFORE the status setter fires so the
    // first transition's bookkeeping is well-defined. The setter (below)
    // anchors / clears this timestamp on any status change.
    this.workingStartTs = null;
    // stateSince: anchor for "time in current state" — refreshed by the
    // status setter on every transition (including into the initial 'idle').
    this.stateSince = Date.now();
    // spawnedAt: when THIS session began. Set once in the constructor;
    // intentionally NOT reset on auto-restart / respawn so per-agent
    // session lifetime stays continuous from the user's perspective.
    this.spawnedAt = Date.now();
    // Session-wide counters. turnCount increments on each `result` event
    // (one per user → claude round trip). messageCount increments on each
    // user message actually written to claude's stdin. Both survive
    // respawn so a /compact-restart doesn't reset the user-facing count.
    this.turnCount = 0;
    this.messageCount = 0;
    this.status = 'idle';              // 'idle' | 'working' | 'waiting' | 'paused' | 'error' | 'empty'
    this.context = 0;                  // last-seen total context size (input tokens of latest assistant msg)
    this.tokensIn = 0;                 // cumulative FRESH input (input + cache_creation)
    this.tokensCacheRead = 0;          // cumulative cache_read — the context re-read
                                       // from cache each turn. Broken out because it
                                       // re-counts the same window every message and
                                       // would otherwise dwarf tokensIn ~100x.
    this.tokensOut = 0;
    this.costSession = 0;
    // In-flight Task/Workflow fan-out — Map<tool_use_id,{label,type,startTs}>,
    // surfaced as activeSubagents in toJSON for the ⋔{n} card indicator.
    this.pendingSubagents = new Map();
    // costWeek is owned by tui/lib/costStore.js (per-run ISO-week bucket
    // persisted to disk). The TUI overlays the persisted value onto each
    // snapshot, so we don't track it here.
    this.dirty = 0;
    this.ahead = 0;
    this.behind = 0;
    this.spark = Array(SPARK_LEN).fill(1);
    this.activity = 'Awaiting first instruction';
    this.tail = [];
    // Live snapshot of the assistant's current to-do plan. Updated when
    // claude calls the TodoWrite tool; each entry is { content, status,
    // activeForm } where status is 'pending' | 'in_progress' | 'completed'.
    // Surfaced verbatim in the Zoom modal so the user sees the same task
    // tracker the assistant is working from.
    // TODO(zoom-todos-live): while the Zoom modal is active the stream-json
    // agent is SIGSTOP'd, so todos written by the PTY child don't reach
    // this field until SIGCONT. Tail ~/.claude/projects/<encoded-cwd>/
    // <sessionId>.jsonl during zoom for live updates.
    this.todos = [];

    // Internals
    this.proc = null;
    this.buffer = '';
    this.lastTokRate = 0;
    this.lastTokSampleTs = Date.now();
    this.lastTokSampleVal = 0;
    this.killed = false;
    // Last observable event from the claude subprocess (any stream event,
    // assistant msg, tool call, or result). Used by toJSON() to surface
    // `stuckMin` — a slot that's "working" but hasn't emitted in N
    // minutes is the canonical silent-failure mode.
    this.lastEventTs = Date.now();

    // Lazy-opened WriteStream for the on-disk transcript. Opened on the
    // first event we want to record so we don't create empty files for
    // slots that never produce traffic. Closed on kill().
    this.transcriptStream = null;

    // Auto-restart bookkeeping. We retry up to RESTART_MAX times with
    // exponential backoff (1s, 2s, 4s). The counter is reset whenever
    // the spawned process emits a proof-of-life event (its first
    // 'system'/'init'), so a recovered session is eligible for retries
    // again on its NEXT independent failure.
    this.restartCount = 0;
    this.restartTimer = null;

    // Per-slot cost cap in USD. 0 = disabled. When the slot's
    // costSession reaches this number, send() refuses further messages
    // and surfaces the cap in the card tail. Settable via the fleet
    // (so the TUI can drive it from settings); raisable per-slot via
    // the :cap command bar entry.
    this.costCapUSD = 0;

    // Respawn-race bookkeeping (audit #126). When send() detects a dead
    // proc it calls start() to respawn — but start() is async (the new
    // claude subprocess takes time to spawn and produce its 'init' event).
    // If another send() arrives before init lands, the OLD design would
    // either (a) miss the dead-proc check (this.proc is set to the new
    // proc but stdin not yet writable) or (b) call start() AGAIN, leaking
    // a second subprocess. Fix: a single `respawning` flag gates start()
    // calls; messages that arrive during respawn queue into pendingSends
    // and drain on init.
    this.respawning = false;
    this.pendingSends = [];

    // Stream-throttle bookkeeping. Claude emits 1 stream_event per token
    // for fast responses; emitting 'change' that often re-renders Ink
    // hundreds of times a second and the user perceives lag (the lag
    // *is* the queue of pending renders).
    //
    // Pattern (from the leaked claude-code REPL.tsx): defer change
    // emissions inside a 50ms window, but flush immediately when a
    // newline arrives so the user sees text materialize line-by-line.
    // State-change events (assistant, user, tool, result, etc.) bypass
    // this and emit synchronously.
    this._changeTimer = null;
  }

  // `status` is exposed as an accessor so any `this.status = next` (here
  // or in future code paths) automatically anchors `workingStartTs` on
  // the transition into 'working' and clears it on the way out. The
  // spinner in Zoom needs a stable start anchor (per the prompt UX
  // plan) — doing it via accessor keeps each individual assignment site
  // unchanged and avoids spreading the bookkeeping across the file.
  get status() { return this._statusValue || 'idle'; }
  set status(next) {
    const prev = this._statusValue;
    if (prev === next) return;
    this._statusValue = next;
    // stateSince anchors the "time in current state" metric.
    // Refreshed on every real transition (the prev===next guard above
    // means a no-op assignment doesn't reset the clock).
    this.stateSince = Date.now();
    if (next === 'working') {
      if (!this.workingStartTs) this.workingStartTs = Date.now();
    } else {
      this.workingStartTs = null;
    }
  }

  // Schedule a coalesced 'change' emit within the throttle window. If a
  // timer is already pending we let it expire; multiple deltas in the
  // same window collapse into a single render.
  #scheduleChange() {
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.emit('change');
    }, 50);
  }

  // Force-flush a pending coalesced change (drop the timer + emit now).
  // Called when we cross a meaningful boundary (newline in stream, turn
  // complete, status change) so updates feel instant at semantic edges
  // even with the throttle in place.
  #flushChange() {
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
    }
    this.emit('change');
  }

  // Append a JSONL record to the on-disk transcript. Lazy-opens the
  // stream on first write. All errors are swallowed — transcript loss
  // must NOT break the live session; the in-memory tail is the source
  // of truth for what the user sees.
  //
  // Record shape (one JSON object per line):
  //   { ts, source: 'inbound'|'outbound'|'local', ...payload }
  //     inbound  → { event: <raw claude event> }
  //     outbound → { text: <user message we sent> }
  //     local    → { tailEntry: <synthesized tail row> }
  #writeTranscript(record) {
    if (TRANSCRIPT_DISABLED) return;
    try {
      if (!this.transcriptStream) {
        mkdirSync(TRANSCRIPT_DIR, { recursive: true });
        this.transcriptStream = createWriteStream(
          join(TRANSCRIPT_DIR, `${this.sessionId}.jsonl`),
          { flags: 'a' },
        );
        // Header record so a fresh `.jsonl` is self-describing if a user
        // greps a few of these and wants to know which slot is which.
        this.transcriptStream.write(JSON.stringify({
          ts: Date.now(),
          source: 'local',
          tailEntry: { kind: 'sys', text: `transcript opened · slot=${this.slot} model=${this.model} cwd=${this.cwd}` },
        }) + '\n');
      }
      this.transcriptStream.write(JSON.stringify({ ts: Date.now(), ...record }) + '\n');
    } catch {
      // Disk errors are non-fatal; drop the entry and continue.
    }
  }

  start() {
    const modelArg = MODEL_ARG[this.model] || this.model;
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', modelArg,
      '--permission-mode', this.permissionMode,
      '--add-dir', this.cwd,
    ];
    if (this.resuming) {
      // Resume an existing transcript by UUID. claude restores prior
      // context from its on-disk session store at
      // ~/.claude/projects/<encoded-cwd>/<sid>.jsonl. If that file
      // doesn't exist (e.g. a respawn fires before the previous run
      // ever completed a turn, or the PTY zoom child wrote under a
      // claude-minted id rather than ours), --resume errors with
      // "No conversation found with session ID …" and we burn through
      // the auto-restart budget pointlessly. Fall back to
      // --session-id so the respawn starts fresh under the same id.
      const sessionFile = claudeSessionPath({ cwd: this.cwd, sessionId: this.sessionId });
      if (existsSync(sessionFile)) {
        args.push('--resume', this.sessionId);
      } else {
        this.resuming = false;
        args.push('--session-id', this.sessionId);
      }
    } else {
      args.push('--session-id', this.sessionId);
    }
    this.proc = spawn(CLAUDE_BIN, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kind = this.resuming ? 'resume' : 'spawn';
    this.appendTail({ kind: 'sys', text: `${kind} pid=${this.proc.pid} model=${modelArg} cwd=${this.cwd}${this.resuming ? ` session=${this.sessionId.slice(0,8)}` : ''}` });

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.appendTail({ kind: 'err', text });
    });
    this.proc.on('exit', (code, signal) => this.#onExit(code, signal));
    this.proc.on('error', (err) => {
      this.appendTail({ kind: 'err', text: `spawn error: ${err.message}` });
      this.status = 'error';
      this.emit('change');
    });

    this.refreshGit().catch(() => {});
    this.emit('change');
  }

  async refreshGit() {
    const st = await fullStatus(this.cwd);
    if (!st.isRepo) return;
    if (st.branch) this.branch = st.branch;
    this.dirty = st.dirty;
    this.ahead = st.ahead;
    this.behind = st.behind;
    this.emit('change');
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) {
        this.appendTail({ kind: 'err', text: `bad event: ${line.slice(0, 120)}` });
        continue;
      }
      this.#handle(ev);
    }
  }

  #handle(ev) {
    // Any event from the subprocess is proof of life — refresh the
    // liveness marker before classifying. Even the bookkeeping
    // 'system'/'result' events count, since they indicate the proc is
    // still draining its end of the pipe.
    this.lastEventTs = Date.now();
    // Capture the raw event verbatim before our handling logic
    // truncates / classifies it — preserves full fidelity for replay.
    this.#writeTranscript({ source: 'inbound', event: ev });

    // System init: attach + tool list.
    //
    // Capture the canonical session UUID from claude. In -p stream-json
    // mode claude mints its own ID and only loosely honors --session-id,
    // so we always overwrite ours from the first init event. This is
    // what makes `claude --resume <id>` actually find the conversation
    // later (via ~/.claude/projects/<encoded-cwd>/<id>.jsonl).
    if (ev.type === 'system' && ev.subtype === 'init') {
      const realId = ev.sessionId || ev.session_id;
      if (realId && realId !== this.sessionId) {
        this.sessionId = realId;
      }
      // Proof of life — reset the restart counter so the NEXT
      // independent failure gets the full retry budget again.
      if (this.restartCount > 0) {
        this.appendTail({ kind: 'sys', text: `auto-restart succeeded after ${this.restartCount} attempt${this.restartCount === 1 ? '' : 's'}` });
        this.restartCount = 0;
      }
      // Capture claude's resolved model so the UI displays what the
      // SUBPROCESS is actually running, not just what mc asked for.
      if (ev.model) this.resolvedModel = ev.model;
      this.appendTail({ kind: 'sys', text: `init · model=${ev.model || this.model} · session=${this.sessionId.slice(0, 8)}` });
      // Clear the respawn flag + drain any queued send()s now that the
      // proc is confirmed alive. Doing this before the emit('change')
      // means the snapshot includes the drained-message tail entries.
      if (this.respawning) {
        this.respawning = false;
        this.#drainPendingSends();
      }
      this.emit('change');  // snapshot is now stale — push the corrected id
      return;
    }

    // Streaming partials: keep the activity line lively while a turn runs.
    // Throttle re-renders — emit immediately on newlines (so the UI
    // updates line-by-line), otherwise coalesce within a 50ms window.
    if (ev.type === 'stream_event' && ev.event) {
      const sub = ev.event;
      if (sub.type === 'content_block_delta' && sub.delta?.type === 'text_delta' && sub.delta.text) {
        const text = sub.delta.text;
        this.activity = (this.activity + text).slice(-160);
        this.status = 'working';
        if (text.includes('\n')) this.#flushChange();
        else this.#scheduleChange();
      }
      return;
    }

    // Assistant message (text or tool_use)
    if (ev.type === 'assistant' && ev.message) {
      // Claude stamps the model it actually ran on EVERY assistant message.
      // Track it here (not just on init) so a mid-session `/model` switch —
      // or a resumed session whose real model differs from init — is
      // reflected on the card. See modelByCli()/resolvedModel contract in
      // tui/lib/models.js.
      if (ev.message.model) this.resolvedModel = ev.message.model;
      const parts = ev.message.content || [];
      let sawConfirmation = false;
      for (const p of parts) {
        if (p.type === 'text' && p.text) {
          // Keep the full assistant response (capped) so the Zoom log can
          // wrap and show multi-paragraph answers. The card view still
          // shows a single-line preview via wrap="truncate" in its render.
          const first = p.text.split('\n').find((l) => l.trim()) || p.text;
          this.activity = first.slice(0, 200);
          const awaitingPrompt = detectPrompt(p.text);
          if (awaitingPrompt) sawConfirmation = true;
          // `awaiting` is kept as a derived boolean for any older consumer
          // that still reads it; new code should use `awaitingPrompt.kind`.
          this.appendTail({
            kind: 'asst',
            text: p.text.slice(0, 8000),
            preview: first.slice(0, 240),
            awaiting: !!awaitingPrompt,
            awaitingPrompt,
          });
        } else if (p.type === 'thinking' && p.thinking) {
          // Extended-thinking block. Persist for the Zoom modal so the
          // user can see what the model deliberated on; Card.jsx ignores
          // 'think' entries to avoid clutter in the 3-line tile preview.
          const text = p.thinking;
          this.appendTail({
            kind: 'think',
            text: text.slice(0, 8000),
            preview: (text.split('\n').find(l => l.trim()) || '').slice(0, 240),
          });
        } else if (p.type === 'tool_use') {
          const summary = summarizeToolInput(p.name, p.input);
          this.appendTail({ kind: 'tool', tool: p.name, text: summary });
          this.activity = `${p.name}: ${summary}`.slice(0, 200);
          if (SUBAGENT_TOOLS.has(p.name) && typeof p.id === 'string') {
            this.pendingSubagents.set(p.id, {
              label: subagentLabel(p.name, p.input),
              type: p.name === 'Workflow' ? 'workflow' : (p.input?.subagent_type || 'agent'),
              startTs: Date.now(),
            });
          }
          // TodoWrite carries the assistant's full to-do plan. Snapshot
          // it on every call so the Zoom modal can render the same
          // tracker the assistant is working from.
          if (p.name === 'TodoWrite' && Array.isArray(p.input?.todos)) {
            this.todos = p.input.todos
              .filter(t => t && typeof t.content === 'string')
              .map(t => ({
                content: String(t.content).slice(0, 200),
                status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
                activeForm: typeof t.activeForm === 'string' ? t.activeForm.slice(0, 200) : '',
              }));
          }
        }
      }
      const u = ev.message.usage || {};
      // Fresh input (new tokens) vs cache read (same context re-read each turn) —
      // kept separate so the headline "in" isn't inflated ~100x by cache reads.
      const incIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const incCache = u.cache_read_input_tokens || 0;
      const incOut = u.output_tokens || 0;
      if (incIn) this.tokensIn += incIn;
      if (incCache) this.tokensCacheRead += incCache;
      if (incOut) this.tokensOut += incOut;
      // Context = the input tokens consumed for this turn — that's the live "size on the wire"
      if (u.input_tokens != null) {
        this.context = incIn + incCache;
      }
      // Spark is processing throughput (tok/min) — cache reads ARE real work, so
      // feed the total processed, not just the fresh slice.
      this.#updateSpark(incIn + incCache + incOut);
      // TODO(state): mirror jsonlConnector's promptFromToolUse — a
      // human-blocking tool_use (AskUserQuestion/ExitPlanMode) should set
      // 'waiting', not 'working'. Low priority: this stream-json path is
      // -p/non-interactive (those tools aren't reachable) and is slated for
      // deletion in Phase E. Fix here only if the legacy path outlives that.
      this.status = 'working';
      this.#flushChange();
      return;
    }

    // User message echoed back (typically tool results from the CLI's own tool exec)
    if (ev.type === 'user' && ev.message) {
      const parts = ev.message.content || [];
      for (const p of parts) {
        if (p.type === 'tool_result') {
          if (typeof p.tool_use_id === 'string') this.pendingSubagents.delete(p.tool_use_id);
          const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? (p.content.map(c => c.text || '').join('\n')) : '';
          // Keep full text for the Zoom modal; cards truncate via wrap.
          const preview = text.slice(0, 160).replace(/\s+/g, ' ');
          this.appendTail({
            kind: 'sys',
            text: `← tool_result ${p.is_error ? '(error)' : ''}\n${text.slice(0, 4000)}`,
            preview: `← tool_result ${p.is_error ? '(error)' : ''} ${preview}`,
          });
        }
      }
      return;
    }

    // Turn complete
    if (ev.type === 'result') {
      // Count user→claude round-trips. One `result` event per query,
      // regardless of how many internal tool-use turns claude ran.
      this.turnCount += 1;
      if (typeof ev.total_cost_usd === 'number') {
        this.costSession += ev.total_cost_usd;
      }
      const u = ev.usage || {};
      if (u.input_tokens != null) {
        this.context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      if (ev.is_error || ev.subtype === 'error') {
        this.status = 'error';
        this.appendTail({ kind: 'err', text: `turn failed: ${ev.subtype || 'error'}` });
      } else {
        // If the last assistant message looked like a confirmation prompt
        // (e.g. "Should I proceed?"), mark the slot waiting so its card
        // border turns yellow and the user knows action is required.
        const lastAsst = [...this.tail].reverse().find(t => t.kind === 'asst');
        this.status = (lastAsst && lastAsst.awaiting) ? 'waiting' : 'idle';
        this.appendTail({ kind: 'sys', text: `turn ok · ${ev.num_turns || 1} turns · $${(ev.total_cost_usd || 0).toFixed(4)}` });
      }
      this.refreshGit().catch(() => {});
      this.#flushChange();
      return;
    }
  }

  #onExit(code, signal) {
    this.proc = null;
    if (this.killed) return; // we asked for this; fleet has already set status='empty'
    if (signal === 'SIGSTOP' || signal === 'SIGCONT') return; // not real exits
    this.appendTail({ kind: 'sys', text: `process exited code=${code} signal=${signal || ''}` });

    // Auto-restart on non-zero / non-null exit codes (process crashed
    // unprompted). Uses exponential backoff (1s, 2s, 4s) up to
    // RESTART_MAX attempts. The counter is reset by the next successful
    // 'init' event in #handle, so a recovered slot can retry again on
    // any future independent failure.
    const RESTART_MAX = 3;
    const transient = code !== 0 && code != null;
    if (transient && this.restartCount < RESTART_MAX) {
      this.restartCount++;
      const backoffMs = 1000 * Math.pow(2, this.restartCount - 1);
      this.appendTail({
        kind: 'sys',
        text: `auto-restart ${this.restartCount}/${RESTART_MAX} in ${(backoffMs / 1000).toFixed(0)}s`,
      });
      // Optimistic status — keeps UI from flashing red between the exit
      // and the restart. If the restart itself fails the next #onExit
      // will set 'error' once retries are exhausted.
      this.status = 'working';
      this.emit('change');
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.killed) return; // user cleared the slot during backoff
        // Use --resume so we pick up the prior transcript (claude's own
        // disk store has it). resuming=true switches start() into resume
        // mode.
        this.resuming = true;
        this.start();
      }, backoffMs);
      return;
    }

    if (transient) {
      this.appendTail({
        kind: 'err',
        text: `auto-restart exhausted (${RESTART_MAX} attempts) — leaving slot errored · K clears`,
      });
      this.status = 'error';
    }
    this.emit('change');
  }

  // Append to tail with bounded length so memory stays flat.
  appendTail(ln) {
    this.tail.push({ ...ln, ts: Date.now() });
    while (this.tail.length > TAIL_MAX) this.tail.shift();
  }

  // Update tok/min sparkline. Delegates to the shared normalizer in
  // server/spark.mjs so the PTY pipeline (jsonlConnector) computes it the
  // exact same way — see #26 (the two had drifted; PTY didn't compute it
  // at all).
  #updateSpark(deltaTokens) {
    updateSpark(this, deltaTokens);
  }

  // approve() — used by the `a` hotkey when a session is waiting for the
  // user to confirm a proposed tool/edit. We send a generic continuation
  // because the stream-json wire format doesn't expose a structured
  // permission-prompt event; the running claude turn sees a plain user
  // message and continues. Safe for sessions in any permission mode.
  approve() {
    return this.send('yes, please continue with the proposed action');
  }

  // addNote() — inject a manual annotation into the session's tail. The
  // text is NOT sent to claude — it only lives in the local tail so the
  // user can drop bookmarks like "claude went off track here" or "tested
  // OK" into the chat log while reviewing in the Zoom modal. Rendered
  // with a distinct glyph + colour.
  addNote(text) {
    if (!text || !text.trim()) return false;
    this.appendTail({ kind: 'note', text: text.trim() });
    this.emit('change');
    return true;
  }

  send(text) {
    // Cost-cap guardrail — refuse user-driven messages once the slot's
    // session cost crosses the configured cap. The user must explicitly
    // raise the cap via :cap <slot> <usd> to continue. We do this BEFORE
    // any respawn so a runaway slot can't tunnel through restart.
    if (this.costCapUSD > 0 && this.costSession >= this.costCapUSD) {
      this.appendTail({
        kind: 'err',
        text: `cost cap reached · $${this.costSession.toFixed(2)} / $${this.costCapUSD.toFixed(2)} · raise with :cap ${this.slot} <usd>`,
      });
      this.emit('change');
      return false;
    }

    // Proc-state classification:
    //   - alive : has proc + stdin writable → write directly
    //   - dead  : no proc or stdin not writable → queue + (maybe) respawn
    const alive = this.proc && this.proc.stdin && this.proc.stdin.writable;
    if (!alive) {
      // Queue first so a burst of send()s during respawn ALL get
      // delivered after init lands.
      this.pendingSends.push(text);
      this.appendTail({
        kind: 'sys',
        text: this.respawning
          ? `queued · waiting for respawn (${this.pendingSends.length} pending)`
          : 'respawning (was exited) — queued; will resume session',
      });
      this.emit('change');
      if (!this.respawning) {
        this.respawning = true;
        try { this.start(); } catch (e) {
          // Respawn failed synchronously — clear the flag so the next
          // send() can try again.
          this.respawning = false;
          this.appendTail({ kind: 'err', text: `respawn failed: ${e.message}` });
          this.emit('change');
        }
      }
      return true; // queued counts as accepted from the caller's POV
    }

    return this.#writeUserMessage(text);
  }

  // Actual stdin write — extracted so the init-drain path can share it
  // with the live send() path. Caller is responsible for confirming the
  // proc is alive and writable.
  #writeUserMessage(text) {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n';
    try {
      this.proc.stdin.write(line);
      this.messageCount += 1;
      this.status = 'working';
      this.activity = `▸ sending: ${text.slice(0, 120)}`;
      this.appendTail({ kind: 'user', text });
      this.#writeTranscript({ source: 'outbound', text });
      this.emit('change');
      return true;
    } catch (e) {
      this.appendTail({ kind: 'err', text: `stdin write failed: ${e.message}` });
      return false;
    }
  }

  // Drain any messages that were queued during respawn. Called from the
  // 'system'/'init' handler once the new subprocess is confirmed alive.
  #drainPendingSends() {
    if (this.pendingSends.length === 0) return;
    const drained = this.pendingSends.splice(0, this.pendingSends.length);
    this.appendTail({ kind: 'sys', text: `respawn ok · draining ${drained.length} queued message${drained.length === 1 ? '' : 's'}` });
    for (const text of drained) {
      this.#writeUserMessage(text);
    }
  }

  pause() {
    if (!this.proc) return false;
    try {
      this.proc.kill('SIGSTOP');
      this.status = 'paused';
      this.appendTail({ kind: 'sys', text: 'SIGSTOP — process frozen' });
      this.emit('change');
      return true;
    } catch (e) {
      this.appendTail({ kind: 'err', text: `pause failed: ${e.message}` });
      return false;
    }
  }

  resume() {
    if (!this.proc) return false;
    try {
      this.proc.kill('SIGCONT');
      this.status = 'working';
      this.appendTail({ kind: 'sys', text: 'SIGCONT — process resumed' });
      this.emit('change');
      return true;
    } catch (e) {
      this.appendTail({ kind: 'err', text: `resume failed: ${e.message}` });
      return false;
    }
  }

  kill() {
    this.killed = true;
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
    }
    if (this.transcriptStream) {
      try {
        this.transcriptStream.write(JSON.stringify({
          ts: Date.now(),
          source: 'local',
          tailEntry: { kind: 'sys', text: 'transcript closed · session killed' },
        }) + '\n');
        this.transcriptStream.end();
      } catch {}
      this.transcriptStream = null;
    }
  }

  // Switch a running session to a new permission mode. claude doesn't
  // expose a runtime control event for this, so we kill the proc and
  // respawn it with `--resume <session-id>` plus the new --permission-mode.
  // The transcript is preserved on disk by claude itself.
  //
  // No-op if the requested mode is already current.
  changePermissionMode(mode) {
    if (!mode) return false;
    if (mode === this.permissionMode) return false;
    const prev = this.permissionMode;
    this.permissionMode = mode;
    this.appendTail({ kind: 'sys', text: `permission: ${mode}` });
    // Tear down the current proc without setting `killed` (we want the
    // exit handler to be a no-op-ish since we're about to restart).
    if (this.proc) {
      try { this.proc.removeAllListeners('exit'); } catch {}
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
    this.buffer = '';
    this.resuming = true;
    this.start();
    return true;
  }

  // Swap the session's model live. Mirrors changePermissionMode's
  // kill+restart-with-resume pattern: tear down the current claude
  // subprocess, set the new model on the agent, then start() spawns
  // a fresh claude with `--resume --session-id` so the transcript
  // rehydrates under the new model. No-op if model is unchanged.
  changeModel(model) {
    if (!model) return false;
    if (model === this.model) return false;
    const prev = this.model;
    this.model = model;
    // Reset resolvedModel — claude will report the new resolution on
    // the next init event, and stale display would mislead until then.
    this.resolvedModel = null;
    this.appendTail({ kind: 'sys', text: `model: ${prev} → ${model}` });
    if (this.proc) {
      try { this.proc.removeAllListeners('exit'); } catch {}
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
    this.buffer = '';
    this.resuming = true;
    this.start();
    return true;
  }

  toJSON() {
    // Stuck-detection: minutes of silence on a slot we'd EXPECT to be
    // emitting events. Working and waiting both count — waiting means
    // we're holding on a permission prompt that should still tick its
    // own heartbeat. Idle / paused are intentionally quiet and are
    // explicitly excluded.
    const STUCK_MIN_THRESHOLD = 5;
    let stuckMin = 0;
    if (this._statusValue === 'working' || this._statusValue === 'waiting') {
      const m = Math.floor((Date.now() - this.lastEventTs) / 60000);
      if (m >= STUCK_MIN_THRESHOLD) stuckMin = m;
    }
    return {
      id: this.id,
      slot: this.slot,
      name: this.name,
      model: this.model,
      // Claude's reported model after alias resolution. Card / Zoom
      // prefer this for display so `:perm` swaps and stale aliases are
      // immediately visible. null until first init event.
      resolvedModel: this.resolvedModel,
      branch: this.branch,
      dirty: this.dirty,
      ahead: this.ahead,
      behind: this.behind,
      status: this.status,
      activeSubagents: (() => {
        const now = Date.now();
        return [...this.pendingSubagents.values()]
          .sort((a, b) => a.startTs - b.startTs)
          .map((s) => ({ label: s.label, type: s.type, elapsedMs: now - s.startTs }));
      })(),
      context: this.context,
      tokensIn: this.tokensIn,
      tokensCacheRead: this.tokensCacheRead,
      tokensOut: this.tokensOut,
      costSession: this.costSession,
      // costWeek is overlaid by the TUI from costStore (see tui/App.jsx).
      costWeek: 0,
      spark: this.spark,
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      // Anchor for the Zoom-mode spinner / elapsed-time counter.
      // null when the agent is not actively in a 'working' state.
      workingStartTs: this.workingStartTs,
      // Per-agent session metrics (#12). spawnedAt and stateSince are
      // absolute timestamps; the TUI derives elapsed time on render so
      // counters stay live without snapshot churn.
      spawnedAt: this.spawnedAt,
      stateSince: this.stateSince,
      turnCount: this.turnCount,
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      // 0 when alive; minutes of silence when stuck (>= 5min while
      // working/waiting). Card.jsx renders a red STUCK chip on >0.
      stuckMin,
      // Per-slot cost cap (USD) and whether it's currently capping.
      // 0 means disabled. capReached lets the UI render a card decoration
      // without recomputing thresholds on every render.
      costCapUSD: this.costCapUSD,
      capReached: this.costCapUSD > 0 && this.costSession >= this.costCapUSD,
      // api-error heartbeat (transport noise claude auto-retries). Surfaced
      // in the fleet header so it reads as "retrying", not "failed".
      apiErrorCount: this.apiErrorCount || 0,
      lastApiErrorTs: this.lastApiErrorTs || 0,
      // Snapshot the last 16 entries. Cards/FleetLog render the short
      // preview; Zoom needs more history to wrap multi-line responses.
      tail: this.tail.slice(-16),
      // Assistant's current to-do plan (from the latest TodoWrite). Empty
      // until claude calls TodoWrite at least once.
      todos: this.todos.slice(),
    };
  }
}
