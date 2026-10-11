// tests/killRestart.noSurvivor.test.mjs — 0441: kill and restart never leave
// a claude running.
//
// Before 0441, two paths dropped a claude that ignores SIGTERM:
//   • Fleet.kill sent SIGTERM and emptied the slot at once, so hardKillAll
//     (which walks agents[]) could no longer reach the process.
//   • _teardownForRestart (changeModel / changePermissionMode) sent SIGTERM and
//     forgot the old pty, so hardKill (which only signals this.pty) missed it.
// The stand-in is tests/fixtures/fakeclaude-wedged.sh: `trap '' TERM HUP` then
// exec sleep — SIGTERM leaves it running, only SIGKILL ends it.
//
// Contract: every path SIGTERMs, then SIGKILLs at 1.5 s unless the process
// exited; hardKillAll reaches a process that is still stopping; a respawn
// starts only after the old process is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const base = mkdtempSync(join(tmpdir(), 'mc-0441-'));
process.env.MC_CONFIG_DIR ??= join(base, 'cfg');
process.env.XDG_STATE_HOME ??= join(base, 'state');
process.env.CLAUDE_BIN = join(root, 'tests', 'fixtures', 'fakeclaude-wedged.sh');

const { Fleet } = await import('../server/fleet.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'S'/'R' = running; 'Z' or gone = dead. kill(pid, 0) cannot tell a zombie.
function procState(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
}
const isRunning = (pid) => { const s = procState(pid); return s !== '' && !s.startsWith('Z'); };

async function deadWithin(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isRunning(pid)) return true;
    await sleep(50);
  }
  return !isRunning(pid);
}

// Every pid this file started. The fail-before run cannot reach them through
// mc, so the cleanup SIGKILLs them directly — no `sleep 300` may leak.
const started = new Set();
function track(pid) { if (Number.isInteger(pid) && pid > 1) started.add(pid); return pid; }

function setup(t) {
  const fleet = new Fleet({ slots: 2 });
  fleet.stopPolling();
  t.after(() => {
    try { fleet.killAll(); } catch {}
    try { fleet.hardKillAll(); } catch {}
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  return fleet;
}

function launch(fleet, slot = 1) {
  const agent = fleet.launch({
    slot, cwd: base, branch: 'main', model: 'sonnet-4.6', name: 'wedged',
    permissionMode: 'acceptEdits',
  });
  const pid = track(agent.pty?.pid);
  assert.ok(pid > 1, 'wedged child spawned');
  return { agent, pid };
}

async function upAndIgnoringTerm(pid) {
  await sleep(300); // the trap is set before exec; give the shell time to reach it
  assert.ok(isRunning(pid), 'wedged child is up');
}

test('0441: fleet.kill — a SIGTERM-ignoring claude is SIGKILLed within 2 s', async (t) => {
  const fleet = setup(t);
  const { agent, pid } = launch(fleet);
  await upAndIgnoringTerm(pid);
  fleet.kill(agent.id);
  assert.equal(fleet.agentBySlot(1), null, 'the slot is free at once');
  await sleep(600);
  assert.ok(isRunning(pid), 'SIGTERM alone leaves it running');
  assert.equal(await deadWithin(pid, 1400), true, 'the 1.5 s SIGKILL timer ends it');
});

test('0441: fleet.kill then hardKillAll — the stopping process is still reachable', async (t) => {
  const fleet = setup(t);
  const { agent, pid } = launch(fleet);
  await upAndIgnoringTerm(pid);
  fleet.kill(agent.id);
  fleet.killAll();
  fleet.hardKillAll(); // the shutdown escalation, before the per-kill timer fires
  assert.equal(await deadWithin(pid, 500), true, 'hardKillAll walks the stopping set');
});

test('0441: :clear-style kill + launch in the same slot leaves no wedged claude', async (t) => {
  const fleet = setup(t);
  const { agent, pid } = launch(fleet);
  await upAndIgnoringTerm(pid);
  fleet.kill(agent.id);
  await sleep(50); // App defers the relaunch one tick
  const { pid: freshPid } = launch(fleet);
  assert.notEqual(freshPid, pid);
  assert.equal(await deadWithin(pid, 2000), true, 'the old claude is gone within 2 s');
  assert.ok(isRunning(freshPid), 'the fresh session is untouched');
});

for (const [label, change] of [
  ['changeModel', (a) => a.changeModel('opus-4.7')],
  ['changePermissionMode', (a) => a.changePermissionMode('plan')],
]) {
  test(`0441: ${label} — old claude is SIGKILLed; the respawn waits for it; a queued send survives`, async (t) => {
    const fleet = setup(t);
    const { agent, pid } = launch(fleet);
    await upAndIgnoringTerm(pid);
    assert.equal(change(agent), true);
    // A respawn must not run next to a claude that is still alive.
    if (agent.pty) track(agent.pty.pid);
    assert.equal(agent.pty, null, 'no new claude while the old one is still running');
    assert.equal(agent.send('typed while the old claude stops'), true);
    assert.equal(agent.pty, null, 'a send during the wait queues; it does not spawn early');
    assert.equal(await deadWithin(pid, 2000), true, 'the old claude is gone within 2 s');
    // The respawn follows the SIGKILL.
    const until = Date.now() + 1000;
    while (!agent.pty && Date.now() < until) await sleep(25);
    assert.ok(agent.pty, 'respawned after the old claude ended');
    const newPid = track(agent.pty.pid);
    assert.notEqual(newPid, pid);
    assert.deepEqual(agent.pendingSends, ['typed while the old claude stops'],
      'the queued send waits for the new claude');
  });
}
