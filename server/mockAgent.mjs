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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const TAIL_MAX = 40;
const SPARK_LEN = 15;

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
    this.spark = Array(SPARK_LEN).fill(1);
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
    this.tail.push({ ...ln, ts: Date.now() });
    while (this.tail.length > TAIL_MAX) this.tail.shift();
  }

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
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      workingStartTs: this.workingStartTs,
      tail: this.tail.slice(-16),
      mock: true,
    };
  }
}
