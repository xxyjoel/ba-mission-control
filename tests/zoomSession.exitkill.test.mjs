// tests/zoomSession.exitkill.test.mjs — S5 (0408), zoom side.
//
// node-pty keeps `pid` after exit and swallows ESRCH, so finalize()'s
// pty.kill() on an already-exited zoom claude used to signal whatever process
// now owned the recycled pid. Contract: once the PTY has exited on its own,
// finalize() never calls pty.kill(); a still-live PTY is killed as before.
//
// zoomSession has no spawn seam, so this uses a real node-pty running a tiny
// /bin/sh stand-in (never a real claude). HOME is redirected into a temp dir
// so the tailer/session-path probing touches nothing real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-zoom-'));
process.env.HOME = sandbox;

// Fake claude binaries (argv-form spawn targets; CLAUDE_BIN is read by the
// module at import time, so set it per-scenario before the dynamic import
// cannot work — instead one script switches on a marker file).
const exitFast = join(sandbox, 'fake-claude-exit.sh');
writeFileSync(exitFast, '#!/bin/sh\nexit 0\n');
chmodSync(exitFast, 0o755);
const stayUp = join(sandbox, 'fake-claude-stay.sh');
writeFileSync(stayUp, '#!/bin/sh\nexec sleep 300\n');
chmodSync(stayUp, 0o755);

function makeAgent() {
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    model: 'sonnet-4.6',
    permissionMode: null,
    cwd: sandbox,
    proc: null,
    killed: false,
    status: 'idle',
    tail: [],
    appendTail(l) { this.tail.push(l); },
    emit() {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('S5: finalize() does NOT signal a PTY that already exited on its own', async () => {
  process.env.CLAUDE_BIN = exitFast;
  const { startZoomSession } = await import('../server/zoomSession.mjs?exitfast');
  const session = startZoomSession(makeAgent(), { cols: 80, rows: 24 });
  const kills = [];
  const origKill = session.pty.kill.bind(session.pty);
  session.pty.kill = (...a) => { kills.push(a); return origKill(...a); };
  // Let the script exit on its own.
  let exited = false;
  session.pty.onExit(() => { exited = true; });
  for (let i = 0; i < 40 && !exited; i++) await sleep(50);
  assert.equal(exited, true, 'precondition: the fake claude exited by itself');
  const deadPid = session.pty.pid;
  session.dispose();
  await sleep(2400); // QUIET_HOLD_MS (1500) + finalize tick margin
  assert.deepEqual(kills, [], `finalize must not signal the dead handle (pid ${deadPid} may be recycled)`);
});

test('S5 control: a still-live zoom PTY is killed by finalize() as before', async () => {
  process.env.CLAUDE_BIN = stayUp;
  const { startZoomSession } = await import('../server/zoomSession.mjs?stayup');
  const session = startZoomSession(makeAgent(), { cols: 80, rows: 24 });
  const pid = session.pty.pid;
  const kills = [];
  const origKill = session.pty.kill.bind(session.pty);
  session.pty.kill = (...a) => { kills.push(a); return origKill(...a); };
  await sleep(300);
  assert.equal(alive(pid), true, 'precondition: fake claude still running');
  session.dispose();
  await sleep(2400);
  assert.ok(kills.length >= 1, 'live PTY torn down by finalize');
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, 'fake claude reaped');
});

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});
