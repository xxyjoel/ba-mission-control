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
import { clampPtyDims } from '../tui/lib/zoomGeometry.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { MODELS, modelByCli } from '../tui/lib/models.js';
import { fullStatus } from './git.mjs';
import { claudeSessionPath, startSessionTailer } from './sessionFileTailer.mjs';
import { startSubagentUsageTailer } from './subagentUsageTailer.mjs';
import { startStatusHookTailer } from './statusHookTailer.mjs';
import { stableEmitterPath } from './hookInstall.mjs';
import { classifyEarlyExit, findLedgerOwner } from './ledgerOwner.mjs';
import { probeClaudeVersion } from '../tui/lib/claudeVersion.js';
import { dlog } from '../tui/lib/debugLog.js';
import { buildHookSettings } from './hookSettings.mjs';

// Absolute path to the hook emitter script. 0391: resolved through
// hookInstall's STABLE copy (~/.local/state/claude-mc/hook-runtime/) instead
// of the install dir — sessions bake this path at launch, and an install that
// later moves or vanishes (npx cache eviction, deleted stray copy) would
// otherwise break every hook in every still-running session (MODULE_NOT_FOUND
// spam, observed live 2026-08-28). Falls back to the in-install path if the
// stable copy can't be written.
const EMITTER_PATH = stableEmitterPath();

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
//
// S2 (0408): the content is SANITIZED before it goes anywhere near the PTY.
// Bracketed paste is only as strong as the end marker — a literal ESC[201~
// inside the content (a hostile .mc/MEMORY.md reaching send() via the
// project-memory injection, a /compact-restart replay) ends the paste early
// and everything after it is delivered as raw KEYSTROKES; `!cmd` then runs in
// claude's bash mode with no prompt. Strip every C0 control except \n and \t,
// plus DEL and the C1 range (U+0080-U+009F — 8-bit CSI/OSC introducers), so
// no embedded byte can terminate the paste or start an escape sequence. The
// raw (non-bracketed / slash) path gets the same scrub: there the bytes are
// keystrokes by definition, which is strictly worse.
const PASTE_CTRL_RX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export function pasteForSubmit(text, bracketed) {
  const clean = String(text ?? '').replace(PASTE_CTRL_RX, '');
  const isSlash = clean.trimStart().startsWith('/');
  if (!isSlash && bracketed) return '\x1b[200~' + clean + '\x1b[201~';
  return clean;
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

// 0398: how recently a SUB-tagged hook event (background/subagent tool call,
// see statusHookTailer) must have landed for an idle main thread to still
// read 'working'. Background builders fire tools every few seconds; 15s of
// silence means they're done (or wedged — either way the main thread's idle
// verdict stands again).
const SUB_ACTIVE_MS = 15_000;
// 0403: an outstanding Task/Workflow older than this is treated as abandoned and
// stops counting toward bgCount. Mirrors SUBAGENT_STALE_MS in jsonlConnector,
// which sweeps the same Map — kept as its own constant so ptyAgent does not
// import a private value across the connector boundary.
const BG_ABANDON_MS = 30 * 60 * 1000;

// detectWorking — true when the rendered rows show claude's active-turn
// interrupt hint. Pure (mirrors detectApprovalPrompt) so it's unit-testable.
export function detectWorking(rows) {
  if (!Array.isArray(rows)) return false;
  for (const r of rows) {
    if (r && WORKING_RX.test(r)) return true;
  }
  return false;
}

// bottomContentRows — the last `want` rows of the terminal that actually hold
// something, oldest-first, ready for the detectors above.
//
// 0404: this used to read `buffer.length - 12 … buffer.length`, i.e. the bottom
// 12 rows of the BUFFER. That only worked because the PTY was 24 rows: claude
// renders inline, so below its composer sit however many rows the transcript
// has not reached yet. Measured on a real session at 40 rows, 9 of the bottom
// 10 buffer rows were blank — a fixed bottom-12 window saw 2 rows of content
// and the permission-prompt anchors fell outside it, so the card would have
// silently stopped showing NEEDS INPUT. Skipping the trailing blanks makes the
// window independent of the PTY's height.
//
// Bounded work: it stops at the first non-blank row and never examines more
// than one screen plus `want` rows, so this stays the same order of cost as
// the old fixed window (it runs per painted frame, per agent — see 0364).
export function bottomContentRows(term, want = 12) {
  const buf = term?.buffer?.active;
  if (!buf) return [];
  const screen = Math.max(1, term.rows || want);
  const rows = [];
  let seenContent = false;
  const floor = Math.max(0, buf.length - screen - want);
  for (let y = buf.length - 1; y >= floor && rows.length < want; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!seenContent) {
      // Trailing blanks below claude's last written row carry no signal.
      if (text.trim() === '') continue;
      seenContent = true;
    }
    rows.push(text);
  }
  return rows.reverse();
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
    // 0404: the PTY geometry for this agent's whole life, supplied by Fleet
    // from the real terminal (tui/lib/zoomGeometry.js). Fixed on purpose —
    // every resize makes claude reprint its frame and leaves the pre-resize
    // copy in the emulator's scrollback. Falls back to the 80x24 default when
    // no viewport is known (tests, non-TTY).
    cols,
    rows,
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
    this.spark = Array(SPARK_LEN).fill(0); // 0385: blank cold-start — fill(1) rendered a FULL bar at 0 tok/min
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
    // IDisposable from the pty.onExit subscription (P1/0408) — disposed in
    // #teardownForRestart and kill() so a replaced PTY's late exit can never
    // run #onExit against its successor.
    this._exitSub = null;
    // True only while a zoom view is bound to this agent (attachZoomView →
    // dispose). Gates user-visible terminal side effects (the bell) so a
    // BACKGROUND agent can't blast the shared real terminal — every agent's
    // term processes bytes for its whole lifetime, so an un-gated onBell
    // forwarded BEL from any of up to 10 agents flashed the user's screen
    // (visual-bell), reading as a random "screenshot" flash even from the
    // fleet grid. See #onBell gate below.
    this.zoomAttached = false;
    // True while the process is SIGSTOPped via pause(). kill() reads it: a
    // stopped process never handles a queued SIGTERM, so it must be SIGCONTed
    // first or it survives the slot as an orphaned T-state process (P6/0408).
    this.paused = false;
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
    // 0398: last SUB-tagged hook event (background/subagent tool activity).
    // Fresh values keep an idle main thread reading 'working' in toJSON.
    this.lastSubHookTs = 0;
    // JSONL blocking-prompt object or null (set by jsonlConnector on
    // AskUserQuestion / ExitPlanMode / end_turn question; cleared on tool_result).
    this.awaitingPrompt = null;
    // Timestamp of the last truthy awaitingPrompt assignment (ms epoch).
    // 0 when no prompt is outstanding. Used by #collectSignals() / deriveStatus.
    this.awaitingPromptTs = 0;
    this.restartCount = 0;
    this.restartTimer = null;
    this.costCapUSD = 0;
    this.pendingSends = [];
    // false during the READY_MS window after spawn. send() queues
    // into pendingSends until ready flips true, then drains.
    this.ready = false;
    this.readyTimer = null;
    ({ cols: this.cols, rows: this.rows } = clampPtyDims(cols, rows, DEFAULT_COLS, DEFAULT_ROWS));
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
    // P2 (0408): never spawn a sibling next to a live PTY. Every legitimate
    // caller (launch, the restart timer, the send/zoom revive paths,
    // changeModel/changePermissionMode after teardown) reaches here with
    // this.pty null; a second start() while one is running would leave an
    // unreachable claude writing into the same emulator.
    if (this.pty) {
      this.appendTail({ kind: 'sys', text: 'start ignored — PTY already running' });
      return;
    }
    // M1 (0408): a `/model` switch typed inside claude lands only in
    // resolvedModel (the connector reads it back from the JSONL); the launch
    // model in this.model is otherwise re-passed on every relaunch and the
    // switch is silently undone. When the resolved model is one the catalog
    // knows, relaunch with IT. changeModel() nulls resolvedModel first, so a
    // deliberate switch from mc still wins.
    let modelArg = MODEL_ARG[this.model] || this.model;
    const resolvedEntry = this.resolvedModel ? modelByCli(this.resolvedModel) : null;
    if (resolvedEntry) modelArg = resolvedEntry.cliModel;
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
          // S1 (0408): forward a clipboard write ONLY while this agent is the
          // zoom-viewed one — same gate as the bell below. Un-gated, any text
          // claude printed from ANY background slot (a file it read, a tool
          // result) could silently overwrite the user's clipboard while they
          // look at the fleet grid. And never forward a '?' payload: that is
          // a clipboard READ request, which would make the host terminal
          // answer with the user's clipboard contents.
          this.term.parser.registerOscHandler(52, (data) => {
            if (!this.zoomAttached) return false;
            const payload = String(data);
            const body = payload.slice(payload.indexOf(';') + 1);
            if (body.trim() === '?') return false;
            try { process.stdout.write(`\x1b]52;${data}\x07`); } catch {}
            return false;
          });
        } catch {}
        try {
          // Forward the bell to the real terminal ONLY while this agent is the
          // one being viewed (zoom attached). Un-gated, a background agent's BEL
          // reached the shared stdout and flashed the user's whole screen
          // (visual-bell) even from the fleet grid — the "random screenshot
          // flash" bug. The zoomed agent still bells normally.
          this.term.onBell(() => {
            if (!this.zoomAttached) return;
            try { process.stdout.write('\x07'); } catch {}
          });
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
      this._spawnProbeBuf = ''; // first output after (re)spawn — read on early exit
      this._spawnTs = Date.now(); // per-(re)spawn clock for the early-refusal window (0396)
      // 0333: the claude version this process launched on (cached probe —
      // refreshed by `:update`). Live processes keep their inode across
      // on-disk updates, so this is what drift is measured against.
      this.claudeVersion = probeClaudeVersion();
      this._termDataSub = this.pty.onData((chunk) => {
        this.lastEventTs = Date.now();
        this.lastPtyTs = Date.now(); // PTY-only clock for the idle→working overlay
        if (this._spawnProbeBuf.length < 4096) this._spawnProbeBuf += chunk;
        if (this.term) {
          try { this.term.write(chunk); } catch {}
        }
      });
    } catch {}
    try {
      // P1 (0408): keep the disposable AND stamp the callback with the pty it
      // belongs to. node-pty delivers exit asynchronously — after a
      // changeModel/changePermissionMode teardown the OLD pty's exit used to
      // land ~100ms later and run #onExit against the NEW process (pty nulled,
      // tailers stopped, readyTimer cleared; the next send spawned a THIRD
      // claude). #teardownForRestart / kill() dispose this sub, and #onExit
      // double-checks identity in case an exit was already queued.
      const spawnedPty = this.pty;
      this._exitSub = this.pty.onExit(({ exitCode, signal }) => this.#onExit(exitCode, signal, spawnedPty));
    } catch {}

    // JSONL tailer — single source of truth for status, tokens, cost,
    // tail, todos, resolvedModel, permissionMode. Polls for file
    // creation (R2: claude doesn't write JSONL until first user msg
    // commits) then switches to fs.watch.
    try {
      this.tailer = startSessionTailer({ agent: this, claimedSids: this._siblingSids, drive: 'external' });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `tailer start failed: ${e.message}` });
    }

    // Status hook tailer — watches the session's NDJSON status file and
    // sets this.hookStatus from PreToolUse / Notification / Stop events.
    // Mirrors the JSONL tailer lifecycle exactly (started on every spawn /
    // restart, stopped on every exit path) so no file watchers leak.
    try {
      this.statusTailer = startStatusHookTailer({ agent: this, drive: 'external' });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `statusTailer start failed: ${e.message}` });
    }

    // Sub-agent usage tailer — folds sidechain (Task/Workflow) token + cost
    // consumption into this parent's totals + tok/min. The main tailer reads
    // only <sessionId>.jsonl, so without this a fan-out session undercounts.
    try {
      this.usageTailer = startSubagentUsageTailer({ agent: this, autoStart: false });
      this.usageTailer.scan(); // prime immediately; steady-state runs off the fleet driver
    } catch (e) {
      this.appendTail({ kind: 'err', text: `usageTailer start failed: ${e.message}` });
    }

    // R1: queue any send()s that arrive during the banner-draw window.
    this.paused = false; // fresh process is not stopped (P6/0408)
    this.ready = false;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.ready = true;
      this.#drainPendingSends();
    }, READY_MS);

    this.refreshGit().catch(() => {});
    this.emit('change');
  }

  // 0381: one backstop pass over this agent's three tailers, invoked by the
  // Fleet's single shared driver (they're started with drive:'external' /
  // autoStart:false above). Each tick is a no-op guard + cheap stat when
  // nothing changed; tailers of a dead/restarting agent guard on `stopped`.
  tailerTick() {
    try { this.tailer?.tick?.(); } catch {}
    try { this.statusTailer?.tick?.(); } catch {}
    try { this.usageTailer?.scan?.(); } catch {}
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

  #onExit(code, signal, exitedPty = null) {
    // P1 (0408): a late exit from a pty this agent no longer owns (replaced by
    // changeModel/changePermissionMode, or already nulled) must not tear down
    // the CURRENT process's state. The disposable is disposed on teardown too;
    // this guard catches an exit that was already in flight.
    if (exitedPty && exitedPty !== this.pty) return;
    dlog('pty', 'exit', { slot: this.slot, code, signal, killed: !!this.killed, restarts: this.restartCount || 0 });
    this.pty = null;
    this._exitSub = null;
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

    // Session claimed elsewhere: claude refuses `--resume` when the session
    // is held by its daemon as a background agent (typically an orphan from
    // a force-closed mc — 2026-08-12 incident). Every retry fails
    // identically, so don't burn the restart budget on it; surface the
    // actionable remediation instead.
    // Anchor on claude's full refusal phrase, not a loose substring:
    // `--resume` replays prior conversation into the PTY, so replayed
    // prose mentioning "background agent" must not suppress the restart
    // of a genuinely-crashing slot (security-review observation,
    // 2026-08-12).
    // 0396 hardening of the 2026-08-12 guard: the old check required a
    // NON-ZERO exit AND one exact phrase — a refusal that exits 0 or uses
    // different wording fell through to the auto-restart loop (the slot-5
    // error-toast storm, 2026-08-27). classifyEarlyExit accepts any exit
    // code, tolerates wording drift (full-phrase anchors only), and gates on
    // the exit landing within seconds of spawn so replayed conversation
    // prose can never suppress a genuine crash-restart.
    if (classifyEarlyExit(this._spawnProbeBuf, Date.now() - (this._spawnTs || 0)) === 'held-by-agent') {
      const owner = findLedgerOwner(this.sessionId);
      const ownerStr = owner
        ? `background agent is ${owner.state}${owner.tempo ? ` (${owner.tempo})` : ''}${owner.detail ? ` — "${owner.detail}"` : ''}`
        : 'likely started from claude.ai or orphaned by a force-close';
      this.appendTail({
        kind: 'err',
        text: `session is held by a claude background agent — ${ownerStr}. Wait for it to finish (or \`claude agents\` to attach/stop it), then :resume this slot`,
      });
      this.activity = 'held by a background agent — not retrying';
      this.status = 'error';
      this.emit('change');
      return;
    }

    // Auto-restart on transient (non-zero, non-null) exit. Backoff
    // 2s, 5s, 15s up to RESTART_MAX. Uses --resume because JSONL exists from
    // any prior turn. The widened schedule (was 1/2/4s) gives a flapping
    // session more room before it re-opens a streaming API connection and
    // re-uploads its full context — avoids a restart→reconnect storm when the
    // underlying cause is transport/overload rather than a one-off crash.
    const RESTART_BACKOFF_MS = [2000, 5000, 15000];
    const transient = code !== 0 && code != null;
    // P7 (0408): the restart budget used to be a lifetime counter — three
    // transient crashes days apart permanently errored the slot. A process
    // that stayed up this long before crashing is not flapping; its crash
    // starts a fresh budget. Rapid crash loops (uptime under the window)
    // still exhaust RESTART_MAX exactly as before.
    const RESTART_STABLE_MS = 60_000;
    if (transient && this.restartCount > 0 && Date.now() - (this._spawnTs || 0) >= RESTART_STABLE_MS) {
      this.restartCount = 0;
    }
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
        // P2 (0408): reviving during the auto-restart backoff must cancel the
        // scheduled restart, or the timer fires start() AGAIN and the second
        // claude is orphaned (unreachable by kill(), writing into the same
        // emulator). attachZoomView's revive already does this.
        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
          this.restartTimer = null;
        }
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
      this.paused = true;
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
      this.paused = false;
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
    if (this._exitSub) {
      try { this._exitSub.dispose?.(); } catch {}
      this._exitSub = null;
    }
    if (this.term) {
      try { this.term.dispose(); } catch {}
      this.term = null;
      this.cell = null;
    }
    if (this.pty) {
      // P6 (0408): a SIGSTOPped process never handles the SIGTERM — it stays
      // frozen in T state with the signal pending, unreachable once the Fleet
      // drops the agent from agents[]. Wake it first so the SIGTERM lands.
      if (this.paused) {
        try { this.pty.kill('SIGCONT'); } catch {}
        this.paused = false;
      }
      try { this.pty.kill('SIGTERM'); } catch {}
    }
  }

  // hardKill — SIGKILL escalation for shutdown. A claude child wedged on a
  // permission prompt (or entangled with the claude daemon) can ignore
  // SIGTERM; its open PTY handle then holds mc's event loop forever — the
  // quit-stall → force-close → orphan-adopted-as-background-agent chain
  // (2026-08-12 incident, gtm-gov-miner). kill() must have run first.
  hardKill() {
    if (this.pty) {
      try { this.pty.kill('SIGKILL'); } catch {}
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
    // P1 (0408): unsubscribe the old pty's data + exit listeners BEFORE
    // killing it. node-pty delivers exit asynchronously, so without this the
    // old exit landed ~100ms after start() and ran #onExit against the NEW
    // process (pty nulled → next send spawned a third claude, both writing
    // into one emulator). The old data sub likewise kept piping the dying
    // process's bytes into the shared term.
    if (this._termDataSub) {
      try { this._termDataSub.dispose?.(); } catch {}
      this._termDataSub = null;
    }
    if (this._exitSub) {
      try { this._exitSub.dispose?.(); } catch {}
      this._exitSub = null;
    }
    if (this.pty) {
      const oldPty = this.pty;
      this.pty = null;
      // We're tearing down on purpose; suppress the auto-restart
      // path in #onExit by flipping killed briefly. start() resets
      // it back to false implicitly via constructor state.
      const wasKilled = this.killed;
      this.killed = true;
      // P6 (0408): a paused (SIGSTOPped) process must be woken or the SIGTERM
      // stays pending forever — same orphan shape kill() guards against.
      if (this.paused) {
        try { oldPty.kill('SIGCONT'); } catch {}
        this.paused = false;
      }
      try { oldPty.kill('SIGTERM'); } catch {}
      this.killed = wasKilled;
    }
  }

  // Resize the PTY (and the persistent emulator). No-op when pty is null.
  //
  // 0404: called ONLY by Fleet.setViewport — i.e. when the user resizes their
  // real terminal. Zoom enter/exit no longer resizes: claude reprints its
  // entire frame on SIGWINCH and the pre-resize copy stays in the scrollback,
  // so every resize appended a duplicate (narrow) copy of the conversation.
  // Returns true when the dimensions actually changed.
  resize(cols, rows) {
    const { cols: nextCols, rows: nextRows } = clampPtyDims(cols, rows, DEFAULT_COLS, DEFAULT_ROWS);
    if (nextCols === this.cols && nextRows === this.rows) return false;
    this.cols = nextCols;
    this.rows = nextRows;
    if (this.pty) {
      try { this.pty.resize(this.cols, this.rows); } catch {}
    }
    if (this.term) {
      try { this.term.resize(this.cols, this.rows); } catch {}
    }
    return true;
  }

  // attachZoomView — bind the zoom modal to our running PTY without
  // spawning anything new. Returns the same { pty, dispose, sessionId }
  // shape as legacy startZoomSession() so PtyPane can treat both paths
  // uniformly. dispose() unsubscribes any listeners the caller attached — it
  // does NOT kill the PTY (the agent owns the PTY's lifecycle, not the zoom
  // view) and it does NOT resize (see below).
  //
  // This is the Phase D centerpiece: the dual-pipeline approach is
  // gone — there's no second claude to spawn, no SIGSTOP dance, no
  // dir-snapshot for sid detection. The agent's PTY IS the canonical
  // claude, and zoom is just a viewport into it.
  attachZoomView({ cols, rows } = {}) {
    if (!this.pty) {
      // A deliberately-killed slot is never silently revived.
      if (this.killed) throw new Error('attachZoomView: agent.pty not running');
      // Null pty + not killed: this is the auto-restart backoff window
      // (#onExit nulls this.pty, arms this.restartTimer). Revive now
      // instead of throwing — matches send()'s revive-on-write intent.
      // Clear the pending backoff timer first so the scheduled restart
      // doesn't ALSO fire and double-spawn.
      // TODO(resume-flap): reviving here treats the symptom, not the
      // disease — the mass-resume flapping that produces these null-pty
      // windows still needs stagger-tuning, once there's log evidence.
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.resuming = true;
      this.start();
    }
    // 0404: NO resize here. The agent's PTY already runs at the fleet
    // viewport's geometry (Fleet.setViewport ← tui/lib/zoomGeometry.js), which
    // IS the zoom body size. Resizing on attach made claude reprint its whole
    // frame at the new width and left the pre-resize copy in the emulator's
    // scrollback — the reported "text prints twice, one narrow one full width".
    // The { cols, rows } argument is kept for the call-site's shape and for the
    // legacy startZoomSession path; a mismatch just means PtyPane renders the
    // bottom slice of a taller emulator (see PtyPane's view memo).
    void cols; void rows;
    // Mark this agent as the currently-viewed one so the bell forwards to the
    // real terminal (see #onBell gate in start()). Cleared in dispose().
    this.zoomAttached = true;
    // S1 (0408): the OSC 52 handler in start() is gated on this.zoomAttached
    // (and drops '?' read requests), so a background agent can no longer reach
    // the user's clipboard — same gate class as the bell.
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
        // No longer the viewed agent — stop forwarding the bell to the real
        // terminal (back to background: silent).
        this.zoomAttached = false;
        // 0404: no resize-back either. Shrinking to 80x24 on zoom exit was the
        // other half of the double-print: the next zoom widened again, and each
        // widening appended a fresh copy of claude's frame.
      },
    };
  }

  // 0180: read the bottom rows of the live terminal and test the human-approved
  // triple-anchor for claude's permission prompt. Cheap (≤12 rows kept);
  // wrapped so a term-API hiccup can never crash toJSON — the UI read model.
  #scanApprovalPrompt() {
    try {
      return detectApprovalPrompt(bottomContentRows(this.term, APPROVE_SCAN_ROWS));
    } catch {
      return false;
    }
  }

  #scanWorking() {
    try {
      return detectWorking(bottomContentRows(this.term, APPROVE_SCAN_ROWS));
    } catch {
      return false;
    }
  }

  // #collectSignals() — gather all status-relevant signals into one normalized
  // bundle for the future pure deriveStatus(signals, now) function (W1/0284).
  // Pure gathering: no Date.now() here, no status decisions, no I/O.
  // Every field maps to an existing agent property.
  #collectSignals() {
    return {
      hookStatus:      this.hookStatus ?? null,
      hookStatusTs:    this.hookStatusTs ?? 0,
      connectorStatus: this.status,          // getter → _statusValue || 'idle'
      lastConnectorTs: this.lastConnectorTs,
      lastPtyTs:       this.lastPtyTs,
      awaitingPrompt:  this.awaitingPrompt,
      awaitingPromptTs: this.awaitingPromptTs,
      lastEventTs:     this.lastEventTs,
      pendingSubagents: this.pendingSubagents,
      paused:          this.status === 'paused',
      errored:         this.status === 'error',
    };
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
      } else if (this.hookStatus === 'working' && this.awaitingPrompt?.tool) {
        // 0384: a human-blocking TOOL prompt (AskUserQuestion / ExitPlanMode)
        // outranks sticky-working. The ask fires PreToolUse on launch and then
        // NO hook fires for the entire human-wait — no Stop (the turn isn't
        // over), no notification (it's not a permission prompt) — so the hook
        // channel reads 'working' indefinitely (13h in the 2026-08-27
        // auto-job-applier incident). The connector sets awaitingPrompt from
        // the tool_use and clears it on the answering tool_result, and the
        // turn CANNOT run other tools while the ask is pending, so a set
        // tool-sourced prompt means claude is blocked on the user no matter
        // how fresh the last PreToolUse is. Gated on `.tool` — text-heuristic
        // prompts (detectPrompt end_turn questions) stay out of this override
        // because they're guesses, not protocol.
        status = 'waiting';
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
    // 0398: BACKGROUND agents keep an idle card on 'working'. A background
    // Agent launch returns its tool_result instantly and the main thread then
    // Stops — so the sub-tagged hook events (0395: invisible to hookStatus)
    // are the only remaining evidence of work. While that clock is fresh, an
    // 'idle' verdict is a lie in the "safe to ignore" direction (focus-duck
    // read IDLE with three builders running). Never overrides 'waiting' — a
    // permission prompt while background agents run still needs the user.
    // 0403 SUPERSEDES the 0398 override. Merging background work into `status`
    // made the card lie in both directions, and the 15s clock was too tight for
    // either: measured on gtm-gov-miner 2026-09-16, sub-agent tool events arrive
    // 166s apart, so the card flickered WORKING/IDLE every gap. Worse, the main
    // thread had ended its turn at 4:18 (end_turn, no transcript record since)
    // while orphaned sub-agents kept firing — so the card read a flat WORKING on
    // a conversation that was done. Report background work SEPARATELY instead:
    // `status` stays the main thread's own truth, and bgCount/bgStatus let the
    // card show "IDLE · 2bg WORKING". Count outstanding Task/Workflow calls
    // rather than the clock — a sub-agent that thinks for three minutes between
    // tools is still working, and an entry that never returned its tool_result
    // is dropped by the same staleness cutoff the connector sweeps with.
    let bgCount = 0;
    const bgCutoff = Date.now() - BG_ABANDON_MS;
    for (const s of this.pendingSubagents.values()) {
      if ((s?.startTs ?? 0) >= bgCutoff) bgCount++;
    }
    // Fall back to the hook clock when the transcript never showed the Task
    // (a background fork's sub events land in the status file with no matching
    // parent-transcript record — the gtm-gov-miner shape above).
    if (bgCount === 0 && Date.now() - (this.lastSubHookTs || 0) < SUB_ACTIVE_MS) bgCount = 1;
    const bgStatus = bgCount > 0 ? 'working' : null;
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
      procCpu: this.procCpu || 0,      // 0387: %-of-one-core (ps pcpu)
      procMemKb: this.procMemKb || 0, // 0387: RSS KiB
      lastTokRate: this.lastTokRate || 0,   // true tok/min of the last sample (unfloored); Card shows it only while working
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      workingStartTs: this.workingStartTs,
      spawnedAt: this.spawnedAt,
      claudeVersion: this.claudeVersion || null, // 0333: version this process launched on
      stateSince: this.stateSince,
      turnCount: this.turnCount,
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      stuckMin,
      bgCount,       // 0403: outstanding background agents (Task/Workflow or sub hooks)
      bgStatus,      // 0403: 'working' while any are live, else null
      costCapUSD: this.costCapUSD,
      capReached: this.costCapUSD > 0 && this.costSession >= this.costCapUSD,
      apiErrorCount: this.apiErrorCount || 0,
      lastApiErrorTs: this.lastApiErrorTs || 0,
      tail: this.tail.slice(-16),
      todos: this.todos.slice(),
    };
  }
}
