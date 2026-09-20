// server/fleet.mjs — configurable-slot fleet + pub-sub.
//
// The UI addresses agents by `slot`. Each slot is either an empty
// placeholder or a live Agent instance. Subscribers receive a snapshot
// on every state change. The slot count is set per-instance via
// `new Fleet({ slots })` (the caller reads `settings.maxSlots` from disk
// before construction) and can be changed live with `setSlots(n)` —
// growing appends empty slots; shrinking only drops trailing EMPTY slots,
// never a live agent (so the floor is the highest occupied slot).

import { EventEmitter } from 'node:events';
import { listClaudeSessions, backgroundSessionCount, otherLiveSessionsInRepo } from './claudeSessions.mjs';
import { isSandboxed } from '../tui/lib/configDir.js';
import { clampPtyDims } from '../tui/lib/zoomGeometry.js';
import { Agent } from './agent.mjs';
import { MockAgent } from './mockAgent.mjs';
import { PtyAgent } from './ptyAgent.mjs';
import { samplePids } from './procStats.mjs';

const DEFAULT_SLOTS = 10;

// 0381: one shared backstop wakeup for every live agent's tailers. Each
// PtyAgent used to own three phase-scattered 1500ms intervals (session JSONL,
// status hooks, subagent usage) — 30 timers at 10 slots kept the event loop
// waking ~20×/s at idle (energy review 2026-08, finding 3). A single
// fleet-level timer drives them all in ONE wakeup, and stretches to 3s when
// the whole fleet is idle (any working/waiting agent restores full cadence on
// the next tick). Unref'd so a dangling Fleet never blocks process exit.
const TAILER_POLL_MS = 1500;
// Reading claude's session list spawns a process, so it runs far slower than
// the tailer poll. Background sessions change on the order of minutes, not
// frames; 20 s is well inside that and costs one short-lived process.
const SESSION_POLL_MS = 20_000;
const TAILER_POLL_IDLE_MS = 3000;
// 0387: per-agent CPU/RSS sampling rides the same tick, divided — one `ps`
// fork per PROC_SAMPLE_EVERY ticks (→ 3s active / 6s idle) covering all pids.
const PROC_SAMPLE_EVERY = 2;

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
  #tailerTimer = null;
  #sessionTimer = null;
  #sessionPollEnabled = false;

  constructor({ slots = DEFAULT_SLOTS, viewport = null } = {}) {
    super();
    // 0404: the PTY geometry every agent spawns at and keeps. One size for the
    // whole fleet, computed from the real terminal by tui/lib/zoomGeometry.js.
    // null = unknown (tests / non-TTY) → agents fall back to their 80x24
    // default. See setViewport for why this is deliberately sticky.
    this.viewport = null;
    // Clamp to a sensible band — anything outside this hints at a bad
    // settings file rather than a real preference.
    this.slots = Math.max(1, Math.min(64, slots | 0 || DEFAULT_SLOTS));
    // agents[slot-1] is either an Agent instance or null (empty slot)
    this.agents = new Array(this.slots).fill(null);
    // After agents[] exists — setViewport walks it.
    if (viewport) this.setViewport(viewport);
    this.sessionStart = Date.now();
    // Default per-slot cost cap, propagated to every Agent on launch
    // and on settings changes via setCostCap(). 0 = disabled.
    this.defaultCostCapUSD = 0;
    // 0412: claude's own session list. Mission Control does not create
    // background sessions, but it is the only place the user looks, so a
    // session running outside the fleet must not be invisible here.
    // null = we have not been able to read the list, which is NOT the same as
    // "there are none" and must never render as a zero.
    this.claudeSessions = null;
    // Reading the list forks the real claude binary. Mock mode promises "no
    // real claude subprocess will spawn", and a sandboxed run must not touch
    // the user's live sessions either — the verification pass caught this
    // returning the user's real session data inside a test that had stubbed
    // the binary. Same gate the model probes use at boot.
    this.#sessionPollEnabled = !MOCK_FIXTURE && !isSandboxed();
    if (this.#sessionPollEnabled) this.#scheduleSessionPoll(0);
    this.#scheduleTailerPoll(TAILER_POLL_MS);
  }

  // 0381: shared tailer driver — see TAILER_POLL_MS above. setTimeout chain
  // (not setInterval) so the cadence self-adjusts to fleet activity.
  // Refresh claude's session list. Spawning a process is not free, so this
  // runs on its own slow timer and never on a render.
  #scheduleSessionPoll(ms) {
    this.#sessionTimer = setTimeout(async () => {
      try {
        const next = await listClaudeSessions();
        if (next) {
          // Any change matters, not just the count: a session going from
          // blocked to working, or crossing the one-day staleness line, must
          // wake the UI too.
          const before = JSON.stringify(this.claudeSessions?.background ?? null);
          this.claudeSessions = next;
          if (before !== JSON.stringify(next.background)) this.emit('change');
        }
      } catch { /* a listing failure leaves the previous answer in place */ }
      this.#scheduleSessionPoll(SESSION_POLL_MS);
    }, ms);
    this.#sessionTimer.unref?.();
  }

  #scheduleTailerPoll(ms) {
    this.#tailerTimer = setTimeout(() => this.#tailerPollTick(), ms);
    this.#tailerTimer.unref?.();
  }

  #tailerPollTick() {
    let active = false;
    for (const a of this.agents) {
      if (!a) continue;
      try { a.tailerTick?.(); } catch {}
      if (a.status === 'working' || a.status === 'waiting') active = true;
    }
    if ((this.#tailerTickCount++ % PROC_SAMPLE_EVERY) === 0) this.#sampleProcStats();
    this.#scheduleTailerPoll(active ? TAILER_POLL_MS : TAILER_POLL_IDLE_MS);
  }

  #tailerTickCount = 0;
  #procSampleInflight = false;

  // 0387: one `ps` covering every live agent pid → agent.procCpu (% of one
  // core) / agent.procMemKb (RSS KiB), surfaced on the card. emit('change')
  // only when the ROUNDED display values move so a steady process doesn't
  // trigger a render per sample.
  #sampleProcStats() {
    if (this.#procSampleInflight) return;
    const byPid = new Map();
    for (const a of this.agents) {
      const pid = a?.pty?.pid ?? a?.child?.pid;
      if (Number.isInteger(pid) && pid > 0) byPid.set(pid, a);
    }
    if (!byPid.size) return;
    this.#procSampleInflight = true;
    samplePids([...byPid.keys()]).then((stats) => {
      this.#procSampleInflight = false;
      for (const [pid, a] of byPid) {
        const s = stats.get(pid);
        if (!s) continue; // pid gone mid-sample — leave last known values
        const changed = Math.round(a.procCpu || 0) !== Math.round(s.cpu)
          || Math.round((a.procMemKb || 0) / 1024) !== Math.round(s.rssKb / 1024);
        a.procCpu = s.cpu;
        a.procMemKb = s.rssKb;
        if (changed) a.emit?.('change');
      }
    }).catch(() => { this.#procSampleInflight = false; });
  }

  snapshot() {
    return {
      sessionStart: this.sessionStart,
      now: Date.now(),
      slots: this.slots,
      // 0414: each live slot also carries how many OTHER conversations claude
      // holds in the same folder. A card that shows one of three sessions with
      // nothing to say which is how a user lost track of a long requirements
      // list on 2026-09-19. null = the listing could not be read, never 0.
      agents: this.agents.map((a, i) => {
        if (!a) return emptySlot(i + 1);
        const j = a.toJSON();
        const others = otherLiveSessionsInRepo(this.claudeSessions, { cwd: a.cwd, sessionId: a.sessionId });
        j.otherSessions = others ? others.length : null;
        return j;
      }),
      // claude's own view of what is running. `background` is null when the
      // list could not be read — unknown, not none.
      background: this.claudeSessions ? this.claudeSessions.background : null,
    };
  }

  // 0404: set the PTY geometry for the whole fleet. Applied to new agents at
  // spawn and to every live agent immediately.
  //
  // This is the ONLY thing that resizes a live claude: claude reprints its
  // entire frame on SIGWINCH and the pre-resize copy stays in the emulator's
  // scrollback, so a resize is never free — one extra (wrongly-wrapped) copy
  // of the conversation per widening. Zoom enter/exit, toasts and the optional
  // zoom panels therefore no longer resize anything; only a real terminal
  // resize does, where the user expects a repaint. Returns the number of live
  // agents that actually changed size (0 when the geometry is unchanged).
  setViewport({ cols, rows } = {}) {
    // Garbage in (a non-TTY reporting 0, an undefined dimension) must leave the
    // fleet on whatever geometry it already had — never shrink it to a floor.
    if (!(cols > 0 && rows > 0)) return 0;
    const next = clampPtyDims(cols, rows);
    if (this.viewport && this.viewport.cols === next.cols && this.viewport.rows === next.rows) return 0;
    this.viewport = next;
    let resized = 0;
    for (const a of this.agents) {
      if (!a || typeof a.resize !== 'function') continue;
      try { if (a.resize(next.cols, next.rows) !== false) resized++; } catch {}
    }
    return resized;
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
        ? new PtyAgent({
          slot, id, cwd, branch, model, name, permissionMode, sessionId, resume, siblingSids,
          // 0404: spawn straight into the zoom body geometry so zooming never
          // has to resize (a resize duplicates claude's frame in the buffer).
          cols: this.viewport?.cols,
          rows: this.viewport?.rows,
        })
        : new Agent({ slot, id, cwd, branch, model, name, permissionMode, sessionId, resume });
    agent.costCapUSD = this.defaultCostCapUSD;
    // Forward each agent's high-frequency 'change' as a PAYLOAD-LESS fleet
    // event. Computing this.snapshot() here — eagerly, on every JSONL line /
    // status transition across all agents — was the dominant idle-CPU cost:
    // snapshot() runs toJSON() on every agent (incl. terminal-buffer scans).
    // The sole consumer (App.jsx) now recomputes the snapshot once per painted
    // frame inside its coalesced flush, so it runs per-frame, not per-event.
    agent.on('change', () => this.emit('change'));
    this.agents[slot - 1] = agent;
    agent.start();
    if (prompt) {
      // small defer so the system 'init' event lands before the first user msg
      setTimeout(() => agent.send(prompt), 250);
    }
    this.emit('change');
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
    this.emit('change');
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

  // Stop the background pollers. Called on shutdown so a pending listing can
  // never fire against a torn-down fleet.
  stopPolling() {
    if (this.#tailerTimer) { clearTimeout(this.#tailerTimer); this.#tailerTimer = null; }
    if (this.#sessionTimer) { clearTimeout(this.#sessionTimer); this.#sessionTimer = null; }
  }

  killAll() {
    for (const a of this.agents) if (a) a.kill();
  }

  // hardKillAll — SIGKILL any child that survived killAll()'s SIGTERM.
  // Shutdown escalation only: a wedged claude (permission prompt, daemon
  // entanglement) that ignores SIGTERM holds its PTY handle open and stalls
  // mc's quit forever; the force-close that follows orphans it into claude's
  // daemon as a background agent, which then blocks resuming that session.
  hardKillAll() {
    for (const a of this.agents) if (a) a.hardKill?.();
  }

  // Propagate a new default per-slot cost cap to every live agent and
  // to the fleet's stored default (used when new sessions launch).
  // Emits 'change' so any UI showing the cap state refreshes.
  setCostCap(usd) {
    this.defaultCostCapUSD = Number(usd) || 0;
    for (const a of this.agents) {
      if (a) a.costCapUSD = this.defaultCostCapUSD;
    }
    this.emit('change');
  }

  // Per-slot override — `:cap 3 10` only changes slot 3, leaving the
  // default and other slots untouched. Returns false if the slot is
  // empty so the caller can toast appropriately.
  setSlotCostCap(slot, usd) {
    const a = this.agents[slot - 1];
    if (!a) return false;
    a.costCapUSD = Number(usd) || 0;
    this.emit('change');
    return true;
  }

  // Resize the live fleet when `settings.maxSlots` changes, so the setting
  // takes effect without an mc restart. Growing appends empty slots.
  // Shrinking only removes trailing EMPTY slots — never a live agent — so
  // the effective floor is the highest occupied slot (a request below that
  // is clamped, and the returned value tells the caller what actually took).
  // Clamped to the same 1..64 band as the constructor. Emits 'change'.
  setSlots(n) {
    const target = Math.max(1, Math.min(64, n | 0 || DEFAULT_SLOTS));
    if (target === this.slots) return this.slots;
    if (target > this.slots) {
      for (let i = this.slots; i < target; i++) this.agents.push(null);
      this.slots = target;
    } else {
      let highestOccupied = 0;
      for (let i = 0; i < this.agents.length; i++) {
        if (this.agents[i]) highestOccupied = i + 1;
      }
      const floored = Math.max(target, highestOccupied, 1);
      this.agents.length = floored; // truncates trailing nulls only
      this.slots = floored;
    }
    this.emit('change');
    return this.slots;
  }
}
