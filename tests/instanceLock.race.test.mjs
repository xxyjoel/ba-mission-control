// tests/instanceLock.race.test.mjs — 0445 regression.
//
// acquireInstanceLock() used to READ the lock, then WRITE it with no O_EXCL.
// Two mc started at the same moment both read "no lock", both wrote, and both
// got ok:true (5/5 in the 2026-10-08 review) — two writers on one
// sessions.json, the substrate behind 0365. The lock is now created with
// flag 'wx', so the kernel picks exactly one winner.
//
// Shape: two real node processes per trial import the lock module, report
// "ready", then spin on a shared barrier file holding a go-timestamp and call
// acquireInstanceLock() at that instant. Every trial must have exactly one
// ok:true. A second case races two processes over a STALE lock (dead pid):
// the unlink-and-retry path must also crown exactly one winner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_MOD = pathToFileURL(join(__dirname, '..', 'tui', 'lib', 'instanceLock.js')).href;

const TRIALS = 20;

// Child: import, say ready, wait for the barrier file, spin to the go-time,
// acquire, print the result. It never releases and stays alive until the
// parent closes its stdin (after BOTH racers reported) — a winner that exited
// at once would leave a dead-pid lock the loser may rightly call stale.
const CHILD = `
import { readFileSync } from 'node:fs';
const { acquireInstanceLock } = await import(process.env.LOCK_MOD);
process.stdout.write('ready\\n');
let go = NaN;
while (!Number.isFinite(go)) {
  try { go = Number(readFileSync(process.env.BARRIER, 'utf8')); } catch {}
}
while (Date.now() < go) {}
const res = acquireInstanceLock();
process.stdout.write(JSON.stringify(res) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

function runRacer(cfgDir, barrier) {
  const env = { ...process.env, MC_CONFIG_DIR: cfgDir, LOCK_MOD, BARRIER: barrier };
  delete env.MC_ALLOW_MULTI;
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const ready = new Promise((resolve, reject) => {
    const check = () => { if (out.includes('ready\n')) resolve(); };
    child.stdout.on('data', check);
    child.on('exit', () => reject(new Error(`racer exited before ready: ${err}`)));
  });
  const result = new Promise((resolve) => {
    const check = () => {
      const line = out.split('\n').find((l) => l.startsWith('{') && out.includes(l + '\n'));
      if (line) resolve({ res: JSON.parse(line), err });
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => resolve({ code, res: null, err }));
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const release = () => { try { child.stdin.end(); } catch {} return exited; };
  return { ready, result, release };
}

async function race(cfgDir) {
  const barrier = join(cfgDir, '..', `barrier-${Math.random().toString(36).slice(2)}`);
  const a = runRacer(cfgDir, barrier);
  const b = runRacer(cfgDir, barrier);
  await Promise.all([a.ready, b.ready]);
  writeFileSync(barrier, String(Date.now() + 150));
  const results = await Promise.all([a.result, b.result]);
  await Promise.all([a.release(), b.release()]);
  for (const r of results) assert.ok(r.res, `racer produced no result (code ${r.code}): ${r.err}`);
  return results.map((r) => r.res);
}

const base = mkdtempSync(join(tmpdir(), 'mc-lock-race-'));
test.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

test(`two mc booting at the same moment: exactly one wins, ${TRIALS}/${TRIALS} trials`, async () => {
  const winners = [];
  for (let i = 0; i < TRIALS; i++) {
    const cfg = join(base, `fresh-${i}`);
    const res = await race(cfg);
    winners.push(res.filter((r) => r.ok === true).length);
  }
  assert.deepEqual(winners, Array(TRIALS).fill(1),
    `ok:true count per trial (must be exactly 1 each): ${winners.join(',')}`);
});

test(`two mc racing over a STALE lock: exactly one wins, ${TRIALS}/${TRIALS} trials`, async () => {
  const dead = Number(execFileSync('sh', ['-c', 'true & echo $!']).toString().trim());
  const winners = [];
  for (let i = 0; i < TRIALS; i++) {
    const cfg = join(base, `stale-${i}`);
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'mc.lock'), JSON.stringify({ pid: dead, startedAt: Date.now() - 60_000 }));
    const res = await race(cfg);
    winners.push(res.filter((r) => r.ok === true).length);
  }
  assert.deepEqual(winners, Array(TRIALS).fill(1),
    `ok:true count per trial (must be exactly 1 each): ${winners.join(',')}`);
});

// main.jsx needs a real TTY, so the release order is asserted on source (the
// pattern of mainShutdown.escalation / sessionSave.sighup). Comments are
// stripped so a comment that mentions the call can't satisfy the check.
test('main.jsx wiring: the lock is released LAST — signal shutdown, exit net and clean quit', () => {
  const src = readFileSync(join(__dirname, '..', 'tui', 'main.jsx'), 'utf8').replace(/\/\/.*$/gm, '');
  const REL = 'releaseInstanceLock()';

  const sStart = src.indexOf('const shutdown = () =>');
  const sBody = src.slice(sStart, src.indexOf("process.on('SIGINT'", sStart));
  assert.ok(sStart !== -1 && sBody.includes(REL), 'shutdown() releases the lock');
  const rel = sBody.indexOf(REL);
  for (const step of ['fleet.killAll()', 'app.unmount()', 'fleet.hardKillAll()']) {
    assert.ok(sBody.indexOf(step) !== -1 && sBody.indexOf(step) < rel, `shutdown(): release after ${step}`);
  }
  assert.equal(sBody.indexOf(REL), sBody.lastIndexOf(REL), 'shutdown(): released exactly once');

  const eStart = src.indexOf("process.on('exit'");
  const eBody = src.slice(eStart, src.indexOf('await app.waitUntilExit()', eStart));
  assert.ok(eStart !== -1 && eBody.includes(REL), "'exit' net releases the lock");
  assert.ok(eBody.indexOf('fleet.hardKillAll()') < eBody.indexOf(REL), "'exit' net: release after hardKillAll");

  const qBody = src.slice(src.indexOf('await app.waitUntilExit()'));
  assert.ok(qBody.includes(REL), 'clean quit releases the lock');
  assert.ok(qBody.indexOf('fleet.hardKillAll()') < qBody.indexOf(REL), 'clean quit: release after hardKillAll');
  assert.ok(qBody.indexOf(REL) < qBody.indexOf('process.exit(0)'), 'clean quit: release before exit');
});

// 0445 review defect 1: a crashed mc's lock can name OUR pid (pid reuse after
// a reboot / in a container). Kept as-is, its old startedAt made a second mc
// judge the running owner "recycled" and take the lock too. The leftover must
// be replaced with a fresh stamp that a second instance sees as live; a lock
// this process wrote itself stays ours on a second acquire.
const OWN_PID_CHILD = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const cfg = process.env.MC_CONFIG_DIR;
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, 'mc.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3600_000 }));
const { acquireInstanceLock, lockHolderIsLive } = await import(process.env.LOCK_MOD);
const first = acquireInstanceLock();
const rec = JSON.parse(readFileSync(join(cfg, 'mc.lock'), 'utf8'));
const again = acquireInstanceLock();
process.stdout.write(JSON.stringify({ first, again, ageMs: Date.now() - rec.startedAt, live: lockHolderIsLive(rec) }));
`;

test('a leftover lock naming our own pid is re-stamped, so a second mc sees us as live', () => {
  const cfg = join(base, 'own-pid');
  const env = { ...process.env, MC_CONFIG_DIR: cfg, LOCK_MOD };
  delete env.MC_ALLOW_MULTI;
  delete env.NODE_TEST_CONTEXT;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', OWN_PID_CHILD], { env }).toString());
  assert.equal(out.first.ok, true, 'the inherited-pid leftover is replaced, not locked out');
  assert.ok(out.ageMs < 60_000, `lock startedAt is fresh (age ${out.ageMs}ms), not the crashed mc's`);
  assert.equal(out.live, true, 'a second instance judges the holder live');
  assert.equal(out.again.ok, true, 'a lock this process wrote stays ours');
});
