// tests/recipes/pause-group.recipes.test.mjs — 0442: pause must stop every
// process claude started, not only claude's own pid.
//
// node-pty forks the child as a session leader (pid == pgid). Some children
// stay in that group (claude's MCP servers, caffeinate). claude's Bash tool
// does NOT: each Bash-tool shell calls setsid and leads its own session and
// group (measured on a live claude: zsh ppid=claude, pgid=own pid, stat Ss).
// So neither pty.kill() (leader only) nor process.kill(-pid) (leader's group
// only) reaches the builds, tests and sleeps a "paused" card is running.
//
// This drives PtyCore over a REAL node-pty running bash with:
//   - a child sleep in bash's group (the MCP-server shape), and
//   - a child that calls setsid, then execs sleep (the Bash-tool shape),
// and reads each process's state with `ps`.
//
// Lives under tests/recipes/ so scripts/run-tests.mjs (needsRealTerminal)
// skips it on the headless CI runner; MC_RUN_PTY=1 forces it there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PtyCore } from '../../server/ptyCore.mjs';

// setsid, then exec: the detached sleep keeps perl's pid, own session + group.
const DETACHED = `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "30"'`;

class BashProvider extends PtyCore {
  constructor() {
    super({});
    this.slot = 0;
    this.cwd = process.cwd();
    this.tail = [];
  }
  buildSpawn() { return { bin: '/bin/bash', args: ['-c', `${DETACHED} & sleep 30 & wait`] }; }
  appendTail(ln) { this.tail.push(ln); }
  readiness() { return { delayMs: 0 }; }
}

// [{ pid, ppid, pgid }] for every live process.
function allProcs() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  return out.trim().split('\n').map((l) => {
    const [pid, ppid, pgid] = l.trim().split(/\s+/).map(Number);
    return { pid, ppid, pgid };
  });
}

function psField(field, pid) {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
const stat = (pid) => psField('stat', pid);
const isSleep = (pid) => /sleep/.test(psField('comm', pid));

// The leader's two sleeps: one in its group, one that setsid'd away.
function family(leader) {
  const kids = allProcs().filter((p) => p.ppid === leader);
  return {
    inGroup: kids.find((p) => p.pgid === leader && isSleep(p.pid)),
    detached: kids.find((p) => p.pgid !== leader && p.pgid === p.pid && isSleep(p.pid)),
  };
}

async function until(fn, ms = 3000, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, step));
  }
}

const ready = (leader) => until(() => {
  const f = family(leader);
  return f.inGroup && f.detached ? f : null;
});

// Gone, or a zombie waiting for a reaper.
const ended = (pid) => { const s = stat(pid); return !s || s.startsWith('Z'); };

// Only processes this test started: the leader's group and the detached sleep.
function cleanup(leader, detachedPid) {
  for (const target of [-leader, detachedPid]) {
    if (!target) continue;
    try { process.kill(target, 'SIGCONT'); } catch {}
    try { process.kill(target, 'SIGKILL'); } catch {}
  }
}

test('0442: pause stops the group AND a setsid child (claude Bash-tool shape); resume wakes them', async (t) => {
  const core = new BashProvider();
  core.start();
  const leader = core.pty.pid;
  let detachedPid = null;
  t.after(() => { cleanup(leader, detachedPid); try { core.kill(); } catch {} });

  const f = await ready(leader);
  assert.ok(f, `bash + in-group sleep + setsid sleep under ${leader}`);
  detachedPid = f.detached.pid;
  const pids = [leader, f.inGroup.pid, detachedPid];
  const states = () => JSON.stringify(pids.map((p) => [p, stat(p)]));

  assert.equal(core.pause(), true);
  const stopped = await until(() => pids.every((p) => stat(p).includes('T')), 1500);
  assert.ok(stopped, `every process must be in state T after pause: ${states()}`);

  assert.equal(core.resume(), true);
  const woken = await until(() => pids.every((p) => { const s = stat(p); return s && !s.includes('T'); }), 1500);
  assert.ok(woken, `no process may stay in state T after resume: ${states()}`);
});

test('0442: kill() on a paused slot ends the setsid child too, not only the leader group', async (t) => {
  const core = new BashProvider();
  core.start();
  const leader = core.pty.pid;
  let detachedPid = null;
  t.after(() => cleanup(leader, detachedPid));

  const f = await ready(leader);
  assert.ok(f, `bash + in-group sleep + setsid sleep under ${leader}`);
  detachedPid = f.detached.pid;
  const pids = [leader, f.inGroup.pid, detachedPid];

  core.pause();
  core.kill();
  const gone = await until(() => pids.every(ended), 3000);
  assert.ok(gone, `every process must exit after kill: ${JSON.stringify(pids.map((p) => [p, stat(p)]))}`);
});
