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
import { probeAuth, authSummary } from './lib/auth.js';
import { versionLine } from './lib/version.js';
import { isSandboxed, getConfigDir } from './lib/configDir.js';
import { loadSettings } from './lib/settings.js';
import { syncFromSnapshot, setQuitMode } from './lib/sessionStore.js';
import { MODELS } from './lib/models.js';
import { loadModelCache, applyCacheToCatalog } from './lib/modelProbe.js';

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

const fleet = new Fleet({ slots: bootSettings.maxSlots });

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
  // Signal-driven exits (Ctrl-C, terminal close, SIGTERM) are NOT a proper
  // save — downgrade the final write to location-only so `:resume-all` reopens
  // these repos fresh. Only the in-app [s] save & quit keeps the mode at 'save'.
  setQuitMode('clear');
  persistOpenSet();          // capture live set BEFORE killing
  try { fleet.killAll(); } catch {}
  try { app.unmount(); } catch {}
  process.exit(0);
};
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
// SIGHUP = the controlling terminal was closed. Treat it like any other
// non-save exit: persistOpenSet() runs with the default 'clear' quit mode, so
// the resume store keeps only the open repo LOCATIONS (reopened fresh by
// `:resume-all`) — the live conversations end with the killed children.
process.on('SIGHUP',  shutdown);
// Final safety net for paths the explicit handlers miss (uncaught
// exception, beforeExit timeout, abnormal termination). process.exit
// fires synchronously before the OS frees the process, and
// fleet.killAll() is synchronous (signals SIGTERM to every child PTY
// / subprocess), so this is the last chance to avoid orphaned claude
// processes — relevant for PtyAgent slots where the PTY would
// otherwise persist past mc's death.
process.on('exit', () => {
  persistOpenSet();          // safety net for paths that bypass shutdown()
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
try { fleet.killAll(); } catch {}
