// tests/pausedPids.reap.test.mjs — 0443 regression.
//
// A SIGSTOPped claude whose mc dies hard stays frozen under pid 1 for good:
// it leads its own session, so the kernel never sends the orphaned-group
// SIGHUP+SIGCONT, and claude handles SIGHUP anyway. mc now records paused
// pids and the next boot ends any recorded pid that is alive, has the same
// start time, belongs to pid 1 and is stopped — and no other pid.
//
// The child below handles SIGHUP like claude does and leads its own group
// (detached), like claude under node-pty. Run through the hermetic runner,
// which gives this file its own MC_CONFIG_DIR.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  processInfo, recordPaused, loadPaused, reapOrphanedPaused, createPausedWatcher, PAUSED_FILE,
} from '../tui/lib/pausedPids.js';
import { Agent } from '../server/agent.mjs';

const CHILD = "process.on('SIGHUP',()=>{}); setInterval(()=>{},1000);";
// A wedged claude: ignores SIGTERM too (fleet.hardKillAll's case).
// It prints 'ready' once the handlers are in, so the test stops it only then.
const DEAF_CHILD = "process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.stdout.write('ready');";

const started = new Set();
after(() => {
  for (const pid of started) {
    try { process.kill(pid, 'SIGCONT'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(step);
  }
  return !!fn();
}

const isStopped = (pid) => /^T/.test(processInfo(pid)?.stat || '');
const pidGone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };

async function stoppedChild(src = CHILD) {
  const waitReady = src.includes("'ready'");
  const child = spawn(process.execPath, ['-e', src], { detached: true, stdio: ['ignore', waitReady ? 'pipe' : 'ignore', 'ignore'] });
  started.add(child.pid);
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  let out = '';
  if (waitReady) child.stdout.on('data', (d) => { out += d; });
  assert.ok(await until(() => processInfo(child.pid) !== null && (!waitReady || out.includes('ready'))), 'child never showed up in ps');
  process.kill(child.pid, 'SIGSTOP');
  assert.ok(await until(() => isStopped(child.pid)), 'child never reached state T');
  return { child, exited };
}

const withPpid1 = (pid) => { const r = processInfo(pid); return r && { ...r, ppid: 1 }; };

test('0443: a recorded, stopped pid that now belongs to pid 1 is ended at boot', async () => {
  const { child, exited } = await stoppedChild();
  assert.equal(recordPaused(child.pid), true);
  assert.ok(loadPaused().some((r) => r.pid === child.pid));

  // The parent is "gone": the injected ps row reports ppid 1.
  const res = await reapOrphanedPaused({ info: withPpid1 });
  const outcome = await Promise.race([exited, sleep(3000).then(() => null)]);
  assert.ok(outcome, `child still alive after reap (stat=${processInfo(child.pid)?.stat})`);
  assert.equal(outcome.signal, 'SIGTERM');
  assert.deepEqual(res.reaped, [child.pid]);
  assert.ok(!loadPaused().some((r) => r.pid === child.pid), 'record not cleared after reap');
});

test('0443: a recorded pid whose start time does not match is never signalled', async () => {
  const { child } = await stoppedChild();
  writeFileSync(PAUSED_FILE, JSON.stringify({
    version: 1, paused: [{ pid: child.pid, startTime: 'Mon Jan 1 00:00:00 2001' }],
  }));
  const calls = [];
  await reapOrphanedPaused({ info: withPpid1, kill: (...a) => { calls.push(a); } });
  assert.deepEqual(calls, []);
  await sleep(200);
  assert.ok(isStopped(child.pid), 'mismatched pid was touched');
  assert.ok(!loadPaused().some((r) => r.pid === child.pid), 'stale record kept');
});

test('0443: a stopped pid whose parent is still alive (ppid != 1) is left alone', async () => {
  const { child } = await stoppedChild();
  assert.equal(recordPaused(child.pid), true);
  const calls = [];
  await reapOrphanedPaused({ kill: (...a) => { calls.push(a); } }); // real ppid = this test process
  assert.deepEqual(calls, []);
  assert.ok(isStopped(child.pid));
  // Alive, same start time, still owned: another live mc may own it — keep it.
  assert.ok(loadPaused().some((r) => r.pid === child.pid), 'live owned record dropped');
});

test('0443: SIGKILL the parent of a stopped child, then the boot reaper ends it', async (t) => {
  // Parent spawns the SIGHUP-handling child in its own group, stops it, then
  // prints its pid and idles. We SIGKILL the parent like a crashed mc.
  const PARENT = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD)}], { detached: true, stdio: 'ignore' });
    c.unref();
    setTimeout(() => { process.kill(c.pid, 'SIGSTOP'); process.stdout.write(c.pid + '\\n'); }, 200);
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', PARENT], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.add(parent.pid);
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  assert.ok(await until(() => /\d+\n/.test(out)), 'parent never reported the child pid');
  const pid = Number(out.trim());
  started.add(pid);
  assert.ok(await until(() => isStopped(pid)), 'child never reached state T');
  assert.equal(recordPaused(pid), true);

  process.kill(parent.pid, 'SIGKILL');
  const reparented = await until(() => processInfo(pid)?.ppid === 1);
  if (!reparented) { t.skip(`orphan reparented to ${processInfo(pid)?.ppid}, not pid 1 (subreaper)`); return; }
  assert.ok(isStopped(pid), 'orphan should still be frozen before the reaper runs');

  await reapOrphanedPaused(); // real ps, real signals
  assert.ok(await until(() => pidGone(pid)), `orphan still alive after boot reap (stat=${processInfo(pid)?.stat})`);
});

test('0443: an orphan that ignores SIGTERM is SIGKILLed after the grace period', async () => {
  const { child, exited } = await stoppedChild(DEAF_CHILD);
  assert.equal(recordPaused(child.pid), true);
  const res = await reapOrphanedPaused({ info: withPpid1, graceMs: 300 });
  const outcome = await Promise.race([exited, sleep(3000).then(() => null)]);
  assert.ok(outcome, `SIGTERM-deaf orphan still alive after reap (stat=${processInfo(child.pid)?.stat})`);
  assert.equal(outcome.signal, 'SIGKILL');
  assert.deepEqual(res.killed, [child.pid]);
  assert.ok(!loadPaused().some((r) => r.pid === child.pid), 'record not cleared after reap');
});

test('0443: the fleet watcher records on pause and clears on resume / kill', () => {
  const rec = []; const clr = [];
  const w = createPausedWatcher({ record: (p) => rec.push(p), clear: (p) => clr.push(p) });
  const a = { status: 'working', paused: false, pty: { pid: 4242 } };
  const b = { status: 'paused', paused: true, proc: { pid: 4343 } };
  w([a, null]);
  assert.deepEqual([rec, clr], [[], []]);
  a.paused = true; a.status = 'paused';
  w([a, b, { status: 'paused', paused: true }]); // a slot with no pid is skipped
  assert.deepEqual(rec.sort(), [4242, 4343]);
  w([a, b]); // no change → no writes
  assert.equal(rec.length, 2);
  a.paused = false; a.status = 'idle'; // resumed
  w([a, b]);
  assert.deepEqual(clr, [4242]);
  w([a, null]); // b's slot killed
  assert.deepEqual(clr, [4242, 4343]);
});

test('0443: a status rewrite while the process stays stopped keeps the record', () => {
  // The JSONL tailer / markUserSubmitted / send path set status to working,
  // idle or waiting on a SIGSTOPped slot. The record must survive that.
  const rec = []; const clr = [];
  const w = createPausedWatcher({ record: (p) => rec.push(p), clear: (p) => clr.push(p) });
  const a = { status: 'paused', paused: true, pty: { pid: 4242 } };
  w([a]);
  for (const st of ['working', 'idle', 'waiting']) { a.status = st; w([a]); }
  assert.deepEqual([rec, clr], [[4242], []]);
});

test('0443: stream-json Agent keeps a true pause flag and wakes before SIGTERM', () => {
  const agent = new Agent({
    slot: 1, id: 's1-test', cwd: '/tmp', branch: 'main', model: 'claude-sonnet-4-6',
    name: 'test', permissionMode: 'default', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', resume: false,
  });
  const sigs = [];
  agent.proc = { pid: 4343, kill: (s) => { sigs.push(s); } };
  assert.equal(agent.paused, false);
  agent.pause();
  assert.equal(agent.paused, true);
  agent.status = 'working'; // tailer rewrite: the flag must not move
  assert.equal(agent.paused, true);
  agent.resume();
  assert.equal(agent.paused, false);
  agent.pause();
  agent.kill();
  assert.equal(agent.paused, false);
  assert.deepEqual(sigs, ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT', 'SIGTERM']);
});
