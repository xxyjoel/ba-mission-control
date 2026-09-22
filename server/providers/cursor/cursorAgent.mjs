// server/providers/cursor/cursorAgent.mjs — Cursor slot backend (0420 phase 4).
//
// Extends PtyCore like PtyAgent. One `cursor-agent` PTY per slot; status from
// transcript + PTY scrape via deriveStatus; cost/tokens stay null until usage
// sync (phase 6). Hooks install deferred — TODO(cursor-hooks).

import { execFileSync } from 'node:child_process';
import { deriveStatus } from '../../deriveStatus.mjs';
import { PtyCore, bottomContentRows } from '../../ptyCore.mjs';
import { pushTail } from '../../jsonlConnector.mjs';
import { fullStatus } from '../../git.mjs';
import { TAIL_SHIP } from '../../../tui/lib/settings.js';
import { dlog } from '../../../tui/lib/debugLog.js';
import { getProvider, cursorModeArgs } from '../index.mjs';
import { cursorModelArg } from './models.mjs';
import {
  detectTrustPrompt, detectReady, detectWorking, detectApproval,
} from './ptySignals.mjs';
import { startCursorTranscriptTailer } from './transcriptTailer.mjs';

const SCAN_ROWS = 16;
const CREATE_CHAT_TIMEOUT_MS = 10_000;

// Ctrl+Y opens Cursor's chat picker — conflicts with MC Zoom SCROLL.
// Zoom relocates later; do not edit zoomKeys here.
// TODO(cursor-zoom-reserved): Zoom chrome must move SCROLL off Ctrl+Y for cursor slots.
export const CURSOR_RESERVED_KEYS = ['SCROLL'];

// Sync mint — Fleet.launch → start() is sync; create-chat is ~1.6s argv-only.
function defaultMintChat({ bin }) {
  const out = execFileSync(bin, ['create-chat'], {
    timeout: CREATE_CHAT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  });
  const id = String(out || '').trim().split(/\s+/)[0];
  if (!id) throw new Error('create-chat returned empty id');
  return id;
}

function stripAnthropicEnv(src) {
  const env = { ...src };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_')) delete env[k];
  }
  return env;
}

export class CursorAgent extends PtyCore {
  constructor({
    slot,
    id,
    name,
    cwd,
    branch,
    model = 'cursor:auto',
    permissionMode = 'default',
    sessionId = null,
    resume = false,
    spawn,
    cols,
    rows,
    // Pass --trust when settings.cursorAutoTrust is on (D3; default off).
    autoTrust = false,
    // Hook guard token (phase 5). Present so spawn env is ready.
    slotToken = null,
    // Injectable create-chat (tests).
    mintChat = defaultMintChat,
  } = {}) {
    super({ spawn, cols, rows });
    this.provider = 'cursor';
    this.reservedKeys = CURSOR_RESERVED_KEYS.slice();
    this.slot = slot;
    this.id = id || `slot-${slot}`;
    this.name = name;
    this.cwd = cwd;
    this.branch = branch;
    this.model = model;
    this.resolvedModel = null;
    this.permissionMode = permissionMode;
    this.sessionId = sessionId || null;
    this.resuming = !!resume || !!sessionId;
    this.autoTrust = !!autoTrust;
    this.slotToken = slotToken;
    this._mintChat = mintChat;

    this.workingStartTs = null;
    this.stateSince = Date.now();
    this.spawnedAt = Date.now();
    this.sessionStartedAt = null;
    this.turnCount = 0;
    this.messageCount = 0;
    this.status = 'idle';
    // Unknown until usage sync (D1) — never fabricate 0.
    this.context = null;
    this.tokensIn = null;
    this.tokensCacheRead = null;
    this.tokensOut = null;
    this.costSession = null;
    this.pendingSubagents = new Map();
    this.dirty = 0;
    this.ahead = 0;
    this.behind = 0;
    this.spark = null;
    this.lastTokSampleTs = Date.now();
    this.lastTokRate = 0;
    this.activity = 'Awaiting first instruction';
    this.tail = [];
    this.todos = [];
    this.tailer = null;
    this.lastConnectorTs = 0;
    this.lastSubHookTs = 0;
    this.awaitingPrompt = null;
    this.awaitingPromptTs = 0;
    this.costCapUSD = 0;
    this.hookStatus = null;
    this.hookStatusTs = 0;
  }

  // Mint a chat id before the first PTY spawn when the caller didn't supply one.
  async ensureSessionId() {
    if (this.sessionId) return this.sessionId;
    const bin = getProvider('cursor').bin();
    const out = this._mintChat({ bin, args: ['create-chat'] });
    this.sessionId = String(await Promise.resolve(out)).trim();
    this.resuming = true;
    return this.sessionId;
  }

  // PtyCore.start is sync; mint via sync create-chat (or injectable) first.
  start() {
    if (!this.sessionId) {
      const bin = getProvider('cursor').bin();
      try {
        const out = this._mintChat({ bin, args: ['create-chat'] });
        if (out && typeof out.then === 'function') {
          throw new Error('CursorAgent: call ensureSessionId() before start() when mintChat is async');
        }
        this.sessionId = String(out).trim();
        this.resuming = true;
      } catch (e) {
        this.appendTail({ kind: 'err', text: `create-chat failed: ${e.message}` });
        this.status = 'error';
        this.emit('change');
        return;
      }
    }
    super.start();
  }

  buildSpawn() {
    const bin = getProvider('cursor').bin();
    const args = ['--resume', this.sessionId];
    const modelArg = cursorModelArg(this.model);
    if (modelArg) args.push('--model', modelArg);
    args.push(...cursorModeArgs(this.permissionMode));
    if (this.cwd) args.push('--workspace', this.cwd);
    if (this.autoTrust) args.push('--trust');

    const env = stripAnthropicEnv(process.env);
    env.TERM = 'xterm-256color';
    if (this.slotToken) env.MC_SLOT_TOKEN = this.slotToken;

    return { bin, args, env, modelArg };
  }

  onSpawned({ modelArg }) {
    const kind = this.resuming ? 'resume' : 'spawn';
    dlog('pty', kind, { slot: this.slot, pid: this.pty?.pid, model: modelArg, provider: 'cursor', sid: String(this.sessionId).slice(0, 8) });
    this.appendTail({
      kind: 'sys',
      text: `${kind} pid=${this.pty.pid} model=${modelArg || this.model} cwd=${this.cwd} provider=cursor${this.resuming ? ` session=${String(this.sessionId).slice(0, 8)}` : ''}`,
    });
  }

  startSidecars() {
    // TODO(cursor-hooks): install/merge ~/.cursor/hooks.json status emitter on Connect.
    try {
      this.tailer = startCursorTranscriptTailer({ agent: this, drive: 'external' });
    } catch (e) {
      this.appendTail({ kind: 'err', text: `cursor tailer start failed: ${e.message}` });
    }
  }

  stopSidecars() {
    if (this.tailer) {
      try { this.tailer.stop(); } catch {}
      this.tailer = null;
    }
  }

  readiness() {
    return {
      pollMs: 250,
      predicate: (core) => {
        try {
          const rows = bottomContentRows(core.term, SCAN_ROWS);
          if (detectTrustPrompt(rows)) return false;
          return detectReady(rows);
        } catch {
          return false;
        }
      },
    };
  }

  afterStart() {
    this.refreshGit().catch(() => {});
  }

  tailerTick() {
    try { this.tailer?.tick?.(); } catch {}
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

  appendTail(ln) {
    pushTail(this, ln);
  }

  approve() {
    return this.send('y');
  }

  addNote(text) {
    if (!text || !text.trim()) return false;
    this.appendTail({ kind: 'note', text: text.trim() });
    this.emit('change');
    return true;
  }

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
    this._teardownForRestart();
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
    this._teardownForRestart();
    this.resuming = true;
    this.start();
    return true;
  }

  #scanApproval() {
    try { return detectApproval(bottomContentRows(this.term, SCAN_ROWS)); }
    catch { return false; }
  }

  #scanWorking() {
    try { return detectWorking(bottomContentRows(this.term, SCAN_ROWS)); }
    catch { return false; }
  }

  #collectSignals() {
    // Trust dialog → surface as waiting (connector) so the card shows INPUT?
    // even before deriveStatus overlays.
    let connectorStatus = this.status;
    try {
      const rows = bottomContentRows(this.term, SCAN_ROWS);
      if (detectTrustPrompt(rows)) connectorStatus = 'waiting';
    } catch {}
    return {
      hookStatus: this.hookStatus ?? null,
      hookStatusTs: this.hookStatusTs ?? 0,
      connectorStatus,
      lastConnectorTs: this.lastConnectorTs,
      lastPtyTs: this.lastPtyTs,
      awaitingPrompt: this.awaitingPrompt,
      awaitingPromptTs: this.awaitingPromptTs,
      lastEventTs: this.lastEventTs,
      lastSubHookTs: this.lastSubHookTs,
      pendingSubagents: this.pendingSubagents,
      hasPty: !!this.pty,
      paused: this.status === 'paused',
      errored: this.status === 'error',
      scanApproval: () => this.#scanApproval(),
      scanWorking: () => this.#scanWorking(),
      liveSubAgents: () => [],
    };
  }

  toJSON() {
    const { status, stuckMin, bgCount, bgStatus, activeSubagents } =
      deriveStatus(this.#collectSignals(), Date.now());
    return {
      id: this.id,
      slot: this.slot,
      name: this.name,
      model: this.model,
      resolvedModel: this.resolvedModel,
      provider: 'cursor',
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
      procCpu: this.procCpu || 0,
      procMemKb: this.procMemKb || 0,
      lastTokRate: this.lastTokRate || 0,
      activity: this.activity,
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      workingStartTs: this.workingStartTs,
      spawnedAt: this.spawnedAt,
      sessionStartedAt: this.sessionStartedAt ?? null,
      claudeVersion: null,
      stateSince: this.stateSince,
      turnCount: this.turnCount,
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      stuckMin,
      bgCount,
      bgStatus,
      costCapUSD: this.costCapUSD,
      capReached: this.costCapUSD > 0 && (this.costSession ?? 0) >= this.costCapUSD,
      apiErrorCount: this.apiErrorCount || 0,
      lastApiErrorTs: this.lastApiErrorTs || 0,
      tail: this.tail.slice(-TAIL_SHIP),
      todos: this.todos.slice(),
      reservedKeys: this.reservedKeys.slice(),
    };
  }
}
