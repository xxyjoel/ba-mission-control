// server/deriveStatus.mjs — the one status function (0285/0286, W1).
//
// deriveStatus(signals, now) turns one slot's signal bundle into the status
// fields the card reads: status, stuckMin, bgCount/bgStatus, activeSubagents.
// It used to live inline in PtyAgent.toJSON(); it moved here verbatim so a
// second provider (Cursor, 0420) derives status with the same tested rules
// instead of a copy that drifts.
//
// Pure: no I/O, no timers, no Date.now(). The caller reads the clock once and
// passes it as `now`. Terminal-buffer detectors arrive as thunks
// (scanApproval / scanWorking / liveSubAgents) rather than values for two
// reasons: they stay lazy — the scrapes run per painted frame per agent (0364)
// and most branches never need them — and each provider supplies its own
// detectors (claude's "esc to interrupt" is not cursor-agent's spinner). A
// thunk that throws reads as false / [] (fails closed), matching the old
// try/catch wrappers in PtyAgent.
//
// signals (see PtyAgent#collectSignals):
//   hookStatus        'working'|'waiting'|'idle'|null — null = un-hooked
//   hookStatusTs      ms of the last status-mapping hook event
//   connectorStatus   the stored transcript-derived status (_statusValue || 'idle')
//   lastConnectorTs   ms of the last transcript event (JSONL-only clock)
//   lastPtyTs         ms of the last PTY byte (PTY-only clock)
//   lastEventTs       ms of any activity (PTY + transcript) — the stuck clock
//   lastSubHookTs     ms of the last SUB-tagged hook event (0398)
//   awaitingPrompt    connector's blocking-prompt object or null
//   awaitingPromptTs  ms it was set (collected; not read by the rules yet)
//   pendingSubagents  Map<id,{label,type,startTs}> of outstanding Task/Workflow
//   hasPty            a live process is attached
//   paused, errored   connectorStatus === 'paused' / 'error'
//   scanApproval()    → bool: a permission prompt is on screen
//   scanWorking()     → bool: an active-turn indicator is on screen
//   liveSubAgents({withinMs, now}) → [{id, lastGrowTs}] sub-agent files still growing
//
// Returns { status, approvalWaiting, stuckMin, bgCount, bgStatus,
// activeSubagents, reason }. `reason` names the branch that decided status
// (W5 explainability); nothing reads it for behavior.

import { BG_SUB_ACTIVE_MS } from './bgSessions.mjs';

// How recently claude must have written PTY bytes for the idle→working overlay
// to trust a lingering "esc to interrupt" hint. A live spinner repaints well
// inside this window; a session that finished (or stalled) stops writing, so
// its frozen last frame won't keep the card 'working'. Generous enough to ride
// out a slow spinner refresh between tool calls.
export const WORKING_FRESH_MS = 2500;

// 0403: an outstanding Task/Workflow older than this is treated as abandoned and
// stops counting toward bgCount. Mirrors SUBAGENT_STALE_MS in jsonlConnector,
// which sweeps the same Map — kept as its own constant so ptyAgent does not
// import a private value across the connector boundary.
export const BG_ABANDON_MS = 30 * 60 * 1000;

export const STUCK_MIN_THRESHOLD = 5;

function tryBool(fn) {
  try { return !!fn?.(); } catch { return false; }
}

export function deriveStatus(signals, now) {
  const {
    hookStatus = null,
    hookStatusTs = 0,
    connectorStatus = 'idle',
    lastConnectorTs = 0,
    lastPtyTs = 0,
    lastEventTs = 0,
    lastSubHookTs = 0,
    awaitingPrompt = null,
    pendingSubagents = new Map(),
    hasPty = false,
    errored = false,
    scanApproval,
    scanWorking,
    liveSubAgents,
  } = signals || {};

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
  //   • scanWorking() — the "esc to interrupt" hint is in the rendered
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
  // hook event), fall back to the pre-hook connector + scanWorking/scanApproval
  // overlay, unchanged — that path still needs the scrapers.
  const ptyFresh = (now - lastPtyTs) < WORKING_FRESH_MS;
  let status;
  let reason;
  let approvalWaiting = false;
  if (hookStatus != null) {
    if (hookStatus === 'waiting') {
      status = 'waiting';                       // permission_prompt confirmed
      reason = 'hook-waiting';
    } else if (hookStatus === 'working' && awaitingPrompt?.tool) {
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
      reason = 'hook-tool-prompt';
    } else if (hookStatus === 'working') {
      // A tool is outstanding (PreToolUse, no Stop yet). Sticky 'working' until
      // Stop — covers the intra-turn end_turn flash (0198) with NO scanWorking.
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
      approvalWaiting = !ptyFresh && tryBool(scanApproval);
      status = approvalWaiting ? 'waiting' : 'working';
      reason = approvalWaiting ? 'hook-working-approval-scrape' : 'hook-working';
    } else {
      // hookStatus === 'idle' (Stop/idle_prompt). Idle wins when the Stop is
      // fresher than the last JSONL event (lastConnectorTs — JSONL-only, so PTY
      // repaint chatter can't keep the connector looking fresher; real-app
      // verify, 2026-07-01). If the connector is freshly 'working' (a text-only
      // turn with no PreToolUse), the connector wins so streaming reads working.
      const hookFresher = hookStatusTs > lastConnectorTs;
      status = hookFresher ? 'idle' : connectorStatus;
      reason = hookFresher ? 'hook-idle' : 'hook-idle-connector-fresher';
    }
  } else {
    // UN-hooked fallback — the 0180/0198/0200 overlay, unchanged. scanWorking
    // bridges the turn-boundary idle window (needs BOTH the "esc to interrupt"
    // hint AND fresh PTY output, else an idle frozen frame pins 'working'
    // forever); scanApproval overlays 'waiting' on a rendered prompt.
    const workingOverlay = connectorStatus === 'idle' && ptyFresh && tryBool(scanWorking);
    const baseStatus = workingOverlay ? 'working' : connectorStatus;
    approvalWaiting = baseStatus === 'working' && tryBool(scanApproval);
    status = approvalWaiting ? 'waiting' : baseStatus;
    reason = approvalWaiting ? 'connector-approval-scrape'
      : workingOverlay ? 'connector-working-scrape' : 'connector';
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
  // 0411 CONNECTOR → SUMMARY. The pairing map below tracks a FOREGROUND
  // fan-out correctly, but is always empty for BACKGROUND agents: their
  // tool_result is the launch receipt (claude prints "Backgrounded agent"),
  // not the finish, so each entry is added and deleted in the same turn.
  // The countable source is the one the usage tailer already reads — every
  // sub-agent writes its own agent-<id>.jsonl, and a file still being written
  // is an agent still working.
  let liveSubFiles = [];
  if (pendingSubagents.size === 0) {
    try {
      liveSubFiles = liveSubAgents?.({ withinMs: BG_SUB_ACTIVE_MS, now }) || [];
    } catch { liveSubFiles = []; }
  }
  let bgCount = 0;
  const bgCutoff = now - BG_ABANDON_MS;
  for (const s of pendingSubagents.values()) {
    if ((s?.startTs ?? 0) >= bgCutoff) bgCount++;
  }
  // Fall back to the hook clock when the transcript never showed the Task
  // (a background fork's sub events land in the status file with no matching
  // parent-transcript record — the gtm-gov-miner shape above).
  // 0408/D1: the 15s SUB_ACTIVE_MS window dropped the bg chip 12-43% of
  // fan-out time (sub-agent tool events arrive up to 166s apart, measured
  // gtm-gov-miner 2026-09-16). Use bgSessions' 60s window for the chip;
  // SUB_ACTIVE_MS still serves its other, tighter callers.
  // Real count first: one per live agent file.
  if (bgCount === 0 && liveSubFiles.length > 0) bgCount = liveSubFiles.length;
  // Last resort — a background fork whose sub events reach the status file
  // with no transcript record and no per-agent file. Work IS happening but is
  // not countable, so report it as uncounted instead of inventing a number.
  // The card renders an uncounted-but-live chip as '?bg', never as '1bg'.
  if (bgCount === 0 && now - (lastSubHookTs || 0) < BG_SUB_ACTIVE_MS) bgCount = null;
  const bgStatus = (bgCount === null || bgCount > 0) ? 'working' : null;

  // A slot whose claude is GONE must never report idle. #onExit sets
  // this.status = 'error' when auto-restart is exhausted, but that value was
  // then thrown away: toJSON derives `status` fresh from the hook and
  // transcript clocks, and none of those branches look at the stored error.
  // The last signals a dead session left behind are a Stop hook and a quiet
  // transcript, which read exactly like a healthy idle session.
  //
  // Seen on crm-helper 2026-09-19: the fleet log said "auto-restart
  // exhausted (3 attempts) — leaving slot errored", no claude process for
  // that slot existed, and the card still showed IDLE while the header
  // counted err 0. An errored slot that looks idle is worse than a visibly
  // broken one — the user has no reason to press K and recover it.
  if (!hasPty && errored) { status = 'error'; reason = 'error-no-pty'; }
  // STUCK is a wedge signal: claude alive but silent ≥5 min (lastEventTs — the
  // any-activity clock, PTY+JSONL — goes stale). Never on a card parked on the
  // user (waiting) or done (idle). Hooked: only a stuck outstanding tool
  // (hookStatus==='working') can wedge. Un-hooked: original semantics — key off
  // the connector _statusValue so an overlay-bridged 'working' (real status
  // idle) never accrues stuck.
  // Active sub-agents run on sidechains the tailer never reads, so the
  // main-thread lastEventTs goes stale while they work — that must NOT read as
  // wedged. Suppress STUCK whenever fan-out is outstanding.
  // TODO(stuck-waiting): the hooked 0384 tool-prompt branch reads 'waiting'
  // but still accrues stuck (approvalWaiting stays false there), and so does
  // an un-hooked stored 'waiting'. Pinned as-is by the 0420 characterization
  // tests; 0295 invariant 5 wants stuck never beside waiting — change it on
  // purpose with a card-level test, not as a refactor side effect.
  const subagentsActive = pendingSubagents.size > 0;
  let stuckMin = 0;
  const stuckEligible = !subagentsActive && (hookStatus != null
    ? (hookStatus === 'working' && !approvalWaiting)
    : ((connectorStatus === 'working' || connectorStatus === 'waiting') && !approvalWaiting));
  if (stuckEligible) {
    const m = Math.floor((now - lastEventTs) / 60000);
    if (m >= STUCK_MIN_THRESHOLD) stuckMin = m;
  }
  // Snapshot in-flight fan-out for the card / Zoom. Elapsed derived at read.
  const activeSubagents = pendingSubagents.size > 0
    ? [...pendingSubagents.values()]
        .sort((a, b) => a.startTs - b.startTs)
        .map((s) => ({ label: s.label, type: s.type, elapsedMs: now - s.startTs }))
    // 0411: name the background fan-out from its files so the zoom list and
    // the card chip agree instead of the list sitting empty beside a count.
    : liveSubFiles.map((a) => ({
        label: `agent ${String(a.id).slice(0, 8)}`,
        type: 'agent',
        elapsedMs: now - a.lastGrowTs,
      }));

  return { status, approvalWaiting, stuckMin, bgCount, bgStatus, activeSubagents, reason };
}
