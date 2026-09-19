// tests/mainShutdown.escalation.test.mjs — 0408/P5 regression.
//
// main.jsx's signal shutdown() used to be `killAll()` (SIGTERM) then
// `process.exit(0)` — a claude that ignores SIGTERM (wedged on a permission
// prompt / daemon entanglement) was reparented to launchd and kept running
// (probe-signal-shutdown.mjs: child alive with ppid 1 after shutdown).
//
// Fix contract, two layers (main.jsx needs a real TTY, so wiring is asserted
// on source — the established pattern from sessionSave.sighup.test.mjs):
//   1. wiring — shutdown() must NOT exit synchronously after killAll; it
//      escalates via an unref'd ~1.5s reaper that hardKillAlls then exits,
//      and the synchronous 'exit' net hardKills right after killAll.
//   2. behavior — the escalation sequence actually reaps a SIGTERM-ignoring
//      child: fleet.killAll() leaves it running, fleet.hardKillAll() ends it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const base = mkdtempSync(join(tmpdir(), 'mc-shutdown-'));
process.env.MC_CONFIG_DIR = join(base, 'cfg');
process.env.XDG_STATE_HOME = join(base, 'state');
process.env.CLAUDE_BIN = join(root, 'tests', 'fixtures', 'fakeclaude-wedged.sh');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 'S'/'R' = running, 'Z' or gone = dead-or-reaped. kill(pid,0) alone can't
// tell a zombie from a live process.
function procState(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
}
const isRunning = (pid) => { const s = procState(pid); return s !== '' && !s.startsWith('Z'); };

test('wiring: shutdown() escalates instead of exiting right after killAll', () => {
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  const start = src.indexOf('const shutdown = () =>');
  const end = src.indexOf("process.on('SIGINT'", start);
  assert.ok(start !== -1 && end > start, 'shutdown handler found');
  const body = src.slice(start, end);

  assert.ok(/fleet\.killAll\(\)/.test(body), 'shutdown still SIGTERMs first');
  assert.ok(/fleet\.hardKillAll\(\)/.test(body), 'shutdown escalates to hardKillAll');
  assert.ok(/setTimeout\(/.test(body) && /1500/.test(body), 'escalation waits ~1.5s');
  assert.ok(/\.unref\?\.\(\)/.test(body), 'the reaper is unref’d (a clean drain exits at once)');
  // No process.exit before the reaper is scheduled — the old bug shape.
  // (Comments stripped: the fix's own comment narrates the old behavior.)
  const beforeTimer = body.slice(0, body.indexOf('setTimeout(')).replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.exit\(/.test(beforeTimer),
    'shutdown must not exit synchronously — SIGTERM-ignoring children would be orphaned');
});

test('wiring: the synchronous exit net hardKills right after killAll', () => {
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  const start = src.indexOf("process.on('exit'");
  assert.ok(start !== -1, 'exit net present');
  const body = src.slice(start, src.indexOf('});', start));
  const killAt = body.indexOf('fleet.killAll()');
  const hardAt = body.indexOf('fleet.hardKillAll()');
  assert.ok(killAt !== -1 && hardAt > killAt,
    'exit net must escalate to SIGKILL — no timer can run after process.exit');
});

test('behavior: killAll leaves a wedged claude running; hardKillAll reaps it', async (t) => {
  const { Fleet } = await import('../server/fleet.mjs');
  const fleet = new Fleet({ slots: 2 });
  const agent = fleet.launch({
    slot: 1, cwd: base, branch: 'main', model: 'sonnet-4.6', name: 'wedged',
    permissionMode: 'acceptEdits',
  });
  t.after(() => { try { fleet.hardKillAll(); } catch {} });

  await sleep(400); // let the pty spawn
  const pid = agent.pty?.pid ?? agent.proc?.pid;
  assert.ok(pid > 0, 'child spawned');
  assert.ok(isRunning(pid), 'wedged child is up');

  fleet.killAll();                 // what shutdown() does first (SIGTERM)
  await sleep(600);
  assert.ok(isRunning(pid),
    'a SIGTERM-ignoring child survives killAll — this is why exit(0) alone orphaned it');

  fleet.hardKillAll();             // the escalation
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { await sleep(100); alive = isRunning(pid); }
  assert.equal(alive, false, 'SIGKILL reaps the wedged child');
});
