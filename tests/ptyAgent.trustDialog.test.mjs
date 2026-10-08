// tests/ptyAgent.trustDialog.test.mjs — 0468: a claude slot in a folder claude
// has not trusted opens on the trust dialog. The READY_MS drain used to type
// the first queued message into it, and its Enter picked the highlighted
// "No, exit" — the session closed before it started.
//
// Contract: queued sends are held while the dialog is on screen, the slot reads
// 'waiting', and the queue drains once the dialog is gone. mc never answers the
// dialog itself.
//
// The stand-in is tests/fixtures/fakeclaude-trust.mjs on a REAL node-pty: it
// prints the dialog text from a real capture and exits on the first Enter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ptyAgentMod from '../server/ptyAgent.mjs';

const { PtyAgent } = ptyAgentMod;
const detectTrustDialog = (rows) => {
  assert.equal(typeof ptyAgentMod.detectTrustDialog, 'function', 'ptyAgent exports detectTrustDialog');
  return ptyAgentMod.detectTrustDialog(rows);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = join(__dirname, 'fixtures', 'fakeclaude-trust.mjs');
const REAL_SCREEN = join(__dirname, 'fixtures', 'claude-trust-dialog.screen.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return !!fn();
}
function readLog(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('0468: detectTrustDialog matches the real claude capture, bottom rows only', () => {
  const rows = readFileSync(REAL_SCREEN, 'utf8').split('\n');
  assert.equal(detectTrustDialog(rows), true);
  // bottomContentRows hands detectors the last 12 content rows.
  assert.equal(detectTrustDialog(rows.filter((r) => r.trim()).slice(-12)), true);
  assert.equal(detectTrustDialog(['> ', 'esc to interrupt']), false);
  assert.equal(detectTrustDialog(null), false);
  // One anchor alone (e.g. the phrase quoted in a transcript) is not the dialog.
  assert.equal(detectTrustDialog(['   Yes, I trust this folder']), false);
  // 0468 review: a resumed transcript that quotes the whole dialog has
  // claude's composer below it. It must not read as the dialog, or the queue
  // would be held for good.
  const quoted = rows.filter((r) => r.trim()).slice(-6);
  assert.equal(detectTrustDialog([...quoted, '─'.repeat(40), '> ', '─'.repeat(40), '  ? for shortcuts']), false);
  // The user moved the cursor to "Yes" in zoom: still the dialog.
  const moved = rows.map((r) => r.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust'));
  assert.equal(detectTrustDialog(moved), true);
  // Option rows without the ❯ cursor (plain quoted text) are not the dialog.
  assert.equal(detectTrustDialog(['No, exit', 'Yes, I trust this folder', 'Enter to confirm · Esc to cancel']), false);
});

test('0468: the first message waits out the trust dialog, then drains', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-0468-'));
  const logPath = join(dir, 'input.log');
  const clearPath = join(dir, 'clear');
  const agent = new PtyAgent({
    slot: 3, id: 's3-0468', cwd: dir, model: 'sonnet-4.6',
    permissionMode: 'acceptEdits', bin: FAKE,
    env: { FAKE_TRUST_LOG: logPath, FAKE_TRUST_CLEAR: clearPath },
  });
  t.after(() => {
    try { agent.kill(); } catch {}
    try { if (agent.pty?.pid) process.kill(agent.pty.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  agent.start();
  const pid = agent.pty?.pid;
  assert.ok(pid > 1, 'fake claude spawned');
  agent.send('hello from mc');

  // Past READY_MS (3s) with margin: the old drain would have fired by now.
  await sleep(4500);
  const early = readLog(logPath);
  assert.deepEqual(early, [], `nothing may be typed into the trust dialog; got ${JSON.stringify(early)}`);
  assert.ok(agent.pty && agent.pty.pid === pid, 'claude is still running (Enter did not pick "No, exit")');
  assert.deepEqual(agent.pendingSends, ['hello from mc'], 'the message is still queued');
  assert.equal(agent.toJSON().status, 'waiting', 'the slot shows it is waiting on the user');

  // Zoom keystrokes (PtyCore.writeInput) still reach the dialog while sends
  // are held — the user must be able to answer it. No Enter: it would exit.
  assert.equal(agent.writeInput('\x1b[B'), true);
  assert.ok(await until(() => readLog(logPath).some((e) => e.phase === 'dialog' && e.data === '\x1b[B'), 2000),
    'a zoom keystroke reaches the dialog');

  // The user answers the dialog (stand-in: the fixture's clear file).
  writeFileSync(clearPath, '');
  const drained = await until(() => readLog(logPath).some((e) => e.data.includes('hello from mc')), 6000);
  const log = readLog(logPath);
  assert.ok(drained, `the queued message drains once the dialog is gone; log=${JSON.stringify(log)}`);
  assert.ok(log.filter((e) => e.data !== '\x1b[B').every((e) => e.phase === 'composer'),
    'every mc-typed byte reached the composer, none the dialog');
  assert.deepEqual(agent.pendingSends, []);
  assert.notEqual(agent.toJSON().status, 'waiting', 'waiting clears with the dialog');
});

test('0468: deriveStatus reads a live trust dialog as waiting, a dead one not', async () => {
  const { deriveStatus } = await import('../server/deriveStatus.mjs');
  const base = { connectorStatus: 'idle', hasPty: true, scanTrust: () => true };
  assert.deepEqual(
    (({ status, reason }) => ({ status, reason }))(deriveStatus(base, 1000)),
    { status: 'waiting', reason: 'trust-dialog' },
  );
  assert.equal(deriveStatus({ ...base, scanTrust: () => false }, 1000).status, 'idle');
  assert.equal(deriveStatus({ ...base, scanTrust: () => { throw new Error('x'); } }, 1000).status, 'idle');
  assert.equal(deriveStatus({ ...base, hasPty: false }, 1000).status, 'idle');
});
