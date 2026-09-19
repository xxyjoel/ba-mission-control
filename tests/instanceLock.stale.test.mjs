// tests/instanceLock.stale.test.mjs — 0408/F4 regression (lock side).
//
// Three defects pinned:
//   1. `startedAt` was written into mc.lock but never compared — a RECYCLED
//      pid (alive, but its process started long after the lock was written)
//      counted as a live holder and forced read-only forever. The check now
//      compares the pid's real start time (ps lstart) to the lock stamp.
//   2. Only sessionStore honoured read-only mode. settings and templates now
//      refuse to write too (costStore is covered in costStore.twoInstances).
//   3. main.jsx ran pruneSessions() BEFORE acquiring the lock, so a second
//      instance's boot could still interleave prune persists on the shared
//      sessions.json. The lock is now taken first (wiring assertion).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const sandbox = mkdtempSync(join(tmpdir(), 'mc-lock-stale-'));
process.env.MC_CONFIG_DIR = sandbox;
delete process.env.MC_ALLOW_MULTI;

const {
  acquireInstanceLock, releaseInstanceLock, lockHolderIsLive,
  setReadOnlyMode, isReadOnlyMode, LOCK_FILE,
} = await import('../tui/lib/instanceLock.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('lockHolderIsLive: live pid + sane stamp = live; recycled pid = stale', () => {
  const now = Date.now();
  // Our own pid, lock written "now": our process started before the stamp.
  assert.equal(lockHolderIsLive({ pid: process.pid, startedAt: now }), true);
  // Recycled pid: the process owning the pid started 60s AFTER the stamp.
  assert.equal(
    lockHolderIsLive({ pid: process.pid, startedAt: now }, { startMsOf: () => now + 60_000 }),
    false,
    'a pid recycled after the lock write is not a holder',
  );
  // Unknown start time → conservative (assume genuine holder).
  assert.equal(
    lockHolderIsLive({ pid: process.pid, startedAt: now }, { startMsOf: () => null }),
    true,
  );
  // Dead pid is never a holder regardless of stamp.
  const dead = execFileSync('sh', ['-c', 'true & echo $!']).toString().trim();
  assert.equal(lockHolderIsLive({ pid: Number(dead), startedAt: now }), false);
});

test('acquire: a stale (recycled-pid) lock is replaced, not honoured', async (t) => {
  // A REAL live process that started just now, but a lock stamped 10 minutes
  // ago — exactly what a recycled pid looks like. Exercises the real ps path.
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await sleep(100);
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: child.pid, startedAt: Date.now() - 600_000 }));

  const res = acquireInstanceLock();
  assert.equal(res.ok, true, 'stale lock must be claimed');
  assert.equal(isReadOnlyMode(), false);
  assert.equal(JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid, process.pid);
  releaseInstanceLock();
});

test('acquire: a genuine live holder arms read-only mode; settings+templates refuse writes', async (t) => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    setReadOnlyMode(false);
    try { rmSync(LOCK_FILE, { force: true }); } catch {}
  });
  await sleep(100);
  // Lock stamped now, holder started ~now → genuine.
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));

  const res = acquireInstanceLock();
  assert.equal(res.ok, false, 'live holder wins');
  assert.equal(res.holderPid, child.pid);
  assert.equal(isReadOnlyMode(), true, 'acquire arms read-only mode itself');

  // settings: no write while read-only.
  const { saveSettings } = await import('../tui/lib/settings.js');
  saveSettings({ theme: 'Matrix' });
  assert.ok(!existsSync(join(sandbox, 'settings.json')), 'settings.json not written read-only');

  // templates: the first-load default write is refused too.
  const { loadTemplates } = await import('../tui/lib/templateStore.js');
  const t1 = loadTemplates();
  assert.ok(t1.review, 'defaults still served in memory');
  assert.ok(!existsSync(join(sandbox, 'templates.json')), 'templates.json not written read-only');

  // Mode lifted → writes work again.
  setReadOnlyMode(false);
  saveSettings({ theme: 'Matrix' });
  assert.ok(existsSync(join(sandbox, 'settings.json')));
});

test('main.jsx wiring: the instance lock is acquired BEFORE pruneSessions', () => {
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  const lockAt = src.indexOf('acquireInstanceLock()');
  const pruneAt = src.indexOf('pruneSessions({');
  assert.ok(lockAt !== -1 && pruneAt !== -1, 'both boot calls present');
  assert.ok(lockAt < pruneAt,
    'lock must be claimed before prune persists — a second instance must already be read-only');
});
