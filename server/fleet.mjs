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
import { listClaudeSessions, backgroundSessionCount, otherLiveSessionsInRepo, onSessionsChanged } from './claudeSessions.mjs';
import { isSandboxed } from '../tui/lib/configDir.js';
import { clampPtyDims } from '../tui/lib/zoomGeometry.js';
import { Agent } from './agent.mjs';
import { MockAgent } from './mockAgent.mjs';
import { PtyAgent } from './ptyAgent.mjs';
import { samplePids } from './procStats.mjs';
import { getProvider } from './providers/index.mjs';

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
// the tailer poll. 0463: each run costs 0.10 s CPU and 156 MB peak memory;
// every 20 s that was ~0.5% of a core at any fleet size. Background sessions
// change on the order of minutes, so 120 s at idle, plus one refresh soon
// after a slot launches, is killed or its process exits (the moments the
// list is most likely to move). The delay coalesces a burst — `:resume-all`
// launching ten slots — into one listing.
const SESSION_POLL_MS = 120_000;
const SESSION_REFRESH_DEBOUNCE_MS = 2000;
// 0463: what a listing change is judged on — every background field (state
// and staleness show on screen), and for attached sessions only what
// otherLiveSessionsInRepo reads, so their idle/working flicker wakes nothing.
function sessionsKey(list) {
  if (!list) return 'null';
  return JSON.stringify([
    list.background ?? null,
    (list.attached ?? []).map((e) => [e?.sessionId ?? null, e?.cwd ?? null]),
  ]);
}
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
  #listSessions = listClaudeSessions;
  #timers = { setTimeout, clearTimeout };
  #sessionRefreshTimer = null;
  #sessionInflight = false;
  #sessionRefreshAgain = false;
  #offSessionsChanged = null;
  // 0448: agents with a per-slot cap (setSlotCostCap) that setCostCap skips.
  #capOverrides = new WeakSet();

  constructor({ slots = DEFAULT_SLOTS, viewport = null, agentFactories = {}, listSessions = null, timers = null } = {}) {
    super();
    // 0463: test seams for the session poll — the listing and the clock.
    this.#listSessions = listSessions || listClaudeSessions;
    this.#timers = timers || { setTimeout, clearTimeout };
    // 0420: builders for non-Claude slots, keyed by provider id:
    // `(launchOpts) → agent` with the PtyAgent surface. Claude never goes
    // through here — its selection order below is fixed.
    this.agentFactories = { ...agentFactories };
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
    // 0441: agents killed out of agents[] whose process has not ended yet.
    // kill() frees the slot at once (`:clear` relaunches into it 50 ms later),
    // so without this set hardKillAll could not reach a claude that ignored
    // the SIGTERM. Each agent leaves the set on its 'stopped' event.
    this.stopping = new Set();
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
    // 0463: an injected listing forks nothing, so it is allowed anywhere.
    this.#sessionPollEnabled = listSessions ? true : !MOCK_FIXTURE && !isSandboxed();
    if (this.#sessionPollEnabled) {
      this.#scheduleSessionPoll(0);
      // 0463: a `claude rm` from the TUI must not leave its row for 120 s.
      this.#offSessionsChanged = onSessionsChanged(() => this.#requestSessionRefresh());
    }
    this.#scheduleTailerPoll(TAILER_POLL_MS);
  }

  // 0381: shared tailer driver — see TAILER_POLL_MS above. setTimeout chain
  // (not setInterval) so the cadence self-adjusts to fleet activity.
  // Refresh claude's session list. Spawning a process is not free, so this
  // runs on its own slow timer and never on a render.
  #scheduleSessionPoll(ms) {
    if (this.#sessionTimer) this.#timers.clearTimeout(this.#sessionTimer);
    this.#sessionTimer = this.#timers.setTimeout(async () => {
      this.#sessionTimer = null;
      // 0463: a refresh that lands while a listing is running waits for it,
      // then runs once — never two claude forks at a time.
      if (this.#sessionInflight) { this.#sessionRefreshAgain = true; return; }
      this.#sessionInflight = true;
      try {
        // 0463: skip listClaudeSessions' 5 s cache. A refresh can land inside
        // it (a slot exiting 3 s after its launch refresh; the run-again path
        // right after a listing) and would get the stale copy.
        const next = await this.#listSessions({ cacheMs: 0 });
        if (next) {
          // Any change matters, not just the count: a session going from
          // blocked to working, or crossing the one-day staleness line, must
          // wake the UI too.
          // 0463: `attached` feeds each card's otherSessions count too.
          const before = sessionsKey(this.claudeSessions);
          this.claudeSessions = next;
          if (before !== sessionsKey(next)) this.emit('change');
        }
      } catch { /* a listing failure leaves the previous answer in place */ }
      this.#sessionInflight = false;
      // stopPolling() ran while the listing was in flight: stay stopped.
      if (!this.#sessionPollEnabled) return;
      const again = this.#sessionRefreshAgain;
      this.#sessionRefreshAgain = false;
      this.#scheduleSessionPoll(again ? 0 : SESSION_POLL_MS);
    }, ms);
    this.#sessionTimer.unref?.();
  }

  // 0463: a slot launched, was killed or its process exited. Refresh the list
  // once, SESSION_REFRESH_DEBOUNCE_MS from the first such event; the listing
  // then restarts the 120 s cadence.
  #requestSessionRefresh() {
    if (!this.#sessionPollEnabled || this.#sessionRefreshTimer) return;
    this.#sessionRefreshTimer = this.#timers.setTimeout(() => {
      this.#sessionRefreshTimer = null;
      if (this.#sessionPollEnabled) this.#scheduleSessionPoll(0);
    }, SESSION_REFRESH_DEBOUNCE_MS);
    this.#sessionRefreshTimer.unref?.();
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
        j.provider = j.provider ?? a.provider ?? 'claude';
        // 0420: claude's session list says nothing about another provider's
        // conversations, so for those slots the count is unknown.
        // TODO(provider-other-sessions): derive it for Cursor from
        // ~/.cursor/chats/<md5(cwd)>/*/meta.json.
        const others = j.provider === 'claude'
          ? otherLiveSessionsInRepo(this.claudeSessions, { cwd: a.cwd, sessionId: a.sessionId })
          : null;
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

  launch({ slot, cwd, branch, model, name, permissionMode, prompt, sessionId, resume, provider = 'claude', autoTrust = false }) {
    if (slot < 1 || slot > this.slots) throw new Error(`bad slot ${slot}`);
    if (this.agents[slot - 1]) throw new Error(`slot ${slot} already occupied`);
    const descriptor = getProvider(provider);
    if (!descriptor) throw new Error(`unknown provider ${provider}`);
    const factory = provider === 'claude' ? null : this.agentFactories[provider];
    if (provider !== 'claude' && typeof factory !== 'function') {
      throw new Error(`${descriptor.label} sessions are not available yet`);
    }
    const id = `s${slot}-${Date.now().toString(36)}`;
    // 0188: getter for the sessionIds of the OTHER live slots, evaluated lazily
    // (only when this slot's tailer hunts for a rotation), so it reflects the
    // current fleet — including any re-points that already happened. Excludes
    // this slot by index. PtyAgent forwards it to the tailer as claimedSids.
    const siblingSids = () =>
      this.agents.filter((a, i) => a && i !== slot - 1).map((a) => a.sessionId).filter(Boolean);
    // 0454: one live slot per session id. Resuming a sid already live in
    // another slot ran two claudes on one transcript (two pids, one sid) and
    // gave two cards one conversation — the identity shape behind 0365.
    if (sessionId && siblingSids().includes(sessionId)) {
      const other = this.agents.findIndex((a, i) => a && i !== slot - 1 && a.sessionId === sessionId) + 1;
      throw new Error(`session ${String(sessionId).slice(0, 8)} is already live in slot ${other}`);
    }
    // Selection order for claude: MOCK_FIXTURE always wins (test/dev replay),
    // then FLEET_USE_PTY chooses the new single-pipeline class, otherwise
    // fall back to the legacy stream-json Agent. Other providers are built by
    // their registered factory.
    // TODO(cursor-mock): MC_MOCK promises no real subprocess; once a Cursor
    // factory exists, MockAgent needs a provider so Cursor fixtures replay.
    const agent = factory
      ? factory({
        slot, id, cwd, branch, model, name, permissionMode, sessionId, resume, siblingSids,
        cols: this.viewport?.cols,
        rows: this.viewport?.rows,
        autoTrust: !!autoTrust,
      })
      : MOCK_FIXTURE
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
    // An agent class may declare its own provider (possibly as a getter).
    if (agent.provider == null) agent.provider = provider;
    agent.costCapUSD = this.defaultCostCapUSD;
    // Forward each agent's high-frequency 'change' as a PAYLOAD-LESS fleet
    // event. Computing this.snapshot() here — eagerly, on every JSONL line /
    // status transition across all agents — was the dominant idle-CPU cost:
    // snapshot() runs toJSON() on every agent (incl. terminal-buffer scans).
    // The sole consumer (App.jsx) now recomputes the snapshot once per painted
    // frame inside its coalesced flush, so it runs per-frame, not per-event.
    // 0463: a slot whose process goes away (pid → none) refreshes claude's
    // session list once. One property read per change event.
    let hadProcess = false;
    agent.on('change', () => {
      // PtyCore agents hold `pty`; the stream-json Agent holds `proc`.
      const live = !!(agent.pty || agent.proc);
      if (hadProcess && !live) this.#requestSessionRefresh();
      hadProcess = live;
      this.emit('change');
    });
    this.agents[slot - 1] = agent;
    agent.start();
    hadProcess = !!(agent.pty || agent.proc);
    this.#requestSessionRefresh();
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
  resume({ slot, sessionId, cwd, branch, model, name, permissionMode, provider = 'claude', autoTrust = false }) {
    if (!sessionId) throw new Error(`no sessionId — nothing to resume`);
    // TODO(resume-overlap): 0441: an agent in this.stopping may still run
    // claude on this same sessionId for up to STOP_GRACE_MS after a kill, so
    // resuming inside that window briefly runs two claudes on one transcript.
    // Wait for that agent's 'stopped' before launching.
    return this.launch({
      slot, cwd, branch, model, name,
      permissionMode: permissionMode || (provider === 'claude' ? 'acceptEdits' : 'default'),
      sessionId,
      resume: true,
      prompt: null,
      provider,
      autoTrust,
    });
  }

  kill(id) {
    const idx = this.agents.findIndex((a) => a && a.id === id);
    if (idx < 0) return false;
    const agent = this.agents[idx];
    agent.kill();
    // 0441: PtyCore agents SIGKILL themselves at STOP_GRACE_MS; until the
    // process ends, keep the agent reachable for hardKillAll.
    if (agent.stopping) {
      this.stopping.add(agent);
      // 0463: refresh once the process is gone; at +2 s it may still be
      // inside its SIGTERM grace and still listed.
      agent.once('stopped', () => { this.stopping.delete(agent); this.#requestSessionRefresh(); });
    } else {
      this.#requestSessionRefresh(); // 0463
    }
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
    if (this.#sessionTimer) { this.#timers.clearTimeout(this.#sessionTimer); this.#sessionTimer = null; }
    if (this.#sessionRefreshTimer) { this.#timers.clearTimeout(this.#sessionRefreshTimer); this.#sessionRefreshTimer = null; }
    this.#sessionPollEnabled = false; // 0463: no refresh after shutdown
    if (this.#offSessionsChanged) { this.#offSessionsChanged(); this.#offSessionsChanged = null; }
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
    // 0441: and every killed agent whose process is still stopping.
    for (const a of [...this.stopping]) { try { a.hardKill?.(); } catch {} }
  }

  // Propagate a new default per-slot cost cap to every live agent and
  // to the fleet's stored default (used when new sessions launch).
  // Emits 'change' so any UI showing the cap state refreshes.
  // 0448: an agent given its own cap via setSlotCostCap keeps it; only the
  // slots still on the default follow the new value.
  setCostCap(usd) {
    this.defaultCostCapUSD = Number(usd) || 0;
    for (const a of this.agents) {
      if (a && !this.#capOverrides.has(a)) a.costCapUSD = this.defaultCostCapUSD;
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
    this.#capOverrides.add(a); // 0448: keyed by agent, so a relaunch starts on the default
    // TODO(0448): no verb puts a slot back on the default (e.g. `:cap <slot> default`);
    // today only a relaunch clears the override. `:cap <slot> 0` also counts as one.
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
