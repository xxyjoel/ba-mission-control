// tui/main.jsx — boot. Construct the Fleet, render the Ink app, wire shutdown.
//
// Run by bin/mc.mjs (which sets up the tsx JSX loader before importing this).
// The Fleet stays alive in-process — there's no HTTP layer anymore; the TUI
// talks to it directly via shared object references.

import React from 'react';
import { render } from 'ink';
import { execFileSync } from 'node:child_process';

import App from './App.jsx';
import { Fleet } from '../server/fleet.mjs';
import { startHeapProbe } from '../server/heapProbe.mjs';
import { fixNodePty } from '../scripts/fix-node-pty.mjs';
import { probeAuth, authSummary } from './lib/auth.js';
import { versionLine } from './lib/version.js';
import { isSandboxed, getConfigDir } from './lib/configDir.js';
import { loadSettings } from './lib/settings.js';
import { syncFromSnapshot, setQuitMode } from './lib/sessionStore.js';
import { MODELS } from './lib/models.js';
import { loadModelCache, applyCacheToCatalog, autoProbeOnVersionChange } from './lib/modelProbe.js';
import { dlog } from './lib/debugLog.js';
import { killShellSession } from '../server/shellSession.mjs';

// Preflight: print one-line status BEFORE Ink takes over the screen. We don't
// abort on failure — the user might still want to explore the UI — but the
// first launch will fail visibly if claude is missing. execFileSync (not exec)
// keeps CLAUDE_BIN argv-only so a malicious env var can't shell-inject.
function preflight() {
  // First line: which build of mc is running. The user has hit "is my
  // running mc the version with my fix?" enough times that this is
  // worth the boot banner real estate (audit #383). Also surfaces when
  // we're operating against a sandboxed config dir so dev-on-mc never
  // silently writes to the wrong place (audit #380-382).
  process.stdout.write(`[mc] ${versionLine()}\n`);
  if (isSandboxed()) {
    process.stdout.write(`[mc] CONFIG_DIR: ${getConfigDir()}  (sandboxed)\n`);
  }
  // Mock mode short-circuits the claude / auth probes — fixtures replay
  // canned events with zero subprocess footprint.
  if (process.env.MC_MOCK) {
    process.stdout.write(`[mc] MOCK MODE: fixture=${process.env.MC_MOCK} (no real claude subprocess will spawn)\n`);
    return { ok: true, mock: true };
  }
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  let claudeOk = false, claudeVer = '?';
  try {
    claudeVer = execFileSync(claudeBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim().split('\n')[0];
    claudeOk = true;
  } catch {}
  if (!claudeOk) {
    process.stderr.write(`[mc] WARN: \`${claudeBin}\` not found on PATH. Install Claude Code or set CLAUDE_BIN. New sessions will fail to launch.\n`);
    return null;
  }
  process.stdout.write(`[mc] claude: ${claudeVer}\n`);

  // Auth probe — runs `claude auth status` and tells the user exactly which
  // account they're about to launch sessions under. Loud red banner if
  // logged out.
  const auth = probeAuth();
  if (!auth.ok) {
    process.stderr.write(`[mc] WARN: not signed in — run \`claude auth login\`. Sessions will fail until you do.\n`);
  } else {
    process.stdout.write(`[mc] auth · ${authSummary(auth)}\n`);
  }
  return auth;
}

const auth = preflight();

// Read settings.maxSlots up-front so the Fleet is sized correctly on boot.
// App.jsx also applies live changes at runtime via fleet.setSlots() (grow
// freely; shrink only above the highest occupied slot), so a mid-session
// edit takes effect without a restart.
const bootSettings = loadSettings();

// Overlay any cached model probe onto the static catalog BEFORE the app
// renders, so per-card ctx% uses the real context window (e.g. opus-4.8's
// 1M window, not the 200k placeholder). This is offline + cheap — it just
// reads ~/.config/claude-mc/models-cache.json. The live (billed) probe
// only runs on `:model refresh`. See tui/lib/modelProbe.js.
try {
  const cache = loadModelCache();
  if (cache) applyCacheToCatalog(MODELS, cache);
} catch { /* a bad cache must never block boot */ }

// Model discovery from the source of truth (task 0368): if the claude CLI
// version changed since the cache was stamped, re-probe in the background
// and merge any net-new models into the live catalog — they become
// selectable immediately (modelIds() is a live view). Billed only on an
// actual version change; steady-state boots make one free `--version` call.
// Runs here (not in App) so component tests never spawn probes.
// Skipped in sandbox mode (dev:sandbox + pty recipe tests): a throwaway
// MC_CONFIG_DIR never has a stamped cache, so every sandbox boot would
// trigger real billed probes.
if (!isSandboxed()) {
  autoProbeOnVersionChange(MODELS)
    .then((r) => { if (r?.probed) dlog('models', 'auto-probe on claude version change', r); })
    .catch(() => { /* discovery must never block or crash boot */ });
}

// Self-heal node-pty's spawn-helper exec bit BEFORE any PTY spawn (agents or the
// `!` shell). npx skips the postinstall that normally does this, which otherwise
// surfaces as "posix_spawnp failed" the first time a PTY is spawned. Best-effort.
try { fixNodePty(); } catch { /* never block boot */ }

const fleet = new Fleet({ slots: bootSettings.maxSlots });

// Opt-in memory instrumentation for the long-uptime OOM (#18). Inert in normal
// use: only arms an on-demand SIGUSR2 heap snapshot unless MC_HEAP_LOG is set,
// in which case it logs rss/heap + per-structure counts every 60s. Never keeps
// mc alive (unref'd) and never throws into the app.
const stopHeapProbe = startHeapProbe(fleet);

// Enter the terminal alt-screen so mc's render lives in a dedicated
// buffer that the OS restores on exit. Without this, mc draws inline
// in the normal buffer — its last frame persists in scrollback after
// quit, the shell prompt appears below it, and anything the user
// types at the shell (e.g. an accidental `yes please`) looks like an
// mc bug. Standard convention for full-screen TUIs (vim, htop, less).
// Preflight banner stays in the normal buffer so the user can still
// see it in scrollback after mc exits.
const altScreen = process.stdout.isTTY === true;
if (altScreen) process.stdout.write('\x1b[?1049h');

const app = render(<App fleet={fleet} auth={auth} />, {
  exitOnCtrlC: true,
});

// Capture the open-set to the resume store at the LAST possible moment before
// teardown — while the children are still LIVE — so `:resume-all` restores
// exactly the sessions that were open when the terminal closed. The in-app
// sync (App.jsx) is debounced/throttled, so without this the persisted set is
// whatever a stale in-operation tick last wrote, NOT the state at close. Runs
// exactly once (guard), at the earliest exit path, BEFORE any killAll().
let openSetPersisted = false;
function persistOpenSet() {
  if (openSetPersisted) return;
  openSetPersisted = true;
  try {
    const snap = fleet.snapshot();
    syncFromSnapshot(snap.agents, { historyLimit: loadSettings()?.sessionHistoryLimit ?? 20 });
  } catch {}
}

const shutdown = () => {
  // Signal-driven exits (terminal close / cmd+W = SIGHUP, Ctrl-C, SIGTERM) are an
  // IMPLICIT quit, not a request to throw work away. Leave the persist mode at its
  // default ('save') so the final write keeps each live slot's FULL resumable
  // record (sessionId + in/out/cost totals); claude rehydrates the conversation
  // from its own on-disk transcript when `:resume-all` relaunches it. The ONLY
  // exit that discards is the explicit in-app [d] quit-no-save, which sets
  // 'clear' in QuitConfirm before Ink tears down. (Previously this handler forced
  // 'clear' on every signal exit, so closing the terminal silently dropped every
  // session's sessionId — the "mc did not save my sessions" data loss.)
  persistOpenSet();          // capture live set BEFORE killing
  try { stopHeapProbe(); } catch {}
  try { killShellSession(); } catch {}
  try { fleet.killAll(); } catch {}
  try { app.unmount(); } catch {}
  process.exit(0);
};
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
// SIGHUP = the controlling terminal was closed (a cmd+W / window close is the
// common source). persistOpenSet() runs with the default 'save' quit mode, so the
// resume store keeps each live slot's FULL record — `:resume-all` rehydrates the
// real conversations, not fresh stubs. Closing the terminal must not lose work.
process.on('SIGHUP',  shutdown);

// SIGTSTP (Ctrl+Z) / SIGCONT — a full-screen fleet controller must never be
// suspended mid-flight. A stop freezes every session at once (indistinguishable
// from a crash) and, because raw mode + the alt-screen are never torn down,
// strands the process with no cleanup — the origin of the multi-day suspended
// `mc` zombies we found (each an abandoned Ctrl+Z'd instance holding its slots).
// In raw mode Ctrl+Z arrives as byte 0x1a and is handled/forwarded in-app, NOT
// as a signal, so SIGTSTP only fires in the cooked-mode gaps: before Ink takes
// over the tty, inside a `!`-shell child, or after an error dropped raw mode.
// Registering ANY SIGTSTP listener overrides Node's default stop (verified), so
// we simply swallow it — Ctrl+Z becomes a no-op instead of a fleet-freezing trap.
// Quit is q / Ctrl+C, which stay wired above.
process.on('SIGTSTP', () => { dlog('app', 'sigtstp-swallowed', {}); });
// Defense in depth: if the process is stopped by some OTHER means (`kill -STOP`)
// and later resumed (`kill -CONT` / `fg`), re-enter the alt-screen so the fleet
// view isn't left painted into the normal buffer; the render loop repaints on
// its next tick.
process.on('SIGCONT', () => {
  if (altScreen) { try { process.stdout.write('\x1b[?1049h'); } catch {} }
  dlog('app', 'sigcont-reinit', {});
});

// Global crash net. An uncaught exception or rejection must NOT dump a raw
// stack over the alt-screen and strand the terminal (raw mode + cursor hidden)
// — the "posix_spawnp broke the app" class. Registering these listeners also
// suppresses Node's default stack dump, so we restore the screen first, log the
// full detail (MC_DEBUG), print one concise line, and exit cleanly (the 'exit'
// net below then reaps child PTYs). Per-feature failures should be caught at
// their boundary (e.g. shell spawn in getShellSession); this is the backstop.
const crashBail = (kind, err) => {
  try { app?.unmount?.(); } catch {}
  if (altScreen) { try { process.stdout.write('\x1b[?1049l'); } catch {} }
  try { process.stdout.write('\x1b[?25h'); } catch {} // restore cursor
  try { dlog('app', 'uncaught', { kind, msg: err?.message, stack: err?.stack }); } catch {}
  try {
    process.stderr.write(
      `\nmc: fatal ${kind}: ${err?.message || err}\n` +
      `The terminal has been restored. Set MC_DEBUG=1 for the full trace.\n` +
      `Please report: https://github.com/xxyjoel/ba-mission-control/issues\n`,
    );
  } catch {}
  process.exit(1);
};
process.on('uncaughtException',  (err) => crashBail('exception', err));
process.on('unhandledRejection', (err) => crashBail('rejection', err));

// Final safety net for paths the explicit handlers miss (uncaught
// exception, beforeExit timeout, abnormal termination). process.exit
// fires synchronously before the OS frees the process, and
// fleet.killAll() is synchronous (signals SIGTERM to every child PTY
// / subprocess), so this is the last chance to avoid orphaned claude
// processes — relevant for PtyAgent slots where the PTY would
// otherwise persist past mc's death.
process.on('exit', () => {
  persistOpenSet();          // safety net for paths that bypass shutdown()
  try { killShellSession(); } catch {}
  try { fleet.killAll(); } catch {}
  // Restore the normal terminal buffer on every exit path (clean quit,
  // SIGINT, SIGTERM, uncaught exception). Skip if we never entered.
  if (altScreen) {
    try { process.stdout.write('\x1b[?1049l'); } catch {}
  }
});

// Wait for the Ink render to exit (Ctrl-C or `q` → useApp().exit()).
await app.waitUntilExit();
persistOpenSet();            // capture live set BEFORE killing on clean quit
try { killShellSession(); } catch {}
try { fleet.killAll(); } catch {}
