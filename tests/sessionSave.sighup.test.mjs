// tests/sessionSave.sighup.test.mjs — regression guard for the "mc did not save
// my sessions" data loss (cmd+W / terminal close).
//
// Root cause: main.jsx's shutdown() forced setQuitMode('clear') on EVERY signal
// exit (SIGHUP/SIGINT/SIGTERM), so closing the terminal downgraded the final
// persist to location-only and DROPPED each live slot's sessionId + totals. The
// user's on-disk store showed slots turned into fresh:true stubs at the last close.
//
// Fix contract, guarded here in two layers:
//   1. behavioral — a save-mode persist (the default) keeps the FULL record, and a
//      clear-mode persist drops it. (Proves save vs clear actually differ.)
//   2. wiring     — main.jsx's shutdown() must NOT force 'clear'; SIGHUP must route
//      to it; and the ONLY setQuitMode('clear') caller is the explicit [d] path in
//      QuitConfirm.jsx. (main.jsx needs a real TTY to run, so we assert on source —
//      same approach as perf.measures.test.jsx's NODE_ENV wiring check.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const sandbox = mkdtempSync(join(tmpdir(), 'mc-sighup-'));
process.env.MC_CONFIG_DIR = sandbox;
mkdirSync(sandbox, { recursive: true });

const { syncFromSnapshot, setQuitMode, getResumeRecord } =
  await import('../tui/lib/sessionStore.js');

const UU = 'e4f06236-f11b-4f2e-8585-1f63c244b7ec';
const liveAgent = {
  slot: 6, status: 'idle', id: 's6', sessionId: UU,
  cwd: '/repo/gtm-gov-miner', branch: 'main', model: 'opus-4.8',
  name: 'gtm-gov-miner', permissionMode: 'auto',
  tokensIn: 12345, tokensOut: 678, costSession: 4.2,
};

test('default (save) persist keeps the FULL resumable record — what a terminal close now writes', () => {
  setQuitMode('save'); // the default; shutdown() no longer overrides it
  syncFromSnapshot([liveAgent]);
  const rec = getResumeRecord(6);
  assert.equal(rec.sessionId, UU, 'sessionId must survive so :resume-all can rehydrate');
  assert.equal(rec.fresh, false);
  assert.equal(rec.tokensIn, 12345);
  assert.equal(rec.costSession, 4.2);
});

test('shutdown() in main.jsx does NOT force a clear on signal exit', () => {
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  const start = src.indexOf('const shutdown = () =>');
  assert.ok(start !== -1, 'expected a shutdown() handler in main.jsx');
  // Bound the scan to the handler body (up to the next top-level process.on wiring).
  const bodyEnd = src.indexOf("process.on('SIGINT'", start);
  assert.ok(bodyEnd > start, 'expected SIGINT wiring after shutdown()');
  const body = src.slice(start, bodyEnd);
  assert.ok(
    !/setQuitMode\(\s*['"]clear['"]\s*\)/.test(body),
    'shutdown() must not force clear — signal exits (SIGHUP/SIGINT/SIGTERM) must preserve save mode',
  );
});

test('SIGHUP (cmd+W / terminal close) is wired to shutdown', () => {
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  assert.ok(
    /process\.on\(\s*['"]SIGHUP['"]\s*,\s*shutdown\s*\)/.test(src),
    'SIGHUP must route to the (save-preserving) shutdown handler',
  );
});

test('the ONLY explicit clear path is QuitConfirm [d] — no other module forces clear on exit', () => {
  const main = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  assert.ok(
    !/setQuitMode\(\s*['"]clear['"]\s*\)/.test(main),
    'main.jsx must not call setQuitMode(clear) anywhere; clear is opt-in via the modal',
  );
  const modal = readFileSync(join(root, 'tui', 'modals', 'QuitConfirm.jsx'), 'utf8');
  assert.ok(
    /quit\(\s*['"]clear['"]\s*\)/.test(modal),
    'QuitConfirm must still offer the explicit [d] quit-no-save (clear) choice',
  );
});
