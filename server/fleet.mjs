// server/fleet.mjs — configurable-slot fleet + pub-sub.
//
// The UI addresses agents by `slot`. Each slot is either an empty
// placeholder or a live Agent instance. Subscribers receive a snapshot
// on every state change. The slot count is settable per-instance via
// `new Fleet({ slots })` — the caller reads `settings.maxSlots` from
// disk before construction. Hot-changing the cap mid-session is
// intentionally NOT supported; live agents would have nowhere to go.

import { EventEmitter } from 'node:events';
import { Agent } from './agent.mjs';
import { MockAgent } from './mockAgent.mjs';
import { PtyAgent } from './ptyAgent.mjs';

const DEFAULT_SLOTS = 10;

// When MC_MOCK is set, every launch instantiates a MockAgent that replays
// the named fixture instead of spawning a real `claude` subprocess. The
// value is the fixture name (`MC_MOCK=approval-request`), resolved under
// server/fixtures/<name>.jsonl. Used to iterate on Zoom UX without
// burning API spend; see server/mockAgent.mjs.
const MOCK_FIXTURE = process.env.MC_MOCK || null;

// Single-pipeline rewrite — PtyAgent (one claude PTY per slot, JSONL is
// single source of truth) is now the default. Set FLEET_USE_PTY=0 to
// fall back to the legacy stream-json Agent for emergency rollback
// while Phase E sweep is still pending. After Phase E lands and the
// old Agent class is deleted, this flag goes away entirely.
// See .claude/plans/single-pipeline-rewrite.md.
const USE_PTY = process.env.FLEET_USE_PTY !== '0';

function emptySlot(slot) {
  return {
    id: `empty-${slot}`,
    slot,
    status: 'empty',
    name: null,
    model: null,
  };
}

export class Fleet extends EventEmitter {
  constructor({ slots = DEFAULT_SLOTS } = {}) {
    super();
    // Clamp to a sensible band — anything outside this hints at a bad
    // settings file rather than a real preference.
    this.slots = Math.max(1, Math.min(64, slots | 0 || DEFAULT_SLOTS));
    // agents[slot-1] is either an Agent instance or null (empty slot)
    this.agents = new Array(this.slots).fill(null);
    this.sessionStart = Date.now();
    // Default per-slot cost cap, propagated to every Agent on launch
    // and on settings changes via setCostCap(). 0 = disabled.
    this.defaultCostCapUSD = 0;
  }

  snapshot() {
    return {
      sessionStart: this.sessionStart,
      now: Date.now(),
      slots: this.slots,
      agents: this.agents.map((a, i) => a ? a.toJSON() : emptySlot(i + 1)),
    };
  }

  agentBySlot(slot) {
    return this.agents[slot - 1] || null;
  }

  agentById(id) {
    return this.agents.find((a) => a && a.id === id) || null;
  }

  launch({ slot, cwd, branch, model, name, permissionMode, prompt, sessionId, resume }) {
    if (slot < 1 || slot > this.slots) throw new Error(`bad slot ${slot}`);
    if (this.agents[slot - 1]) throw new Error(`slot ${slot} already occupied`);
    const id = `s${slot}-${Date.now().toString(36)}`;
    // 0188: getter for the sessionIds of the OTHER live slots, evaluated lazily
    // (only when this slot's tailer hunts for a rotation), so it reflects the
    // current fleet — including any re-points that already happened. Excludes
    // this slot by index. PtyAgent forwards it to the tailer as claimedSids.
    const siblingSids = () =>
      this.agents.filter((a, i) => a && i !== slot - 1).map((a) => a.sessionId).filter(Boolean);
    // Selection order: MOCK_FIXTURE always wins (test/dev replay), then
    // FLEET_USE_PTY chooses the new single-pipeline class, otherwise
    // fall back to the legacy stream-json Agent.
    const agent = MOCK_FIXTURE
      ? new MockAgent({ slot, id, cwd, branch, model, name, permissionMode, sessionId, fixture: MOCK_FIXTURE })
      : USE_PTY
        ? new PtyAgent({ slot, id, cwd, branch, model, name, permissionMode, sessionId, resume, siblingSids })
        : new Agent({ slot, id, cwd, branch, model, name, permissionMode, sessionId, resume });
    agent.costCapUSD = this.defaultCostCapUSD;
    agent.on('change', () => this.emit('change', this.snapshot()));
    this.agents[slot - 1] = agent;
    agent.start();
    if (prompt) {
      // small defer so the system 'init' event lands before the first user msg
      setTimeout(() => agent.send(prompt), 250);
    }
    this.emit('change', this.snapshot());
    return agent;
  }

  // Resume a previously-persisted session in the given slot. The caller
  // provides the saved record from the session store; we wire its
  // sessionId back through launch() with resume=true so claude rehydrates
  // the transcript from disk.
  resume({ slot, sessionId, cwd, branch, model, name, permissionMode }) {
    if (!sessionId) throw new Error(`no sessionId — nothing to resume`);
    return this.launch({
      slot, cwd, branch, model, name,
      permissionMode: permissionMode || 'acceptEdits',
      sessionId,
      resume: true,
      prompt: null,
    });
  }

  kill(id) {
    const idx = this.agents.findIndex((a) => a && a.id === id);
    if (idx < 0) return false;
    const agent = this.agents[idx];
    agent.kill();
    this.agents[idx] = null;
    this.emit('change', this.snapshot());
    return true;
  }

  // Send `text` to every targeted slot. When staggerMs > 0 the per-session
  // sends are spaced out (i * staggerMs) so we don't open N streaming API
  // connections in the same instant — a self-induced ECONNRESET / overload
  // risk with several live slots.
  //
  // 0070: a PAUSED (SIGSTOPped) agent can't receive — the write would just
  // queue in its stdin buffer and surface confusingly when it resumes. So we
  // skip paused (and empty/unknown) targets and report the split: returns
  // { sent, skipped } so the caller can toast "skipped N" rather than silently
  // implying every slot got the message. Late per-send failures (e.g. a cost
  // cap) still aren't reflected — they're surfaced on the slot itself.
  broadcast(targetIds, text, staggerMs = 0) {
    const live = [];
    let skipped = 0;
    for (const id of targetIds) {
      const a = this.agentById(id);
      if (!a || a.status === 'paused') { skipped++; continue; }
      live.push(a);
    }
    const gap = Math.max(0, staggerMs | 0);
    live.forEach((a, i) => {
      if (gap === 0 || i === 0) {
        try { a.send(text); } catch {}
      } else {
        setTimeout(() => { try { a.send(text); } catch {} }, gap * i);
      }
    });
    return { sent: live.length, skipped };
  }

  killAll() {
    for (const a of this.agents) if (a) a.kill();
  }

  // Propagate a new default per-slot cost cap to every live agent and
  // to the fleet's stored default (used when new sessions launch).
  // Emits 'change' so any UI showing the cap state refreshes.
  setCostCap(usd) {
    this.defaultCostCapUSD = Number(usd) || 0;
    for (const a of this.agents) {
      if (a) a.costCapUSD = this.defaultCostCapUSD;
    }
    this.emit('change', this.snapshot());
  }

  // Per-slot override — `:cap 3 10` only changes slot 3, leaving the
  // default and other slots untouched. Returns false if the slot is
  // empty so the caller can toast appropriately.
  setSlotCostCap(slot, usd) {
    const a = this.agents[slot - 1];
    if (!a) return false;
    a.costCapUSD = Number(usd) || 0;
    this.emit('change', this.snapshot());
    return true;
  }
}
