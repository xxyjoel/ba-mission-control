// server/deriveStatus.mjs — 0293/0285: pure base-status derivation.
//
// One rule replaces the three lopsided branches in ptyAgent.toJSON():
// **the newest signal wins.** Two signal clocks exist —
//   • hookStatus @ hookStatusTs      (Claude lifecycle hooks, NDJSON feed)
//   • connectorStatus @ lastConnectorTs (transcript JSONL events)
// — and the old code only compared them in the hookStatus==='idle' branch.
// 'waiting' was unconditional (stale INPUT? shown while streaming work) and
// 'working' was sticky until a Stop that is dropped in ~8% of real feeds
// (fixtures/status-corpus/6776f170-dropped-stop; live specimen 2026-08-12:
// gtm-gov-miner card read WORKING 31.9 min after its turn_duration).
//
// Also introduces the BLIND state (live specimen, same day): a session with
// no hook feed AND no transcript ever attached has ZERO signals — the old
// code displayed the connector default 'idle' with full confidence. Blind
// must be visible, not guessed over.
//
// Pure on purpose (plan: .claude/plans/status-accuracy.md, W1): no clocks,
// no scrapers, no I/O — callers pass scan results in. Deterministic and
// replay-testable against captured feeds.

/**
 * @param {object} s
 * @param {'idle'|'working'|'waiting'|'paused'|'error'|null} s.hookStatus
 *        Last hook-derived status; null = no hook event ever seen.
 * @param {number} s.hookStatusTs   ms epoch of that hook event (0 = never).
 * @param {'idle'|'working'|'waiting'|'paused'|'error'} s.connectorStatus
 *        JSONL connector's current status (its default is 'idle').
 * @param {number} s.lastConnectorTs ms epoch of the last REAL JSONL event
 *        (0 = transcript never attached / no event parsed).
 * @param {boolean} s.approvalScan  Result of the gated approval scraper
 *        (already freshness-gated by the caller; false when not run).
 * @param {boolean} s.workingScan   Un-hooked fallback only: gated
 *        #scanWorking() result (false when not run).
 * @param {number} [now]  ms epoch for staleness decisions (injectable for
 *        tests/replay; defaults to Date.now()).
 * @returns {{ status: string, approvalWaiting: boolean,
 *             signalHealth: 'hooked'|'unhooked'|'blind' }}
 */

// The intra-turn idle flash: claude emits end_turn/turn_duration mid-work
// and keeps going, so the connector legitimately reads 'idle' for 3-14s
// while a tool is still outstanding (0198/0250/0253 — the reason the old
// code made hook-working sticky). Newest-wins alone would re-break that.
// The bridge: a newer connector-idle only defeats hook-working once the
// idle evidence has AGED past this window. The dropped-Stop failure this
// exists to fix ages far beyond it (live specimen: 31.9 minutes).
export const WORKING_IDLE_GRACE_MS = 60_000;

export function deriveBaseStatus(s, now = Date.now()) {
  const {
    hookStatus, hookStatusTs = 0,
    connectorStatus, lastConnectorTs = 0,
    approvalScan = false, workingScan = false,
  } = s;

  if (hookStatus == null) {
    // UN-hooked fallback — legacy Agent path or PTY session before its first
    // hook event. Same overlay semantics as before, scrapers included: the
    // terminal is still a live signal even when the feeds are absent.
    //
    // BLIND is metadata, not a bypass: zero hook events AND zero JSONL
    // events means the two authoritative feeds are dark — the card should
    // say so — but the PTY scrapers still run (they are how an otherwise
    // invisible session can still surface working/approval).
    const workingOverlay = connectorStatus === 'idle' && workingScan;
    const baseStatus = workingOverlay ? 'working' : connectorStatus;
    const approvalWaiting = baseStatus === 'working' && approvalScan;
    return {
      status: approvalWaiting ? 'waiting' : baseStatus,
      approvalWaiting,
      signalHealth: lastConnectorTs === 0 ? 'blind' : 'unhooked',
    };
  }

  // HOOKED: newest signal wins, symmetrically. A hook event and a JSONL
  // event each carry a timestamp; believe the fresher one. Ties go to the
  // hook (it is the more intentional signal: Stop/PreToolUse are lifecycle
  // facts, JSONL inference is derived).
  let base = hookStatusTs >= lastConnectorTs ? hookStatus : connectorStatus;

  // End_turn-flash bridge (see WORKING_IDLE_GRACE_MS): while a tool is
  // outstanding (hook 'working'), a newer-but-YOUNG connector 'idle' is a
  // mid-turn flash, not a finished session — hold 'working' until the idle
  // evidence ages past the grace window. Only then has the Stop provably
  // been dropped (RC1b) and idle is the truth.
  if (
    hookStatus === 'working' && base === 'idle'
    && (now - lastConnectorTs) < WORKING_IDLE_GRACE_MS
  ) {
    base = 'working';
  }

  // The approval fast-path survives arbitration: while the winning signal is
  // 'working', a settled terminal showing a real permission box means the
  // session is blocked on the human ~10-20s before the permission_prompt
  // hook lands. (Scan is gated by the caller exactly as before.)
  const approvalWaiting = base === 'working' && approvalScan;
  return {
    status: approvalWaiting ? 'waiting' : base,
    approvalWaiting,
    signalHealth: 'hooked',
  };
}
