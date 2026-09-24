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
// 0420: the provider-neutral PTY plumbing (spawn, persistent emulator,
// OSC 52 / bell gating, exit + auto-restart, pause/resume/kill, resize,
// zoom attach, the send path) lives in PtyCore (server/ptyCore.mjs) and status
// derivation in deriveStatus (server/deriveStatus.mjs). What stays here is
// everything that is claude: argv (--session-id / --resume / --settings
// hooks), the JSONL / status-hook / sub-agent usage tailers, the held-by-agent
// early-exit classifier, the version probe, model resolution, and claude's
// terminal detectors.
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

import { deriveStatus } from './deriveStatus.mjs';
import { PtyCore, bottomContentRows } from './ptyCore.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { MODELS, modelByCli } from '../tui/lib/models.js';
import { fullStatus } from './git.mjs';
import { claudeSessionPath, startSessionTailer } from './sessionFileTailer.mjs';
import { pushTail } from './jsonlConnector.mjs';
import { TAIL_SHIP } from '../tui/lib/settings.js';
import { startSubagentUsageTailer } from './subagentUsageTailer.mjs';
import { startStatusHookTailer } from './statusHookTailer.mjs';
import { stableEmitterPath } from './hookInstall.mjs';
import { classifyEarlyExit, findLedgerOwner } from './ledgerOwner.mjs';
import { probeClaudeVersion } from '../tui/lib/claudeVersion.js';
import { dlog } from '../tui/lib/debugLog.js';
import { buildHookSettings } from './hookSettings.mjs';

// Moved to ptyCore.mjs in 0420; re-exported so existing importers keep working.
export { pasteForSubmit, bottomContentRows } from './ptyCore.mjs';

// Absolute path to the hook emitter script. 0391: resolved through
// hookInstall's STABLE copy (~/.local/state/claude-mc/hook-runtime/) instead
// of the install dir — sessions bake this path at launch, and an install that
// later moves or vanishes (npx cache eviction, deleted stray copy) would
// otherwise break every hook in every still-running session (MODULE_NOT_FOUND
// spam, observed live 2026-08-28). Falls back to the in-install path if the
// stable copy can't be written.
const EMITTER_PATH = stableEmitterPath();

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SPARK_LEN = 15;

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

// WORKING_FRESH_MS (the PTY-freshness window the idle→working overlay and the
// hooked approval gate use) lives in deriveStatus.mjs with the rules it feeds.

// 0398: how recently a SUB-tagged hook event (background/subagent tool call,
// see statusHookTailer) must have landed for an idle main thread to still
// read 'working'. Background builders fire tools every few seconds; 15s of
// silence means they're done (or wedged — either way the main thread's idle
// verdict stands again).
const SUB_ACTIVE_MS = 15_000;

// detectWorking — true when the rendered rows show claude's active-turn
// interrupt hint. Pure (mirrors detectApprovalPrompt) so it's unit-testable.
export function detectWorking(rows) {
  if (!Array.isArray(rows)) return false;
  for (const r of rows) {
    if (r && WORKING_RX.test(r)) return true;
  }
  return false;
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

// UI-id → CLI-arg derivation. Same source of truth as agent.mjs +
// zoomSession.mjs so a new MODELS entry can't fall through to the
// literal friendly id (which claude rejects).
const MODEL_ARG = Object.fromEntries(
  Object.entries(MODELS).map(([id, m]) => [id, m.cliModel])
);

export class PtyAgent extends PtyCore {
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
    // R13: injectable spawn for unit tests (see PtyCore). Undefined → node-pty.
    spawn,
    // 0188: getter for the sessionIds owned by OTHER live slots, supplied by
    // Fleet. Forwarded to the tailer so a rotation hunt never re-points onto a
    // sibling slot's transcript. Defaults to claiming nothing.
    siblingSids = () => [],
    // 0404: fixed PTY geometry from Fleet's viewport (see PtyCore).
    cols,
    rows,
  } = {}) {
    super({ spawn, cols, rows });
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
    this._siblingSids = siblingSids;

    // UI-visible state — must match Agent.toJSON shape exactly.
    this.workingStartTs = null;
    // Per-agent session metrics (#12) — see agent.mjs for semantics.
    this.stateSince = Date.now();
    this.spawnedAt = Date.now();
    // 0409: epoch ms of the FIRST record in the session transcript — the true
    // age of the CONVERSATION, set by sessionFileTailer once it reads the
    // file. spawnedAt only measures this JS object's life: `new PtyAgent(...)`
    // runs again on every resume and on every Mission Control restart, so
    // seven slots relaunched from a saved set all read one second old. null
    // until the transcript is readable (a brand-new session has none yet).
    this.sessionStartedAt = null;
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

    // Internals (PTY / emulator / timer fields are PtyCore's)
    this.tailer = null;
    this.statusTailer = null;
    this.usageTailer = null;
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
    this.costCapUSD = 0;
  }

  // ── PtyCore provider hooks ────────────────────────────────────────────────

  buildSpawn() {
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

    return { bin: CLAUDE_BIN, args, modelArg };
  }

  onSpawned({ modelArg }) {
    const kind = this.resuming ? 'resume' : 'spawn';
    dlog('pty', kind, { slot: this.slot, pid: this.pty?.pid, model: modelArg, sid: String(this.sessionId).slice(0, 8) });
    this.appendTail({
      kind: 'sys',
      text: `${kind} pid=${this.pty.pid} model=${modelArg} cwd=${this.cwd}${this.resuming ? ` session=${this.sessionId.slice(0, 8)}` : ''}`,
    });
    // 0333: the claude version this process launched on (cached probe —
    // refreshed by `:update`). Live processes keep their inode across
    // on-disk updates, so this is what drift is measured against.
    this.claudeVersion = probeClaudeVersion();
  }

  startSidecars() {
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
  }

  stopSidecars() {
    if (this.tailer) {
      try { this.tailer.stop(); } catch {}
      this.tailer = null;
    }
    try { this.statusTailer?.stop(); } catch {}
    this.statusTailer = null;
    try { this.usageTailer?.stop(); } catch {}
    this.usageTailer = null;
  }

  handleEarlyExit() {
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
        text: `session is held by a claude background session — ${ownerStr}. \`claude stop ${String(this.sessionId || '').slice(0, 8)}\` then :resume this slot (or \`claude attach ${String(this.sessionId || '').slice(0, 8)}\` outside mc)`,
      });
      this.activity = 'held by a background session — not retrying';
      this.status = 'error';
      this.emit('change');
      return true;
    }
    return false;
  }

  // R1: a fixed banner-draw window, not a scrape — claude's composer is ready
  // well inside it and there is no pre-composer dialog to wait out.
  readiness() {
    return { delayMs: READY_MS };
  }

  afterStart() {
    this.refreshGit().catch(() => {});
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

  // One append path with the connector (jsonlConnector.pushTail): same TAIL_MAX
  // ring, same per-entry text ceiling, same per-agent char budget. This used to
  // push raw — an unbounded stderr/error string landed in the ring at full
  // length, which is exactly what a 5× larger ring cannot afford.
  appendTail(ln) {
    pushTail(this, ln);
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

  // markUserSubmitted — called by PtyPane the moment a user-typed
  // prompt is submitted (Enter / \r forwarded to the PTY). Flips
  // status to 'working' and refreshes lastEventTs synchronously, so
  // the card UI reflects intent immediately instead of waiting the
  // 200-800ms for claude to commit the JSONL user event. parseEvent
  // will subsequently confirm via the JSONL stream (idempotent).
  // Programmatic sends (send/broadcast/approve) already flip status
  // via PtyCore's write path; this method covers the zoom-typed path
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
  // bundle for the pure deriveStatus(signals, now) function (W1/0284).
  // Pure gathering: no Date.now() here, no status decisions, no I/O.
  // Every field maps to an existing agent property; the detectors are thunks
  // so deriveStatus runs a scrape only on the branch that needs it.
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
      lastSubHookTs:   this.lastSubHookTs,
      pendingSubagents: this.pendingSubagents,
      hasPty:          !!this.pty,
      paused:          this.status === 'paused',
      errored:         this.status === 'error',
      scanApproval:    () => this.#scanApprovalPrompt(),
      scanWorking:     () => this.#scanWorking(),
      liveSubAgents:   (opts) => this.usageTailer?.liveAgents?.(opts),
    };
  }

  toJSON() {
    // 0286: status, stuckMin, bg and the fan-out snapshot come from the pure
    // deriveStatus (server/deriveStatus.mjs — every branch and the incident
    // notes behind it live there). The one clock read is here.
    const { status, stuckMin, bgCount, bgStatus, activeSubagents } =
      deriveStatus(this.#collectSignals(), Date.now());
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
      // 0409: true conversation age (first transcript record), null when the
      // transcript hasn't been read yet. Card prefers it over spawnedAt, which
      // restarts with the agent object on every resume.
      sessionStartedAt: this.sessionStartedAt ?? null,
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
      // Ship the whole ring, not a hardcoded 16. The fleet log is derived
      // ENTIRELY from what agents ship, and narrative mode discards ~80% of it
      // — at 16 per agent, a `fleetLogLines: 32` setting could never be filled
      // (6 sessions yielded 19 rows). TAIL_SHIP is sized off the schema's
      // `fleetLogLines` max so one agent alone can fill the largest log.
      tail: this.tail.slice(-TAIL_SHIP),
      todos: this.todos.slice(),
    };
  }
}
