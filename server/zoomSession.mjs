// server/zoomSession.mjs — PTY handoff for the Zoom modal.
//
// Mission Control normally runs each `claude` subprocess in -p stream-json
// mode, parsing the JSON event stream and rendering it through Ink. That's
// fine for the 10-card fleet view but it can never match Claude Code's own
// rendering inside a focused session — markdown, syntax highlighting, the
// cursor, scrollback, slash UI, @-mentions are all features the real claude
// CLI provides for free when it owns a TTY.
//
// So when the user zooms in on an agent, we hand the body of the modal
// over to a real interactive claude PTY child resumed against the same
// session UUID. The stream-json sibling stays alive but SIGSTOP'd for the
// duration so we don't have two writers racing on the on-disk session
// file. On exit we SIGCONT the original and the fleet view picks up where
// it left off.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn as ptySpawn } from 'node-pty';
import { MODELS } from '../tui/lib/models.js';
import { claudeProjectDir, claudeSessionPath, startSessionTailer } from './sessionFileTailer.mjs';

// How long after SIGTERM to send SIGKILL if the PTY hasn't exited
// yet. 250ms is long enough for a clean shutdown and short enough
// that teardown feels prompt.
const KILL_GRACE_MS = 250;

// How long to wait after PTY spawn before checking which session
// file claude actually opened. Claude usually commits its first
// write within a few hundred ms; 1200ms is a comfortable margin
// that still keeps the fleet log update feeling near-instant.
const SESSION_DETECT_MS = 1200;

// When the user exits zoom we don't tear down immediately. If claude
// is mid-stream ("thinking") the kill would lose the in-flight
// response. Instead we wait for the PTY's stdout to be quiet for
// QUIET_HOLD_MS — that's our proxy for "the current turn finished
// writing to the session JSONL." MAX_HOLD_MS is a safety cap for
// long-running tasks so we never wedge the slot.
const QUIET_HOLD_MS = 1500;
const MAX_HOLD_MS = 30000;

// Build the {sid → mtimeMs} map for jsonl files currently in claude's
// project dir for `cwd`. Used to diff "what's there before PTY spawn"
// against "what's there ~1s later" to spot a file claude minted under
// its own id (when --session-id wasn't honored).
function snapshotProjectDir(cwd) {
  const dir = claudeProjectDir(cwd);
  const snap = new Map();
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -'.jsonl'.length);
      try { snap.set(sid, statSync(`${dir}/${f}`).mtimeMs); } catch {}
    }
  } catch { /* dir may not exist yet — empty snapshot is fine */ }
  return snap;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Same UI-id → CLI-arg derivation as server/agent.mjs. Sharing the
// MODELS catalog keeps this in lock-step with the visible model list
// so a freshly-added model can never silently fall through.
const MODEL_ARG = Object.fromEntries(
  Object.entries(MODELS).map(([id, m]) => [id, m.cliModel])
);

// startZoomSession — pause the stream-json sibling and spawn an
// interactive `claude --resume <sid>` in a pseudo-tty sized to the
// caller's viewport.
//
// agent     — the Agent instance (must already be running with a sessionId)
// opts.cols — initial PTY columns
// opts.rows — initial PTY rows
//
// Returns { pty, dispose, sessionId }. dispose() kills the PTY and
// SIGCONTs the stream-json sibling. Safe to call multiple times.
export function startZoomSession(agent, { cols, rows } = {}) {
  if (!agent) throw new Error('zoomSession: agent is required');
  if (!agent.sessionId) throw new Error('zoomSession: agent has no sessionId yet');

  const sessionId = agent.sessionId;
  const modelArg = MODEL_ARG[agent.model] || agent.model;

  // Pause-not-kill the stream-json sibling on entry. The "session
  // killed on zoom exit" symptom came from the old kill+respawn
  // approach destroying the original process even when zoom did NO
  // work — entering zoom, seeing claude, and immediately exiting
  // left nothing to respawn from (no JSONL was ever written) and
  // the user lost the session.
  //
  // SIGSTOP keeps the sibling frozen but alive. agent.killed is
  // set true so any spurious exit during zoom doesn't trigger
  // auto-restart (which would race with the PTY for the session
  // file). At dispose time we decide between two paths:
  //   - PTY wrote turns → kill+respawn with the detected sid
  //   - PTY wrote nothing → SIGCONT the original, conversation intact
  let siblingPaused = false;
  if (agent.proc) {
    try {
      agent.killed = true;          // suppress auto-restart during zoom
      agent.status = 'paused';
      try { agent.appendTail({ kind: 'sys', text: 'zoom entry — sibling SIGSTOP\'d, PTY taking over' }); } catch {}
      agent.proc.kill('SIGSTOP');
      siblingPaused = true;
    } catch {
      siblingPaused = false;
    }
  }

  // Interactive claude: no -p, no --output-format, no --include-partial.
  // We want the same defaults a user gets from typing `claude` at a
  // shell prompt, just resumed against this session and confined to
  // the agent's cwd + permission mode.
  //
  // --resume only succeeds when claude has flushed the session JSONL
  // to disk at ~/.claude/projects/<encoded-cwd>/<sid>.jsonl. That
  // happens after the first completed turn. Before then (brand-new
  // session, user zooms before sending a prompt) --resume errors with
  // "No conversation found with session ID …". Fall back to
  // --session-id <sid> so the PTY child starts a fresh conversation
  // bound to the same id — once it persists, future zooms resume it.
  const sessionFile = claudeSessionPath({ cwd: agent.cwd, sessionId });
  const args = existsSync(sessionFile)
    ? ['--resume', sessionId]
    : ['--session-id', sessionId];
  if (modelArg) args.push('--model', modelArg);
  if (agent.permissionMode) args.push('--permission-mode', agent.permissionMode);
  if (agent.cwd) args.push('--add-dir', agent.cwd);

  // Snapshot the project dir BEFORE spawn so the post-spawn diff can
  // identify a file claude created with its own minted id (when our
  // --session-id was passed but not strictly honored).
  const dirSnapshotBefore = snapshotProjectDir(agent.cwd);

  const pty = ptySpawn(CLAUDE_BIN, args, {
    name: 'xterm-256color',
    cols: Math.max(20, cols | 0 || 80),
    rows: Math.max(5,  rows | 0 || 24),
    cwd: agent.cwd || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  // Track the last time claude wrote to the PTY stdout. Used by
  // dispose() to wait for the in-flight response to finish before
  // tearing down — without this, exiting mid-stream loses whatever
  // claude was about to write to the session JSONL.
  let lastDataAt = Date.now();
  try { pty.onData(() => { lastDataAt = Date.now(); }); } catch {}

  // The tailer used to live in PtyPane, but it MUST outlive the
  // React component now that dispose() defers teardown for the
  // quiet-wait. Otherwise FleetLog would miss any user/assistant
  // events claude writes between Esc and finalize(). zoomSession
  // owns the tailer's lifecycle: start with the spawn, restart on
  // sid rotation, stop in finalize.
  let tailer = null;
  try {
    tailer = startSessionTailer({ agent });
  } catch { /* non-fatal — fleet log just won't update during zoom */ }

  let disposed = false;

  // After claude has had time to commit its first write, diff the dir
  // against the snapshot. If a new .jsonl appeared and its sid doesn't
  // match what we passed, the real session is at that new sid. Update
  // agent.sessionId so the file tailer (in PtyPane) and the post-zoom
  // respawn (agent.start with resuming=true) both follow the right
  // file. Without this, fleet log stays silent during zoom and exit
  // looks like "session killed" because --resume opens the wrong file.
  const detectTimer = setTimeout(() => {
    if (disposed) return;
    const after = snapshotProjectDir(agent.cwd);
    let bestSid = null;
    let bestMtime = -Infinity;
    for (const [sid, mtime] of after) {
      const prev = dirSnapshotBefore.get(sid);
      if (prev === undefined || mtime > prev) {
        // Either a brand-new file or one that was modified since we
        // snapshotted. Both signal "this is what claude is writing to."
        if (mtime > bestMtime) { bestMtime = mtime; bestSid = sid; }
      }
    }
    if (bestSid && bestSid !== agent.sessionId) {
      try { agent.appendTail({ kind: 'sys', text: `zoom: claude minted session ${bestSid.slice(0,8)} (was ${String(agent.sessionId).slice(0,8)})` }); } catch {}
      agent.sessionId = bestSid;
      // Tailer captured the old sid in its closure — rebuild it so
      // it now watches the right file. fromStart=true means we
      // consume events that landed in the new file during the
      // 1200ms detection window (otherwise the first user prompt
      // and assistant reply would be lost to the FleetLog).
      try { tailer?.stop(); } catch {}
      try { tailer = startSessionTailer({ agent, fromStart: true }); } catch {}
      try { agent.emit('change'); } catch {}
    }
  }, SESSION_DETECT_MS);

  // finalize — the actual teardown. Called once the PTY has either
  // gone quiet (claude finished its turn) or hit the safety cap.
  // Decides between SIGCONT (PTY did nothing → original sibling is
  // still valid) and kill+respawn (PTY wrote turns → sibling must
  // reload from the updated JSONL).
  let finalized = false;
  function finalize() {
    if (finalized) return;
    finalized = true;
    try { clearTimeout(detectTimer); } catch {}
    try { pty.kill(); } catch {}
    try { tailer?.stop(); } catch {}
    tailer = null;

    // Diff the dir one last time to (a) catch any sid claude wrote
    // under that the detection timer missed, and (b) decide whether
    // the PTY actually produced any new state.
    const after = snapshotProjectDir(agent.cwd);
    let detectedSid = null;
    let bestMtime = -Infinity;
    let ptyWrote = false;
    for (const [sid, mtime] of after) {
      const prev = dirSnapshotBefore.get(sid);
      if (prev === undefined || mtime > prev) {
        ptyWrote = true;
        if (mtime > bestMtime) { bestMtime = mtime; detectedSid = sid; }
      }
    }
    if (detectedSid && detectedSid !== agent.sessionId) {
      agent.sessionId = detectedSid;
    }

    if (!siblingPaused) {
      // No sibling to restore (zoom opened a slot that wasn't yet
      // running). Nothing more to do.
      try { agent.emit('change'); } catch {}
      return;
    }

    if (!ptyWrote) {
      // PTY produced nothing — original sibling's in-memory state
      // is still in sync with the session file. Just SIGCONT it.
      try {
        try { agent.appendTail({ kind: 'sys', text: 'zoom exit — no PTY work, SIGCONT sibling' }); } catch {}
        agent.killed = false;
        agent.proc?.kill('SIGCONT');
        agent.status = 'idle';
        try { agent.emit('change'); } catch {}
      } catch (e) {
        try { agent.appendTail({ kind: 'err', text: `SIGCONT failed: ${e?.message || String(e)}` }); } catch {}
        // Fall through — try the respawn path as recovery.
        respawnSibling();
      }
      return;
    }

    // PTY wrote turns → sibling is stale. Kill it (SIGKILL bypasses
    // the SIGSTOP) and respawn with resuming=true so the new claude
    // re-reads the updated JSONL.
    respawnSibling();
  }

  function respawnSibling() {
    try {
      const oldProc = agent.proc;
      // agent.killed stays true through the kill so #onExit early-
      // returns and doesn't race with our manual start().
      try { oldProc?.kill('SIGKILL'); } catch {}
      try { agent.appendTail({ kind: 'sys', text: `zoom exit — respawning sibling with --resume${agent.sessionId ? ` (sid ${String(agent.sessionId).slice(0,8)})` : ''}` }); } catch {}
      // Defer start() a tick so the old proc's #onExit fires first
      // and doesn't null out the new proc reference.
      setImmediate(() => {
        try {
          agent.proc = null;
          agent.killed = false;
          agent.resuming = true;
          agent.status = 'idle';
          agent.start();
        } catch (e) {
          try { agent.appendTail({ kind: 'err', text: `zoom-exit respawn failed: ${e?.message || String(e)}` }); } catch {}
          agent.status = 'error';
          try { agent.emit('change'); } catch {}
        }
      });
    } catch (e) {
      try { agent.appendTail({ kind: 'err', text: `respawn precheck failed: ${e?.message || String(e)}` }); } catch {}
      agent.status = 'error';
      try { agent.emit('change'); } catch {}
    }
  }

  // dispose — called when PtyPane unmounts (user pressed Esc / Ctrl+]
  // / claude exited on its own). Doesn't tear down immediately:
  // schedules a quiet-watch that fires finalize() once the PTY has
  // been idle for QUIET_HOLD_MS, OR after MAX_HOLD_MS as a safety
  // cap. This lets a mid-stream "thinking" response commit to the
  // session JSONL before we kill the PTY — without this, exiting
  // mid-response loses whatever claude was about to say.
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { agent.appendTail({ kind: 'sys', text: 'zoom exit — waiting for PTY to flush in-flight response' }); } catch {}
    const startedAt = Date.now();
    const tick = setInterval(() => {
      if (finalized) { clearInterval(tick); return; }
      const idleMs = Date.now() - lastDataAt;
      const heldMs = Date.now() - startedAt;
      if (idleMs >= QUIET_HOLD_MS || heldMs >= MAX_HOLD_MS) {
        clearInterval(tick);
        finalize();
      }
    }, 250);
  }

  return { pty, dispose, sessionId };
}
