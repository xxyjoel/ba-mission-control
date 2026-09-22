// server/ptyCore.mjs — provider-neutral PTY plumbing for one slot (0420).
//
// PtyCore owns everything about running ONE interactive agent CLI in a
// node-pty that does not depend on which CLI it is: spawn, the persistent
// xterm-headless emulator, OSC 52 / bell gating, exit handling with
// auto-restart, pause/resume/kill, resize, the zoom attach, and the
// send path (readiness gate, pending queue, paste-then-CR write rules).
// PtyAgent (claude) extends it; a CursorAgent extends it the same way. The
// single-pipeline rule holds for every provider: one PTY per slot, the PTY is
// the only writer, and zoom is a viewport into this.term.
//
// Why a base class and not a helper object: Fleet, PtyPane and ~35 test sites
// read and write the plumbing fields directly on the agent (pty, term, cell,
// ready, readyTimer, restartTimer, restartCount, paused, killed, zoomAttached,
// _spawnTs, _spawnProbeBuf, lastPtyTs, lastEventTs, cols, rows). Inheriting
// keeps them own properties of the agent, exactly where those readers expect
// them, with no forwarding layer to drift.
//
// ── What a provider subclass supplies ───────────────────────────────────────
//
// Required:
//   buildSpawn() → { bin, args, env? }
//       argv for this (re)spawn. Called by start() on every spawn, so it
//       reads this.resuming / model / mode fresh. bin and args go to spawn()
//       as an argv array — never a shell string (bins are user-controlled).
//       env defaults to { ...process.env, TERM: 'xterm-256color' }; a provider
//       that needs a least-privilege env returns its own.
//   appendTail(ln)
//       push a { kind, text } line onto the slot's tail ring. Core reports
//       queue / signal / exit / restart events through it.
//   readiness() → { delayMs } | { predicate(core) → bool, pollMs? }
//       when the first queued send may be typed. delayMs is a fixed timer
//       (claude: READY_MS). predicate is polled every pollMs (default 250)
//       until it returns true — for a CLI that can show a dialog before its
//       composer (cursor-agent's workspace trust), so a queued prompt is never
//       typed into the dialog. A throwing predicate reads as not ready.
//
// Optional (default no-op / false):
//   onSpawned(spec)            right after spawn(), with buildSpawn()'s spec —
//                              log the spawn, stamp version probes.
//   startSidecars()            after the PTY listeners are attached — start
//                              transcript / hook / usage tailers.
//   stopSidecars()             on exit, kill and restart teardown — stop them.
//   handleEarlyExit(code, sig) → true when the exit was classified and fully
//                              handled (e.g. claude's held-by-agent refusal,
//                              read from this._spawnProbeBuf within the first
//                              seconds of this._spawnTs). Returning true skips
//                              auto-restart.
//   afterStart()               last step of start() before 'change' (git poll).
//
// Status derivation is NOT here: providers feed server/deriveStatus.mjs with
// their own signals and detector thunks (scanApproval / scanWorking over
// bottomContentRows(this.term)).
//
// State the provider owns but core reads: slot, cwd, sessionId, resuming,
// costCapUSD, costSession, activity, and the status accessor below (whose
// stateSince / workingStartTs anchors the provider initializes).

import { EventEmitter } from 'node:events';
import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { clampPtyDims } from '../tui/lib/zoomGeometry.js';
import { dlog } from '../tui/lib/debugLog.js';

// xterm-headless ships as { Terminal } sometimes nested under default
// depending on the bundler. Same pattern as PtyPane previously.
const { Terminal } = xterm.default || xterm;

// Persistent emulator scrollback. Every line of claude's PTY output
// is captured here for the agent's lifetime; zoom is a viewport into
// this buffer. 5000 rows × ~32 bytes/cell × cols ≈ ~32MB per slot at
// 200 cols. Acceptable for ≤ 10 slots; tune down if memory bites.
const TERM_SCROLLBACK = 5000;

// R12: default PTY dimensions for non-zoomed slots. Zoom resizes via
// resize() on enter, restores via resize() on exit.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const RESTART_MAX = 3;

const DEFAULT_READY_POLL_MS = 250;

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

export class PtyCore extends EventEmitter {
  constructor({
    // R13: injectable spawn for unit tests. Tests pass a fake that
    // returns a PTY-like object exposing write/onData/onExit/kill/
    // resize + a pid. Production uses node-pty.spawn.
    spawn = ptySpawn,
    // 0404: the PTY geometry for this agent's whole life, supplied by Fleet
    // from the real terminal (tui/lib/zoomGeometry.js). Fixed on purpose —
    // every resize makes claude reprint its frame and leaves the pre-resize
    // copy in the emulator's scrollback. Falls back to the 80x24 default when
    // no viewport is known (tests, non-TTY).
    cols,
    rows,
  } = {}) {
    super();
    this._spawn = spawn;

    this.pty = null;
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
    // _teardownForRestart and kill() so a replaced PTY's late exit can never
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
    this.restartCount = 0;
    this.restartTimer = null;
    this.pendingSends = [];
    // false until readiness() says the CLI can take input (claude: the
    // READY_MS window after spawn). send() queues into pendingSends until
    // ready flips true, then drains.
    this.ready = false;
    this.readyTimer = null;
    ({ cols: this.cols, rows: this.rows } = clampPtyDims(cols, rows, DEFAULT_COLS, DEFAULT_ROWS));
  }

  // ── provider hooks (see header) ───────────────────────────────────────────
  buildSpawn() { throw new Error('PtyCore: provider must implement buildSpawn()'); }
  appendTail() { throw new Error('PtyCore: provider must implement appendTail()'); }
  readiness() { throw new Error('PtyCore: provider must implement readiness()'); }
  onSpawned() {}
  startSidecars() {}
  stopSidecars() {}
  handleEarlyExit() { return false; }
  afterStart() {}

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
    const spec = this.buildSpawn();

    this.pty = this._spawn(spec.bin, spec.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd || process.cwd(),
      env: spec.env || { ...process.env, TERM: 'xterm-256color' },
    });

    this.onSpawned(spec);

    this.#attachEmulator();

    // PTY stdout drives two listeners:
    //   1) the persistent terminal (so its buffer always has the
    //      latest claude output — read by zoom on mount/re-mount)
    //   2) liveness for stuck-detection in toJSON()
    try {
      this._spawnProbeBuf = ''; // first output after (re)spawn — read on early exit
      this._spawnTs = Date.now(); // per-(re)spawn clock for the early-refusal window (0396)
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
      // claude). _teardownForRestart / kill() dispose this sub, and #onExit
      // double-checks identity in case an exit was already queued.
      const spawnedPty = this.pty;
      this._exitSub = this.pty.onExit(({ exitCode, signal }) => this.#onExit(exitCode, signal, spawnedPty));
    } catch {}

    this.startSidecars();

    // R1: queue any send()s that arrive during the banner-draw window.
    this.paused = false; // fresh process is not stopped (P6/0408)
    this.#armReadiness();

    this.afterStart();
    this.emit('change');
  }

  // Construct the persistent emulator ONCE per agent. Every byte claude
  // writes lands here for the agent's lifetime, not just while zoom is
  // open — that's what gives the user "no lost state" on re-zoom. Only
  // built when Terminal is available (skipped in unit tests using the
  // spawn stub).
  //
  // 0402: start() used to dispose and rebuild the Terminal on EVERY spawn,
  // so a restart threw the whole scrollback away. Measured on a live agent
  // at rows=50, one start() call: buffer len 226 → 27, maxOffset 176 → 0.
  // PtyPane computes maxOffset = max(0, length - rows), so every scroll key
  // clamped to 0 and Ctrl+Y entered a mode that could not move. start() is
  // reached from auto-restart, the send/zoom revives, changePermissionMode
  // and changeModel — the user hits the last two on purpose. Reuse the
  // emulator instead, and resize it only when the geometry actually moved.
  #attachEmulator() {
    const canEmulate = Terminal && typeof Terminal === 'function';
    if (canEmulate && this.term) {
      // Reuse path — the buffer IS the user's history, keep it. Resizing is
      // the only adjustment a restart can need (Fleet.setViewport can have
      // changed cols/rows while this agent had no live PTY).
      if (this.term.cols !== this.cols || this.term.rows !== this.rows) {
        try { this.term.resize(this.cols, this.rows); } catch {}
      }
      // Seam marker: --resume reprints context, so without a break the
      // replayed transcript reads as the old conversation continuing.
      // It lands in the VIEWPORT, and claude's post---resume repaint (measured
      // in 0402: EL 2K x98 + CUU x50) erases the viewport, so the marker
      // usually survives only until claude's first repaint. Kept because it is
      // free and it does hold on the auto-restart paths that don't repaint —
      // the scrollback above the viewport survives either way (ED J x0).
      try { this.term.write('\r\n── session restarted ──\r\n'); } catch {}
    } else if (canEmulate) {
      try {
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
        //
        // 0402: these MUST stay inside the build-once branch. The term now
        // outlives a restart, so registering per spawn would stack a second
        // handler on the same emulator and every clipboard write / bell would
        // fire twice after one changeModel.
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
  }

  // R1: sends queue until the provider's readiness() says the CLI can take
  // input. A fixed delay is a single timer; a predicate is re-polled on the
  // same readyTimer handle so every clear path (exit, kill, teardown) stops it.
  #armReadiness() {
    this.ready = false;
    const becomeReady = () => {
      this.readyTimer = null;
      this.ready = true;
      this.#drainPendingSends();
    };
    const r = this.readiness() || {};
    if (typeof r.predicate === 'function') {
      const pollMs = r.pollMs ?? DEFAULT_READY_POLL_MS;
      const poll = () => {
        let ok = false;
        try { ok = !!r.predicate(this); } catch {}
        if (ok) becomeReady();
        else this.readyTimer = setTimeout(poll, pollMs);
      };
      this.readyTimer = setTimeout(poll, pollMs);
      return;
    }
    this.readyTimer = setTimeout(becomeReady, r.delayMs ?? 0);
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
    this.stopSidecars();
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.killed) return;
    if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;
    this.appendTail({ kind: 'sys', text: `process exited code=${code} signal=${signal || ''}` });

    if (this.handleEarlyExit(code, signal)) return;

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
    } else {
      // 0412: every OTHER way the process can end used to leave the card
      // reporting a healthy session over a process that no longer exists.
      // `transient` is `code !== 0 && code != null`, and node-pty reports a
      // signal death as exit code ZERO with the signal as a number, so a
      // claude killed by the system running out of memory, by Activity
      // Monitor, or by `killall` took this path — as did a user typing /exit.
      // Measured: code=0 -> idle, code=0 signal=9 -> idle, code=null -> idle.
      // A deliberate kill returns long before here, so reaching this point
      // means the process died on its own and nothing is going to restart it.
      this.appendTail({
        kind: 'err',
        text: signal
          ? `session ended (signal ${signal}) — K clears the slot`
          : 'session ended — K clears the slot',
      });
      this.status = 'error';
    }
    this.emit('change');
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
    this.stopSidecars();
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

  // Shared teardown for changePermissionMode / changeModel — they both
  // need to drop the current PTY without triggering auto-restart, then
  // start() will spawn a fresh one with --resume.
  _teardownForRestart() {
    this.stopSidecars();
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
    // real terminal (see #onBell gate in #attachEmulator()). Cleared in dispose().
    this.zoomAttached = true;
    // S1 (0408): the OSC 52 handler in #attachEmulator() is gated on
    // this.zoomAttached (and drops '?' read requests), so a background agent
    // can no longer reach the user's clipboard — same gate class as the bell.
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
}
