// server/ptyAgent.mjs — single-pipeline claude wrapper for one slot.
//
// PtyAgent replaces the stream-json sibling architecture (Agent in agent.mjs).
// One claude process per slot, running in a node-pty. State is derived
// exclusively from claude's on-disk session JSONL via sessionFileTailer +
// jsonlConnector. The dual-pipeline divergence that drove every zoom bug
// for the past week (sibling SIGSTOP'd during zoom → stale state) cannot
// happen here: the PTY is the only writer and the tailer is the only
// reader.
//
// Public surface matches Agent so the Fleet swap is mechanical and the
// 100+ UI read sites of toJSON() stay untouched.
//
// Design notes from research (.claude/plans/single-pipeline-rewrite.md):
// - R1: 3s ready delay before first PTY write (banner draw window).
// - R2: JSONL doesn't exist until first user message commits — the
//       tailer's existing poll-for-creation handles this.
// - R3: --session-id is usually honored; fall back to --resume + existsSync
//       guard for re-attaching to an existing transcript.
// - R12: default 80×24 for non-zoomed slots; PtyPane calls resize() on
//        zoom enter/exit.
// - R13: spawn is injectable for tests — defaults to node-pty.spawn.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { MODELS } from '../tui/lib/models.js';
import { fullStatus } from './git.mjs';
import { claudeSessionPath, startSessionTailer } from './sessionFileTailer.mjs';
import { startSubagentUsageTailer } from './subagentUsageTailer.mjs';
import { startStatusHookTailer } from './statusHookTailer.mjs';
import { dlog } from '../tui/lib/debugLog.js';
import { buildHookSettings } from './hookSettings.mjs';

// Absolute path to the hook emitter script, resolved relative to this module.
// Constant across the process lifetime — does not change per session or slot.
const _moduleDir = dirname(fileURLToPath(import.meta.url));
const EMITTER_PATH = resolve(_moduleDir, 'hooks/emit-status.mjs');

// xterm-headless ships as { Terminal } sometimes nested under default
// depending on the bundler. Same pattern as PtyPane previously.
const { Terminal } = xterm.default || xterm;

// Persistent emulator scrollback. Every line of claude's PTY output
// is captured here for the agent's lifetime; zoom is a viewport into
// this buffer. 5000 rows × ~32 bytes/cell × cols ≈ ~32MB per slot at
// 200 cols. Acceptable for ≤ 10 slots; tune down if memory bites.
const TERM_SCROLLBACK = 5000;

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TAIL_MAX = 40;
const SPARK_LEN = 15;

// pasteForSubmit — build the content chunk a programmatic send (broadcast /
// approve) writes to the PTY BEFORE the submit CR. Mirrors PtyPane's proven
// key-forwarder rules so a broadcast behaves like a real zoom keystroke:
//   • A claude slash command (text starts with '/') is written RAW — claude
//     dispatches slash commands only from typed input, never from
//     bracketed-paste content (#25), so we must NOT wrap it.
//   • Otherwise, when claude has bracketed-paste mode on, wrap the text in
//     CSI 200~/201~ so embedded newlines/control chars are treated as
//     content; the trailing CR then lands OUTSIDE the 201~ marker as an
//     unambiguous Enter. A bare `text\r` single write was being absorbed as
//     paste, so the prompt never submitted until a manual zoom Enter (#24).
// Exported for unit testing.
export function pasteForSubmit(text, bracketed) {
  const isSlash = text.trimStart().startsWith('/');
  if (!isSlash && bracketed) return '\x1b[200~' + text + '\x1b[201~';
  return text;
}

// 0180: detect claude's interactive tool-permission prompt from the rendered
// terminal. This prompt ("Do you want to proceed? ❯ 1. Yes / … / No, and tell
// Claude…") is PTY-only — claude NEVER writes it to the session JSONL (verified
// across 1604 session files: zero hits), so the JSONL just shows a `tool_use`
// with no `tool_result` and the connector leaves status 'working' while claude
// is actually blocked on the user. The only available signal is the term buffer.
//
// Strict triple-anchor (human-approved heuristic): require ALL of the question
// line, a `1. Yes` option, AND a `No, and…/No, keep…` option within the
// supplied bottom-of-screen rows. Requiring the whole prompt block — at the
// bottom — keeps claude's own prose (which might quote "do you want to
// proceed?") from false-flipping an auto-approving session to 'waiting'.
// Exported as a pure function over rows[] so the heuristic is unit-testable
// without a real PTY/xterm.
//
// The question anchor is the "Do/Would you want/like to …" opener WITHOUT a
// fixed trailing verb: Bash prompts say "…proceed?" but Edit/Write/Run prompts
// say "…make this edit to X?", "…create X?", "…run this command?". Pinning the
// verb to proceed|continue missed those, so a session blocked on an edit/write
// approval sat on 'working' (then STUCK). The `1. Yes` + `No, and/keep` anchors
// are the strong signals that keep this from matching ordinary prose.
const APPROVE_Q_RX   = /\b(?:do|would) you (?:want|like) to\b/i;
const APPROVE_YES_RX = /(?:^|\s)(?:❯\s*)?1\.\s+Yes\b/;
const APPROVE_NO_RX  = /\bNo,\s+(?:and|keep)\b/i;
// How many rows up from the bottom of the live screen to scan. The prompt
// block is ~6 lines; 12 covers it with margin while staying anchored to the
// bottom so a stale prompt that has scrolled up after the answer won't match.
const APPROVE_SCAN_ROWS = 12;

// claude's active-turn indicator. While a turn is running claude paints a
// status line with the interrupt hint ("… (esc to interrupt …)"); the moment
// the turn ends, that line is cleared and the idle composer is shown. This is
// the disambiguator for the turn-boundary idle bug: claude emits end_turn /
// turn_duration to the JSONL and KEEPS WORKING (next tool_use lands seconds
// later), so the connector reads 'idle' for a 3-14s window while the session
// is plainly still active. The "esc to interrupt" hint is present for that
// whole window and absent once the session is genuinely waiting on the user,
// so a terminal scan beats any last-event timer (no post-finish flicker).
//
// Match the stable substring "esc to interrupt" WITHOUT requiring the leading
// "(" — claude wraps it differently across versions ("(esc to interrupt)",
// "(esc to interrupt · ctrl+t …)"), but the phrase itself is invariant and
// only appears while a turn is actively running. NOTE: this is matched against
// rendered terminal text, not a captured fixture — if a future claude reworded
// it, the overlay would silently stop firing (the card would revert to the old
// turn-boundary IDLE flash, not break). detectWorking is exported so a recipe
// test can pin it against a real capture later.
const WORKING_RX = /esc to interrupt/i;

// How recently claude must have written PTY bytes for the idle→working overlay
// to trust a lingering "esc to interrupt" hint. A live spinner repaints well
// inside this window; a session that finished (or stalled) stops writing, so
// its frozen last frame won't keep the card 'working'. Generous enough to ride
// out a slow spinner refresh between tool calls.
const WORKING_FRESH_MS = 2500;

// detectWorking — true when the rendered rows show claude's active-turn
// interrupt hint. Pure (mirrors detectApprovalPrompt) so it's unit-testable.
export function detectWorking(rows) {
  if (!Array.isArray(rows)) return false;
  for (const r of rows) {
    if (r && WORKING_RX.test(r)) return true;
  }
  return false;
}

export function detectApprovalPrompt(rows) {
  if (!Array.isArray(rows)) return false;
  let q = false, yes = false, no = false;
  for (const r of rows) {
    if (!r) continue;
    if (!q && APPROVE_Q_RX.test(r)) q = true;
    if (!yes && APPROVE_YES_RX.test(r)) yes = true;
    if (!no && APPROVE_NO_RX.test(r)) no = true;
  }
  return q && yes && no;
}

// R1: minimum delay before first PTY write so claude's banner finishes
// drawing and the prompt is ready to accept input. Probe showed banner
// fully rendered by ~500ms; 3s is comfortable margin without feeling slow.
const READY_MS = 3000;

// R12: default PTY dimensions for non-zoomed slots. Zoom resizes via
// resize() on enter, restores via resize() on exit.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const RESTART_MAX = 3;

// UI-id → CLI-arg derivation. Same source of truth as agent.mjs +
// zoomSession.mjs so a new MODELS entry can't fall through to the
// literal friendly id (which claude rejects).
const MODEL_ARG = Object.fromEntries(
  Object.entries(MODELS).map(([id, m]) => [id, m.cliModel])
);

export class PtyAgent extends EventEmitter {
  constructor({
    slot,
    id,
    name,
    cwd,
    branch,
    model = 'sonnet-4.6',
    permissionMode = 'acceptEdits',
    sessionId,
    resume = false,
    // R13: injectable spawn for unit tests. Tests pass a fake that
    // returns a PTY-like object exposing write/onData/onExit/kill/
    // resize + a pid. Production uses node-pty.spawn.
    spawn = ptySpawn,
    // 0188: getter for the sessionIds owned by OTHER live slots, supplied by
    // Fleet. Forwarded to the tailer so a rotation hunt never re-points onto a
    // sibling slot's transcript. Defaults to claiming nothing.
    siblingSids = () => [],
  } = {}) {
    super();
    this.slot = slot;
    this.id = id || `slot-${slot}`;
    this.name = name;
    this.cwd = cwd;
    this.branch = branch;
    this.model = model;
    this.resolvedModel = null;
    this.permissionMode = permissionMode;
    this.sessionId = sessionId || randomUUID();
    this.resuming = !!resume;
    this._spawn = spawn;
    this._siblingSids = siblingSids;

    // UI-visible state — must match Agent.toJSON shape exactly.
    this.workingStartTs = null;
    // Per-agent session metrics (#12) — see agent.mjs for semantics.
    this.stateSince = Date.now();
    this.spawnedAt = Date.now();
    this.turnCount = 0;
    this.messageCount = 0;
    this.status = 'idle';
    this.context = 0;
    this.tokensIn = 0;          // fresh input (input + cache_creation); accounting in jsonlConnector
    this.tokensCacheRead = 0;   // cache_read — context re-read each turn, broken out from tokensIn
    this.tokensOut = 0;
    this.costSession = 0;
    // In-flight Task/Workflow fan-out — Map<tool_use_id,{label,type,startTs}>,
    // mutated by jsonlConnector on tool_use/tool_result. Surfaced as
    // activeSubagents in toJSON for the ⋔{n} card indicator + Zoom list.
    this.pendingSubagents = new Map();
    this.dirty = 0;
    this.ahead = 0;
    this.behind = 0;
    this.spark = Array(SPARK_LEN).fill(1);
    // tok/min sparkline baseline — jsonlConnector.updateSpark() reads
    // these to normalize the rate over elapsed wall time (#26).
    this.lastTokSampleTs = Date.now();
    this.lastTokRate = 0;
    this.activity = 'Awaiting first instruction';
    this.tail = [];
    this.todos = [];

    // Internals
    this.pty = null;
    this.tailer = null;
    this.statusTailer = null;
    this.usageTailer = null;
    // Persistent xterm-headless emulator. Created in start(),
    // captures every byte the PTY writes for the agent's lifetime,
    // disposed in kill(). The zoom view reads this buffer directly
    // — so re-zoom shows full scrollback including everything that
    // streamed while the user was in fleet view.
    this.term = null;
    this.cell = null;
    // IDisposable from the term.write subscription. Kept so kill()
    // can unsubscribe cleanly.
    this._termDataSub = null;
    this.killed = false;
    this.lastEventTs = Date.now();
    // PTY-only activity clock. Unlike lastEventTs (which jsonlConnector also
    // bumps on every parsed JSONL line), this advances ONLY when claude writes
    // bytes to the terminal. The idle→working overlay needs it: a genuinely
    // idle session emits no bytes, so its last working frame (with the
    // "esc to interrupt" hint) lingers in the buffer forever — the scan alone
    // would pin it to 'working'. Requiring fresh PTY output disambiguates a
    // live spinner from a frozen one.
    this.lastPtyTs = Date.now();
    // JSONL-only activity clock (bumped solely by jsonlConnector.parseEvent),
    // used by toJSON()'s hook-vs-connector freshness merge. Distinct from
    // lastEventTs (which onData also bumps on every PTY byte) so cosmetic
    // terminal repaints can't defeat a real Stop-hook idle transition.
    this.lastConnectorTs = 0;
    this.restartCount = 0;
    this.restartTimer = null;
    this.costCapUSD = 0;
    this.pendingSends = [];
    // false during the READY_MS window after spawn. send() queues
    // into pendingSends until ready flips true, then drains.
    this.ready = false;
    this.readyTimer = null;
    this.cols = DEFAULT_COLS;
    this.rows = DEFAULT_ROWS;
  }

  // status accessor anchors workingStartTs on transition into 'working'
  // and clears it on the way out — Zoom's spinner reads workingStartTs
  // for its elapsed-time counter.
  get status() { return this._statusValue || 'idle'; }
  set status(next) {
    const prev = this._statusValue;
    if (prev === next) return;
    this._statusValue = next;
    // Refresh "time in current state" anchor on every real transition.
    this.stateSince = Date.now();
    if (next === 'working') {
      if (!this.workingStartTs) this.workingStartTs = Date.now();
    } else {
      this.workingStartTs = null;
    }
  }

  start() {
    const modelArg = MODEL_ARG[this.model] || this.model;
    const sessionFile = claudeSessionPath({ cwd: this.cwd, sessionId: this.sessionId });
    const args = [];
    // R14: --resume only works after claude flushed the session JSONL.
    // For a brand-new session (no file yet), fall back to --session-id
    // so claude creates the file under the id we want.
    if (this.resuming && existsSync(sessionFile)) {
      args.push('--resume', this.sessionId);
    } else {
      this.resuming = false;
      args.push('--session-id', this.sessionId);
    }
    if (modelArg) args.push('--model', modelArg);
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode);
    if (this.cwd) args.push('--add-dir', this.cwd);

    // Inject the MC hooks settings block so every spawned claude emits status
    // events to the MC-owned emitter file. Two discrete argv elements — never
    // a shell-interpolated string. The settings object is constant (node binary
    // + emitterPath); no per-session data (cwd, sessionId) enters the value.
    // TODO(hook-inject): emitterPath with spaces would be shell-split by claude's hook runner (node <path>); quote or use an argv-array command form if MC is ever installed under a path containing spaces.
    const _hookSettings = buildHookSettings({ emitterPath: EMITTER_PATH });
    args.push('--settings', JSON.stringify(_hookSettings));

    this.pty = this._spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const kind = this.resuming ? 'resume' : 'spawn';
    dlog('pty', kind, { slot: this.slot, pid: this.pty?.pid, model: modelArg, sid: String(this.sessionId).slice(0, 8) });
    this.appendTail({
      kind: 'sys',
      text: `${kind} pid=${this.pty.pid} model=${modelArg} cwd=${this.cwd}${this.resuming ? ` session=${this.sessionId.slice(0, 8)}` : ''}`,
    });

    // Construct (or reconstruct on restart) the persistent emulator.
    // Every byte claude writes lands here for the agent's lifetime,
    // not just while zoom is open — that's what gives the user "no
    // lost state" on re-zoom. Only built when Terminal is available
    // (skipped in unit tests using the spawn stub).
    if (Terminal && typeof Terminal === 'function') {
      try {
        if (this.term) { try { this.term.dispose(); } catch {} }
        this.term = new Terminal({
          cols: this.cols,
          rows: this.rows,
          allowProposedApi: true,
          scrollback: TERM_SCROLLBACK,
        });
        this.cell = this.term.buffer.active.getNullCell();
        // OSC 52 (clipboard) + bell are user-visible side effects
        // that PtyPane used to handle; with term owned by the agent
        // we register them here so they fire regardless of whether
        // a zoom view is currently mounted.
        try {
          this.term.parser.registerOscHandler(52, (data) => {
            try { process.stdout.write(`\x1b]52;${data}\x07`); } catch {}
            return false;
          });
        } catch {}
        try {
          this.term.onBell(() => { try { process.stdout.write('\x07'); } catch {} });
        } catch {}
      } catch (e) {
        this.appendTail({ kind: 'err', text: `term init failed: ${e.message}` });
        this.term = null;
        this.cell = null;
      }
    }

    // PTY stdout drives two listeners:
    //   1) the persistent terminal (so its buffer always has the
    //      latest claude output — read by zoom on mount/re-mount)
    //   2) liveness for stuck-detection in toJSON()
    try {
      this._termDataSub = this.pty.onData((chunk) => {
        this.lastEventTs = Date.now();
        this.lastPtyTs = Date.now(); // PTY-only clock for the idle→working overlay
        if (this.term) {
          try { this.term.write(chunk); } catch {}
        }
      });
    } catch {}
    try {
      this.pty.onExit(({ exitCode, signal }) => this.#onExit(exitCode, signal));
    } catch {}

    // JSONL tailer — single source of truth for status, tokens, cost,
    // tail, todos, resolvedModel, permissionMode. Polls for file
    // creation (R2: claude doesn't write JSONL until first user msg
    // commits) then switches to fs.watch.
    try {
      this.tailer = startSessionTailer({ agent: this, claimedSids: this._siblingSids });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `tailer start failed: ${e.message}` });
    }

    // Status hook tailer — watches the session's NDJSON status file and
    // sets this.hookStatus from PreToolUse / Notification / Stop events.
    // Mirrors the JSONL tailer lifecycle exactly (started on every spawn /
    // restart, stopped on every exit path) so no file watchers leak.
    try {
      this.statusTailer = startStatusHookTailer({ agent: this });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `statusTailer start failed: ${e.message}` });
    }

    // Sub-agent usage tailer — folds sidechain (Task/Workflow) token + cost
    // consumption into this parent's totals + tok/min. The main tailer reads
    // only <sessionId>.jsonl, so without this a fan-out session undercounts.
    try {
      this.usageTailer = startSubagentUsageTailer({ agent: this });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `usageTailer start failed: ${e.message}` });
    }

    // R1: queue any send()s that arrive during the banner-draw window.
    this.ready = false;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.ready = true;
      this.#drainPendingSends();
    }, READY_MS);

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

  #onExit(code, signal) {
    dlog('pty', 'exit', { slot: this.slot, code, signal, killed: !!this.killed, restarts: this.restartCount || 0 });
    this.pty = null;
    if (this._termDataSub) {
      // PTY is gone; the subscription's underlying handle is gone
      // with it. Null the ref so kill() doesn't try to redispose.
      // The term itself stays alive — its buffer holds the user-
      // visible scrollback they may still want to read until they
      // explicitly kill the slot.
      this._termDataSub = null;
    }
    if (this.tailer) {
      try { this.tailer.stop(); } catch {}
      this.tailer = null;
    }
    try { this.statusTailer?.stop(); } catch {}
    this.statusTailer = null;
    try { this.usageTailer?.stop(); } catch {}
    this.usageTailer = null;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.killed) return;
    if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;
    this.appendTail({ kind: 'sys', text: `process exited code=${code} signal=${signal || ''}` });

    // Auto-restart on transient (non-zero, non-null) exit. Backoff
    // 2s, 5s, 15s up to RESTART_MAX. Uses --resume because JSONL exists from
    // any prior turn. The widened schedule (was 1/2/4s) gives a flapping
    // session more room before it re-opens a streaming API connection and
    // re-uploads its full context — avoids a restart→reconnect storm when the
    // underlying cause is transport/overload rather than a one-off crash.
    const RESTART_BACKOFF_MS = [2000, 5000, 15000];
    const transient = code !== 0 && code != null;
    if (transient && this.restartCount < RESTART_MAX) {
      this.restartCount++;
      const backoffMs = RESTART_BACKOFF_MS[this.restartCount - 1] || RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
      this.appendTail({
        kind: 'sys',
        text: `auto-restart ${this.restartCount}/${RESTART_MAX} in ${(backoffMs / 1000).toFixed(0)}s`,
      });
      this.status = 'working';
      this.emit('change');
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.killed) return;
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

  appendTail(ln) {
    this.tail.push({ ...ln, ts: Date.now() });
    while (this.tail.length > TAIL_MAX) this.tail.shift();
  }

  approve() {
    return this.send('yes, please continue with the proposed action');
  }

  addNote(text) {
    if (!text || !text.trim()) return false;
    this.appendTail({ kind: 'note', text: text.trim() });
    this.emit('change');
    return true;
  }

  send(text) {
    if (this.costCapUSD > 0 && this.costSession >= this.costCapUSD) {
      this.appendTail({
        kind: 'err',
        text: `cost cap reached · $${this.costSession.toFixed(2)} / $${this.costCapUSD.toFixed(2)} · raise with :cap ${this.slot} <usd>`,
      });
      this.emit('change');
      return false;
    }

    // Queue path: no PTY (need respawn) OR PTY exists but not ready
    // (still in the banner-draw window). Both drain into the same
    // pendingSends and flush on ready / on init.
    if (!this.pty || !this.ready) {
      this.pendingSends.push(text);
      this.appendTail({
        kind: 'sys',
        text: this.pty
          ? `queued · waiting for PTY ready (${this.pendingSends.length} pending)`
          : 'respawning — queued; will resume session',
      });
      this.emit('change');
      if (!this.pty && !this.killed) {
        this.resuming = true;
        try { this.start(); } catch (e) {
          this.appendTail({ kind: 'err', text: `respawn failed: ${e.message}` });
          this.emit('change');
        }
      }
      return true;
    }

    return this.#writePtyMessage(text);
  }

  #writePtyMessage(text) {
    try {
      const bracketed = !!this.term?.modes?.bracketedPasteMode;
      const isSlash = text.trimStart().startsWith('/');
      const content = pasteForSubmit(text, bracketed);
      if (isSlash) {
        // Slash commands: write the command, then the submit CR on a
        // SEPARATE tick so claude registers a distinct Enter and dispatches
        // it (a combined `/clear\r` single write did nothing — #25). Capture
        // pty so a respawn/kill mid-defer writes to the right target (or not
        // at all).
        this.pty.write(content);
        const pty = this.pty;
        setImmediate(() => { try { if (pty && !this.killed) pty.write('\r'); } catch {} });
      } else if (bracketed) {
        // Normal text, claude's bracketed-paste mode ON (the live case at the
        // prompt): write the 200~..201~ paste, then the submit CR on a
        // SEPARATE tick. A CR coalesced into the SAME write as the paste is
        // swallowed by claude's paste-finalization — the text lands in the box
        // but never submits, so a broadcast required a manual Enter per
        // session (#24 redux). Same separate-tick rule the slash path uses.
        this.pty.write(content);
        const pty = this.pty;
        setImmediate(() => { try { if (pty && !this.killed) pty.write('\r'); } catch {} });
      } else {
        // Paste mode off (e.g. unit tests, or a session not at its prompt):
        // historical single-write `text\r`.
        this.pty.write(content + '\r');
      }
      this.status = 'working';
      this.activity = `▸ sending: ${text.slice(0, 120)}`;
      this.appendTail({ kind: 'user', text });
      this.emit('change');
      return true;
    } catch (e) {
      this.appendTail({ kind: 'err', text: `pty write failed: ${e.message}` });
      return false;
    }
  }

  #drainPendingSends() {
    if (this.pendingSends.length === 0) return;
    const drained = this.pendingSends.splice(0, this.pendingSends.length);
    this.appendTail({
      kind: 'sys',
      text: `PTY ready · draining ${drained.length} queued message${drained.length === 1 ? '' : 's'}`,
    });
    for (const text of drained) {
      this.#writePtyMessage(text);
    }
  }

  pause() {
    if (!this.pty) return false;
    try {
      this.pty.kill('SIGSTOP');
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
    if (!this.pty) return false;
    try {
      this.pty.kill('SIGCONT');
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
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.tailer) {
      try { this.tailer.stop(); } catch {}
      this.tailer = null;
    }
    try { this.statusTailer?.stop(); } catch {}
    this.statusTailer = null;
    try { this.usageTailer?.stop(); } catch {}
    this.usageTailer = null;
    if (this._termDataSub) {
      try { this._termDataSub.dispose?.(); } catch {}
      this._termDataSub = null;
    }
    if (this.term) {
      try { this.term.dispose(); } catch {}
      this.term = null;
      this.cell = null;
    }
    if (this.pty) {
      try { this.pty.kill('SIGTERM'); } catch {}
    }
  }

  // markUserSubmitted — called by PtyPane the moment a user-typed
  // prompt is submitted (Enter / \r forwarded to the PTY). Flips
  // status to 'working' and refreshes lastEventTs synchronously, so
  // the card UI reflects intent immediately instead of waiting the
  // 200-800ms for claude to commit the JSONL user event. parseEvent
  // will subsequently confirm via the JSONL stream (idempotent).
  // Programmatic sends (send/broadcast/approve) already flip status
  // via #writePtyMessage; this method covers the zoom-typed path
  // that goes pty.write(...) directly.
  markUserSubmitted() {
    this.status = 'working';
    this.lastEventTs = Date.now();
    this.emit('change');
  }

  changePermissionMode(mode) {
    if (!mode) return false;
    if (mode === this.permissionMode) return false;
    this.permissionMode = mode;
    this.appendTail({ kind: 'sys', text: `permission: ${mode}` });
    this.#teardownForRestart();
    this.resuming = true;
    this.start();
    return true;
  }

  changeModel(model) {
    if (!model) return false;
    if (model === this.model) return false;
    const prev = this.model;
    this.model = model;
    this.resolvedModel = null;
    this.appendTail({ kind: 'sys', text: `model: ${prev} → ${model}` });
    this.#teardownForRestart();
    this.resuming = true;
    this.start();
    return true;
  }

  // Shared teardown for changePermissionMode / changeModel — they both
  // need to drop the current PTY without triggering auto-restart, then
  // start() will spawn a fresh one with --resume.
  #teardownForRestart() {
    if (this.tailer) {
      try { this.tailer.stop(); } catch {}
      this.tailer = null;
    }
    try { this.statusTailer?.stop(); } catch {}
    this.statusTailer = null;
    try { this.usageTailer?.stop(); } catch {}
    this.usageTailer = null;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.pty) {
      const oldPty = this.pty;
      this.pty = null;
      // We're tearing down on purpose; suppress the auto-restart
      // path in #onExit by flipping killed briefly. start() resets
      // it back to false implicitly via constructor state.
      const wasKilled = this.killed;
      this.killed = true;
      try { oldPty.kill('SIGTERM'); } catch {}
      this.killed = wasKilled;
    }
  }

  // Resize the PTY (and the persistent emulator) for zoom in/out.
  // PtyPane calls this on mount with the zoom dimensions and on
  // unmount with the defaults. No-op when pty is null.
  resize(cols, rows) {
    this.cols = Math.max(20, (cols | 0) || DEFAULT_COLS);
    this.rows = Math.max(5, (rows | 0) || DEFAULT_ROWS);
    if (this.pty) {
      try { this.pty.resize(this.cols, this.rows); } catch {}
    }
    if (this.term) {
      try { this.term.resize(this.cols, this.rows); } catch {}
    }
  }

  // attachZoomView — bind the zoom modal to our running PTY without
  // spawning anything new. Returns the same { pty, dispose, sessionId }
  // shape as legacy startZoomSession() so PtyPane can treat both paths
  // uniformly. dispose() restores default dims and unsubscribes any
  // listeners the caller attached — it does NOT kill the PTY (the
  // agent owns the PTY's lifecycle, not the zoom view).
  //
  // This is the Phase D centerpiece: the dual-pipeline approach is
  // gone — there's no second claude to spawn, no SIGSTOP dance, no
  // dir-snapshot for sid detection. The agent's PTY IS the canonical
  // claude, and zoom is just a viewport into it.
  attachZoomView({ cols, rows } = {}) {
    if (!this.pty) throw new Error('attachZoomView: agent.pty not running');
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.resize(cols, rows);
    let disposed = false;
    return {
      pty: this.pty,
      // The persistent emulator + null cell. PtyPane renders these
      // directly — its buffer survives zoom enter/exit cycles, so
      // the user sees the full conversation on re-zoom.
      term: this.term,
      cell: this.cell,
      sessionId: this.sessionId,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Restore the non-zoomed default dimensions so a subsequent
        // claude UI re-flow uses sane width. Skip if the PTY died
        // while zoomed.
        try { this.resize(prevCols, prevRows); } catch {}
      },
    };
  }

  // 0180: read the bottom rows of the live terminal and test the human-approved
  // triple-anchor for claude's permission prompt. Cheap (≤12 rows translated);
  // wrapped so a term-API hiccup can never crash toJSON — the UI read model.
  #scanApprovalPrompt() {
    try {
      const buf = this.term?.buffer?.active;
      if (!buf) return false;
      const total = buf.length;
      const rows = [];
      for (let y = Math.max(0, total - APPROVE_SCAN_ROWS); y < total; y++) {
        const line = buf.getLine(y);
        if (line) rows.push(line.translateToString(true));
      }
      return detectApprovalPrompt(rows);
    } catch {
      return false;
    }
  }

  #scanWorking() {
    try {
      const buf = this.term?.buffer?.active;
      if (!buf) return false;
      const total = buf.length;
      const rows = [];
      for (let y = Math.max(0, total - APPROVE_SCAN_ROWS); y < total; y++) {
        const line = buf.getLine(y);
        if (line) rows.push(line.translateToString(true));
      }
      return detectWorking(rows);
    } catch {
      return false;
    }
  }

  toJSON() {
    const STUCK_MIN_THRESHOLD = 5;
    // 0180: the JSONL has no permission-prompt event, so when the connector
    // still reads 'working', overlay 'waiting' if the rendered terminal shows
    // claude blocked on a tool-permission prompt. Derived on read, so it clears
    // by itself the moment the prompt leaves the buffer (no state to unwind).
    // 0198: bridge the turn-boundary idle window. claude emits end_turn /
    // turn_duration mid-work and keeps streaming, so jsonlConnector reads
    // 'idle' for 3-14s while the session is still active (worse on cloud-synced
    // session files behind the 1500ms stat-poll).
    //
    // TWO signals, both required, because each alone is wrong:
    //   • #scanWorking() — the "esc to interrupt" hint is in the rendered
    //     buffer. Alone this FALSE-POSITIVES: an idle session emits no bytes,
    //     so its last working frame's hint lingers and pins the card to
    //     'working' forever (the cloud-eff / linkedin / crm-helper bug).
    //   • fresh PTY output — claude wrote bytes within WORKING_FRESH_MS. Alone
    //     this would flicker 'working' for that window after every clean finish
    //     (the completion redraw is itself PTY output).
    // Together: live spinner (hint + bytes flowing) → working; frozen frame
    // (hint but silent) → idle; clean finish (bytes but hint cleared) → idle.
    // Derived on read; STUCK is unaffected (keys off _statusValue, stays idle).
    //
    // 0248/0250/0253: status source-of-truth. When the session is HOOKED
    // (statusHookTailer has seen ≥1 event → hookStatus != null), Claude's own
    // lifecycle events ARE the truth and the xterm regex scrapers are gated OUT
    // — except detectApprovalPrompt, kept as the instant-INPUT fast-path while a
    // tool is outstanding (permission_prompt is a delayed ~10-20s hook). When
    // UN-hooked (legacy FLEET_USE_PTY=0 Agent, or a PTY session before its first
    // hook event), fall back to the pre-hook connector + #scanWorking/#scanApprovalPrompt
    // overlay, unchanged — that path still needs the scrapers.
    const connectorStatus = this.status; // getter → _statusValue || 'idle'
    const ptyFresh = (Date.now() - this.lastPtyTs) < WORKING_FRESH_MS;
    let status;
    let approvalWaiting = false;
    if (this.hookStatus != null) {
      if (this.hookStatus === 'waiting') {
        status = 'waiting';                       // permission_prompt confirmed
      } else if (this.hookStatus === 'working') {
        // A tool is outstanding (PreToolUse, no Stop yet). Sticky 'working' until
        // Stop — covers the intra-turn end_turn flash (0198) with NO #scanWorking.
        // Run ONLY the gated approval scraper as the instant-INPUT fast-path.
        //
        // 0256: gate the scrape on the PTY having SETTLED (!ptyFresh). A real
        // permission box BLOCKS the session — PreToolUse fires, then output goes
        // quiet while the box sits, so within WORKING_FRESH_MS the buffer stops
        // changing. But a session that is genuinely WORKING streams bytes the whole
        // time AND may render approval-SHAPED content it doesn't own — its own
        // approvalPrompt.test.mjs / this detector's source, a web page with
        // "Do you want to… / 1. Yes / No,…". Without the freshness gate that
        // content false-flipped actively-working cards to INPUT? (repro: this MC
        // session + auto-job-applier + crm-helper, all editing/browsing approval-
        // shaped text). A genuine prompt still qualifies ~WORKING_FRESH_MS after
        // the box paints — far ahead of the ~10-20s permission_prompt hook.
        approvalWaiting = !ptyFresh && this.#scanApprovalPrompt();
        status = approvalWaiting ? 'waiting' : 'working';
      } else {
        // hookStatus === 'idle' (Stop/idle_prompt). Idle wins when the Stop is
        // fresher than the last JSONL event (lastConnectorTs — JSONL-only, so PTY
        // repaint chatter can't keep the connector looking fresher; real-app
        // verify, 2026-07-01). If the connector is freshly 'working' (a text-only
        // turn with no PreToolUse), the connector wins so streaming reads working.
        status = (this.hookStatusTs > this.lastConnectorTs) ? 'idle' : connectorStatus;
      }
    } else {
      // UN-hooked fallback — the 0180/0198/0200 overlay, unchanged. #scanWorking
      // bridges the turn-boundary idle window (needs BOTH the "esc to interrupt"
      // hint AND fresh PTY output, else an idle frozen frame pins 'working'
      // forever); #scanApprovalPrompt overlays 'waiting' on a rendered prompt.
      const workingOverlay = connectorStatus === 'idle' && ptyFresh && this.#scanWorking();
      const baseStatus = workingOverlay ? 'working' : connectorStatus;
      approvalWaiting = baseStatus === 'working' && this.#scanApprovalPrompt();
      status = approvalWaiting ? 'waiting' : baseStatus;
    }
    // STUCK is a wedge signal: claude alive but silent ≥5 min (lastEventTs — the
    // any-activity clock, PTY+JSONL — goes stale). Never on a card parked on the
    // user (waiting) or done (idle). Hooked: only a stuck outstanding tool
    // (hookStatus==='working') can wedge. Un-hooked: original semantics — key off
    // the connector _statusValue so an overlay-bridged 'working' (real status
    // idle) never accrues stuck.
    // Active sub-agents run on sidechains the tailer never reads, so the
    // main-thread lastEventTs goes stale while they work — that must NOT read as
    // wedged. Suppress STUCK whenever fan-out is outstanding.
    const subagentsActive = this.pendingSubagents.size > 0;
    let stuckMin = 0;
    const stuckEligible = !subagentsActive && (this.hookStatus != null
      ? (this.hookStatus === 'working' && !approvalWaiting)
      : ((this._statusValue === 'working' || this._statusValue === 'waiting') && !approvalWaiting));
    if (stuckEligible) {
      const m = Math.floor((Date.now() - this.lastEventTs) / 60000);
      if (m >= STUCK_MIN_THRESHOLD) stuckMin = m;
    }
    // Snapshot in-flight fan-out for the card / Zoom. Elapsed derived at read.
    const now = Date.now();
    const activeSubagents = [...this.pendingSubagents.values()]
      .sort((a, b) => a.startTs - b.startTs)
      .map((s) => ({ label: s.label, type: s.type, elapsedMs: now - s.startTs }));
    // 0254: the temporary MC_DEBUG status probe was removed — the hook-based
    // source-of-truth (verified live 2026-07-01) replaced the regex guesswork it
    // was diagnosing.
    return {
      id: this.id,
      slot: this.slot,
      name: this.name,
      model: this.model,
      resolvedModel: this.resolvedModel,
      branch: this.branch,
      dirty: this.dirty,
      ahead: this.ahead,
      behind: this.behind,
      status,
      activeSubagents,
      context: this.context,
      tokensIn: this.tokensIn,
      tokensCacheRead: this.tokensCacheRead,
      tokensOut: this.tokensOut,
      costSession: this.costSession,
      costWeek: 0,
      spark: this.spark,
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      workingStartTs: this.workingStartTs,
      spawnedAt: this.spawnedAt,
      stateSince: this.stateSince,
      turnCount: this.turnCount,
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      stuckMin,
      costCapUSD: this.costCapUSD,
      capReached: this.costCapUSD > 0 && this.costSession >= this.costCapUSD,
      apiErrorCount: this.apiErrorCount || 0,
      lastApiErrorTs: this.lastApiErrorTs || 0,
      tail: this.tail.slice(-16),
      todos: this.todos.slice(),
    };
  }
}
