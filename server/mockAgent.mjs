// server/mockAgent.mjs — fixture-driven Agent stand-in.
//
// Why: iterating on Zoom UX (spinner, thinking blocks, approval banners,
// scrollback) requires reliably reproducing event shapes from a real
// `claude` subprocess. Burning a real API session for every UI tweak is
// slow and costs money. MockAgent reads a JSONL fixture and replays
// "directives" onto the same EventEmitter / snapshot shape Agent exposes,
// so the TUI can't tell the difference.
//
// Fixture schema (one directive per line):
//
//   {"delay":N, "kind":"<type>", ...payload}
//
// Supported kinds:
//   sys           — append a system tail entry          (text)
//   status        — set status                          (status: 'working'|'waiting'|'idle'|'error')
//   asst-stream   — append text to activity, throttled  (text)
//   asst          — append assistant tail entry         (text, preview?, awaitingPrompt?)
//   think         — append thinking tail entry          (text, preview?)
//   tool          — append tool-use tail entry          (tool, text)
//   tool-result   — append tool-result tail entry       (text, is_error?)
//   approval      — set status='waiting' + approval-kind awaitingPrompt
//                   (tool, summary, input?)
//   wait-user     — pause replay until next .send() call (no payload)
//   tokens        — bump usage counters                 (in, out, ctx?)
//   cost          — increment session cost              (delta)
//   result        — turn-complete event                 (cost?, status?, num_turns?)
//
// Deviation from the plan: the plan called for "newline-delimited
// stream-json events identical to what a real claude emits." Replaying
// raw stream-json would mean duplicating Agent's #handle event parser,
// which is in flux. The directive schema above is one abstraction layer
// higher — it maps 1:1 to the tail entries the UI actually renders, so
// fixtures stay readable and tests stay decoupled from event-shape
// churn. Real stream-json fixtures can be reintroduced later if a need
// arises (recorded sessions for regression).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushTail } from './jsonlConnector.mjs';
import { TAIL_SHIP } from '../tui/lib/settings.js';
import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg.default || xtermPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const SPARK_LEN = 15;
// 0444: the mock's zoom emulator. Same bound as the legacy zoom Terminal.
const ZOOM_SCROLLBACK = 5000;

// 0444: one tail entry as the lines a zoom view shows. Plain text with a
// claude-like prefix; \n becomes \r\n so the emulator starts each line at col 0.
function tailToTerm(ln) {
  const text = String(ln.text || '');
  const prefix = {
    user: '\u276f ', asst: '\u25cf ', think: '\u2234 ', note: '# ', err: '! ', sys: '  ',
    'tool-result': '  \u23bf ',
  }[ln.kind] ?? '  ';
  const head = ln.kind === 'tool' ? `\u23fa ${ln.tool || 'tool'}: ` : prefix;
  return `${head}${text}\r\n`.replace(/\r?\n(?!$)/g, '\r\n  ');
}

function loadFixture(name) {
  const path = name.endsWith('.jsonl') ? name : join(FIXTURES_DIR, `${name}.jsonl`);
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new Error(`mock fixture not found: ${path} (${e.message})`); }
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch (e) { throw new Error(`bad fixture line ${i + 1} in ${path}: ${e.message}`); }
    });
}

export class MockAgent extends EventEmitter {
  constructor({ slot, id, name, cwd, branch, model = 'sonnet-4.6', permissionMode = 'acceptEdits', sessionId, fixture = 'quick-reply' }) {
    super();
    this.slot = slot;
    this.id = id || `slot-${slot}`;
    this.name = name;
    this.cwd = cwd;
    this.branch = branch;
    this.model = model;
    this.permissionMode = permissionMode;
    this.sessionId = sessionId || randomUUID();
    this.fixtureName = fixture;

    this.status = 'idle';
    this.context = 0;
    this.tokensIn = 0;
    this.tokensCacheRead = 0;   // fixtures carry no cache figures; stays 0 (shape parity)
    this.tokensOut = 0;
    this.costSession = 0;
    this.dirty = 0;
    this.ahead = 0;
    this.behind = 0;
    this.spark = Array(SPARK_LEN).fill(0); // 0385: blank cold-start — fill(1) rendered a FULL bar at 0 tok/min
    this.activity = 'Awaiting first instruction';
    this.tail = [];

    this.killed = false;
    this._directives = [];
    this._cursor = 0;
    this._timer = null;
    this._waitingForUser = false;
    this._changeTimer = null;
    // Track elapsed-time anchor for spinner parity with real Agent.
    this.workingStartTs = null;

    // 0444: zoom view state. The emulator is built on first attach and kept
    // for the agent's life (like PtyAgent), so re-zoom shows the whole replay.
    this._zoomTerm = null;
    this._zoomCell = null;
    this._zoomPty = null;
    this._zoomInput = '';
    // 0444: what the emulator currently shows of _zoomInput (see #redrawInput),
    // whether a bracketed paste is open, and the last resize from the fleet.
    this._zoomEcho = '';
    this._zoomPaste = false;
    this._zoomDims = null;
  }

  #scheduleChange() {
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.emit('change');
    }, 50);
  }

  #flushChange() {
    if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
    this.emit('change');
  }

  start() {
    try {
      this._directives = loadFixture(this.fixtureName);
    } catch (e) {
      this.appendTail({ kind: 'err', text: e.message });
      this.status = 'error';
      this.emit('change');
      return;
    }
    this.appendTail({
      kind: 'sys',
      text: `mock fixture=${this.fixtureName} session=${this.sessionId.slice(0, 8)}`,
    });
    this.emit('change');
    this.#advance();
  }

  #setStatus(next) {
    if (next === this.status) return;
    if (next === 'working' && !this.workingStartTs) this.workingStartTs = Date.now();
    if (next !== 'working') this.workingStartTs = null;
    this.status = next;
  }

  #applyDirective(d) {
    switch (d.kind) {
      case 'sys':
        this.appendTail({ kind: 'sys', text: d.text || '' });
        this.#flushChange();
        return;
      case 'status':
        this.#setStatus(d.status || 'idle');
        this.#flushChange();
        return;
      case 'asst-stream': {
        const text = d.text || '';
        this.activity = (this.activity + text).slice(-160);
        this.#setStatus('working');
        if (text.includes('\n')) this.#flushChange();
        else this.#scheduleChange();
        return;
      }
      case 'asst': {
        const text = d.text || '';
        const first = text.split('\n').find(l => l.trim()) || text;
        this.activity = first.slice(0, 200);
        this.appendTail({
          kind: 'asst',
          text: text.slice(0, 8000),
          preview: d.preview || first.slice(0, 240),
          awaiting: !!d.awaitingPrompt,
          awaitingPrompt: d.awaitingPrompt || null,
        });
        if (d.awaitingPrompt) this.#setStatus('waiting');
        this.#flushChange();
        return;
      }
      case 'think': {
        const text = d.text || '';
        this.appendTail({
          kind: 'think',
          text: text.slice(0, 8000),
          preview: d.preview || (text.split('\n').find(l => l.trim()) || '').slice(0, 240),
        });
        this.#flushChange();
        return;
      }
      case 'tool':
        this.appendTail({ kind: 'tool', tool: d.tool || 'Bash', text: d.text || '' });
        this.activity = `${d.tool || 'tool'}: ${d.text || ''}`.slice(0, 200);
        this.#flushChange();
        return;
      case 'tool-result': {
        const text = d.text || '';
        this.appendTail({
          kind: 'sys',
          text: `← tool_result ${d.is_error ? '(error)' : ''}\n${text.slice(0, 4000)}`,
          preview: `← tool_result ${d.is_error ? '(error)' : ''} ${text.slice(0, 160).replace(/\s+/g, ' ')}`,
        });
        this.#flushChange();
        return;
      }
      case 'approval': {
        this.#setStatus('waiting');
        this.appendTail({
          kind: 'asst',
          text: d.summary || d.tool || 'approval requested',
          preview: `↻ approval: ${d.tool || 'tool'} ${d.summary || ''}`.slice(0, 240),
          awaiting: true,
          awaitingPrompt: {
            kind: 'approval',
            tool: d.tool || 'Bash',
            summary: d.summary || '',
            input: d.input || null,
          },
        });
        this.#flushChange();
        return;
      }
      case 'wait-user':
        this._waitingForUser = true;
        return;
      case 'tokens':
        if (typeof d.in === 'number') this.tokensIn += d.in;
        if (typeof d.out === 'number') this.tokensOut += d.out;
        if (typeof d.ctx === 'number') this.context = d.ctx;
        this.#scheduleChange();
        return;
      case 'cost':
        if (typeof d.delta === 'number') this.costSession += d.delta;
        this.#scheduleChange();
        return;
      case 'result': {
        if (typeof d.cost === 'number') this.costSession += d.cost;
        this.#setStatus(d.status || 'idle');
        this.appendTail({
          kind: 'sys',
          text: `turn ok · ${d.num_turns || 1} turns · $${(d.cost || 0).toFixed(4)}`,
        });
        this.#flushChange();
        return;
      }
      default:
        this.appendTail({ kind: 'err', text: `unknown mock directive: ${d.kind}` });
        this.#flushChange();
    }
  }

  #advance() {
    if (this.killed) return;
    if (this._waitingForUser) return;
    if (this._cursor >= this._directives.length) return;
    const d = this._directives[this._cursor++];
    const delay = Math.max(0, typeof d.delay === 'number' ? d.delay : 50);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.#applyDirective(d);
      this.#advance();
    }, delay);
  }

  appendTail(ln) {
    pushTail(this, ln);   // shared ring: count cap + char cap + entry text cap
    // 0444: mirror the replay into the zoom emulator once one exists. Half-typed
    // input is lifted off first and put back under the new line, so replay
    // output never lands in the middle of what the user is typing.
    const term = this._zoomTerm;
    if (term) {
      const echo = this._zoomEcho;
      this.#eraseInput();
      try { term.write(tailToTerm(ln)); } catch {}
      if (echo) this.#redrawInput();
    }
  }

  // 0444: rows the echoed input fills at the emulator's current width. Counts
  // code points, so a wide character is under-counted; fine for a mock.
  #echoRows(text) {
    const cols = Math.max(1, this._zoomTerm?.cols || 80);
    let rows = 0;
    for (const seg of text.split('\n')) rows += Math.max(1, Math.ceil(Array.from(seg).length / cols));
    return rows;
  }

  // 0444: remove the echoed input. The cursor sits at its end, so go up to its
  // first row and erase to the end of the screen.
  #eraseInput() {
    const term = this._zoomTerm;
    if (!term || !this._zoomEcho) { this._zoomEcho = ''; return; }
    const up = Math.min(this.#echoRows(this._zoomEcho), term.rows || 1) - 1;
    try { term.write((up > 0 ? `\x1b[${up}A` : '') + '\r\x1b[J'); } catch {}
    this._zoomEcho = '';
  }

  #redrawInput() {
    const term = this._zoomTerm;
    if (!term) return;
    this.#eraseInput();
    if (!this._zoomInput) return;
    try { term.write(this._zoomInput.replace(/\n/g, '\r\n')); } catch {}
    this._zoomEcho = this._zoomInput;
  }

  // 0444: attachZoomView — PtyPane's zoom contract, without a process. Before
  // this, PtyPane fell back to startZoomSession, which spawned the real
  // CLAUDE_BIN with acceptEdits in mock mode. Returns the same shape as
  // PtyCore.attachZoomView: a stub pty plus an agent-owned xterm-headless
  // Terminal fed with the mock's replayed output (tests/lib/zoom-stub.js).
  attachZoomView({ cols = 80, rows = 24 } = {}) {
    if (!this._zoomTerm) {
      // A fleet resize that came first wins, as PtyAgent's emulator already
      // runs at the fleet viewport.
      ({ cols, rows } = this._zoomDims || { cols, rows });
      const term = new Terminal({
        cols: Math.max(1, cols | 0), rows: Math.max(1, rows | 0),
        allowProposedApi: true, scrollback: ZOOM_SCROLLBACK,
      });
      // Bracketed paste on, as claude sets it: PtyPane then wraps a paste in
      // ESC[200~ / ESC[201~ and writeInput keeps its newlines as content.
      term.write('\x1b[?2004h');
      for (const ln of this.tail) term.write(tailToTerm(ln));
      this._zoomTerm = term;
      this._zoomCell = term.buffer.active.getNullCell();
    }
    if (!this._zoomPty) {
      const handlers = { data: new Set(), exit: new Set() };
      const sub = (set, fn) => { set.add(fn); return { dispose: () => set.delete(fn) }; };
      this._zoomPty = {
        pid: undefined,   // no process; 0 would mean "my process group" to kill()
        write: (bytes) => { this.writeInput(bytes); },
        onData: (fn) => sub(handlers.data, fn),
        onExit: (fn) => sub(handlers.exit, fn),
        resize: (c, r) => { try { this._zoomTerm?.resize(c, r); } catch {} },
        kill: () => {},
        _fireExit: () => {
          for (const fn of [...handlers.exit]) { try { fn({ exitCode: 0, signal: null }); } catch {} }
        },
      };
    }
    return {
      pty: this._zoomPty,
      term: this._zoomTerm,
      cell: this._zoomCell,
      sessionId: this.sessionId,
      dispose: () => {},   // the emulator outlives the view, as on PtyAgent
    };
  }

  // 0444/0446: writeInput — zoom keystrokes land here, keyed like claude's
  // prompt: \r submits; a bare \n (PtyPane's NEWLINE key) and any newline
  // inside a bracketed paste add a line without submitting. The line is echoed
  // into the emulator; on submit it goes to send(), which releases a wait-user
  // directive. Other escape sequences (arrows, function keys) are dropped.
  // No cost cap on a mock.
  writeInput(bytes, _opts = {}) {
    if (this.killed) return false;
    const text = String(bytes ?? '');
    let lastCR = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\x1b') {
        if (text.startsWith('\x1b[200~', i)) { this._zoomPaste = true; i += 5; continue; }
        if (text.startsWith('\x1b[201~', i)) { this._zoomPaste = false; i += 5; continue; }
        // ESC, an optional [ or O, parameters, then the final letter or ~.
        const m = /^\x1b(?:[[O][0-9;?]*)?[A-Za-z~]?/.exec(text.slice(i));
        i += m[0].length - 1;
        continue;
      }
      const cr = ch === '\r';
      if (ch === '\n' && lastCR && this._zoomPaste) { lastCR = false; continue; }   // \r\n in a paste is one newline
      lastCR = cr;
      if (cr && !this._zoomPaste) {
        const line = this._zoomInput.trim();
        this._zoomInput = '';
        this.#eraseInput();   // send() writes it back as the user line
        if (line) this.send(line);
      } else if (cr || ch === '\n') {
        this._zoomInput += '\n';
      } else if (ch === '\x7f' || ch === '\b') {
        this._zoomInput = Array.from(this._zoomInput).slice(0, -1).join('');
      } else if (ch >= ' ') {
        this._zoomInput += ch;
      }
    }
    this.#redrawInput();
    return true;
  }

  // 0444: Fleet.setViewport calls this when the real terminal changes size,
  // as it does for PtyAgent. Resizes the zoom emulator; true when it changed.
  resize(cols, rows) {
    const c = Math.max(1, cols | 0), r = Math.max(1, rows | 0);
    this._zoomDims = { cols: c, rows: r };
    const term = this._zoomTerm;
    if (!term || (term.cols === c && term.rows === r)) return false;
    try { term.resize(c, r); } catch {}
    return true;
  }

  capMessage() { return null; }

  // .send() — mirrors Agent.send. Records the user message in the tail
  // and, if a wait-user directive is pending, releases replay so the
  // fixture can respond.
  send(text) {
    if (this.killed) return false;
    this.appendTail({ kind: 'user', text });
    if (this._waitingForUser) {
      this._waitingForUser = false;
      this.#setStatus('working');
      this.#flushChange();
      this.#advance();
    } else {
      this.#flushChange();
    }
    return true;
  }

  approve() { return this.send('yes, please continue with the proposed action'); }

  addNote(text) {
    if (!text || !text.trim()) return false;
    this.appendTail({ kind: 'note', text: text.trim() });
    this.emit('change');
    return true;
  }

  pause() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.appendTail({ kind: 'sys', text: 'SIGSTOP — process frozen (mock)' });
    this.#setStatus('paused');
    this.emit('change');
    return true;
  }

  resume() {
    this.appendTail({ kind: 'sys', text: 'SIGCONT — process resumed (mock)' });
    this.#setStatus('working');
    this.emit('change');
    this.#advance();
    return true;
  }

  kill() {
    this.killed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
    // 0444: an open zoom closes the way it does when claude exits.
    try { this._zoomPty?._fireExit(); } catch {}
  }

  changePermissionMode(mode) {
    if (!mode || mode === this.permissionMode) return false;
    this.permissionMode = mode;
    this.appendTail({ kind: 'sys', text: `permission: ${mode}` });
    this.emit('change');
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      slot: this.slot,
      name: this.name,
      model: this.model,
      branch: this.branch,
      dirty: this.dirty,
      ahead: this.ahead,
      behind: this.behind,
      status: this.status,
      context: this.context,
      activeSubagents: [],
      tokensIn: this.tokensIn,
      tokensCacheRead: this.tokensCacheRead,
      tokensOut: this.tokensOut,
      costSession: this.costSession,
      costWeek: 0,
      spark: this.spark,
      procCpu: this.procCpu || 0,      // 0387: %-of-one-core (ps pcpu)
      procMemKb: this.procMemKb || 0, // 0387: RSS KiB
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      workingStartTs: this.workingStartTs,
      tail: this.tail.slice(-TAIL_SHIP),   // whole ring — see PtyAgent.toJSON
      mock: true,
    };
  }
}
