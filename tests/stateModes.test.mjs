// tests/stateModes.test.mjs — 0408/S4 regression.
//
// mc's on-disk state (settings.json holds the Slack webhook when set;
// ~/.local/state/claude-mc holds whole conversation transcripts) was written
// with the default umask → 0644 files / 0755 dirs. Pinned here:
//   1. every store write lands 0600, every created state dir 0700
//      (settings, sessions, costs, templates, mc.lock, debug.log,
//      the emit-status hook file, the Agent transcript);
//   2. tightenStateModes() — the one-time boot pass — chmods EXISTING
//      loose files/dirs and skips symlinks;
//   3. server/agent.mjs transcript paths get the UUID guard the other
//      modules already had (no path from a non-UUID sessionId).
//
// Everything runs against throwaway dirs: MC_CONFIG_DIR, XDG_STATE_HOME and
// (for subprocesses) HOME are redirected BEFORE any module import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, symlinkSync,
  chmodSync, lstatSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const base = mkdtempSync(join(tmpdir(), 'mc-modes-'));
const cfg = join(base, 'cfg');            // NOT pre-created — the stores must mkdir it
const state = join(base, 'state');
process.env.MC_CONFIG_DIR = cfg;
process.env.XDG_STATE_HOME = state;
process.env.MC_DEBUG = '1';
delete process.env.MC_NO_TRANSCRIPT;       // the transcript test needs writes on
process.env.CLAUDE_BIN = join(root, 'tests', 'fixtures', 'fakeclaude-events.sh');

const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UU = '44444444-4444-4444-8444-444444444444';

test('every store write lands 0600 in a 0700 config dir', async () => {
  const { saveSettings, SETTINGS_DEFAULTS } = await import('../tui/lib/settings.js');
  const { syncFromSnapshot } = await import('../tui/lib/sessionStore.js');
  const { CostStore } = await import('../tui/lib/costStore.js');
  const { loadTemplates } = await import('../tui/lib/templateStore.js');
  const { acquireInstanceLock, releaseInstanceLock } = await import('../tui/lib/instanceLock.js');

  saveSettings({ ...SETTINGS_DEFAULTS, slackWebhook: 'https://hooks.slack.com/services/T0/B0/SECRET' });
  saveSettings({ ...SETTINGS_DEFAULTS, slackWebhook: 'https://hooks.slack.com/services/T0/B0/SECRET' });
  syncFromSnapshot([{
    slot: 1, status: 'idle', id: 's1', sessionId: UU, cwd: '/repo/x',
    branch: 'main', model: 'opus-4.8', name: 'x', permissionMode: 'acceptEdits',
  }]);
  const cs = new CostStore();
  cs.update([{ id: 's1', sessionId: UU, status: 'idle', costSession: 0 }]);
  cs.update([{ id: 's1', sessionId: UU, status: 'idle', costSession: 1.5 }]);
  acquireInstanceLock();
  loadTemplates();

  assert.equal(mode(cfg), '700', 'config dir 0700');
  for (const f of ['settings.json', 'settings.json.bak', 'sessions.json', 'costs-week.json', 'mc.lock', 'templates.json']) {
    assert.equal(mode(join(cfg, f)), '600', `${f} 0600`);
  }
  releaseInstanceLock();
});

test('debug log dir 0700, file 0600', async () => {
  const { dlog, debugLogPath } = await import('../tui/lib/debugLog.js');
  dlog('test', 'hello', { a: 1 });
  const p = debugLogPath();
  assert.ok(p.startsWith(state), 'debug log stays in the sandbox');
  assert.equal(mode(dirname(p)), '700');
  assert.equal(mode(p), '600');
});

test('emit-status hook writes its NDJSON file 0600 under 0700 dirs', () => {
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: UU });
  execFileSync(process.execPath, [join(root, 'server', 'hooks', 'emit-status.mjs')], {
    input: payload,
    env: { ...process.env, HOME: home },
  });
  const statusFile = join(home, '.local', 'state', 'claude-mc', 'status', `${UU}.ndjson`);
  assert.ok(existsSync(statusFile), 'hook wrote the status line');
  assert.equal(mode(statusFile), '600');
  assert.equal(mode(dirname(statusFile)), '700');
});

test('Agent transcript: UUID guard + 0600/0700 modes', async () => {
  const { Agent, transcriptPathFor, TRANSCRIPT_BASE_DIR } = await import('../server/agent.mjs');
  assert.ok(TRANSCRIPT_BASE_DIR.startsWith(state), 'transcripts stay in the sandbox');

  // Pure guard: traversal-shaped and garbage ids yield NO path.
  assert.equal(transcriptPathFor('../../evil'), null);
  assert.equal(transcriptPathFor('not-a-uuid'), null);
  assert.equal(transcriptPathFor(''), null);
  assert.ok(transcriptPathFor(UU).endsWith(`${UU}.jsonl`));

  // Behavioral: a session with a valid UUID writes a 0600 transcript in a
  // 0700 dir; a non-UUID sessionId writes nothing at all.
  const good = new Agent({ slot: 1, cwd: base, model: 'sonnet-4.6', sessionId: UU });
  good.start();
  const bad = new Agent({ slot: 2, cwd: base, model: 'sonnet-4.6', sessionId: '../../evil' });
  bad.start();
  await sleep(700); // let the fake claude's init event land
  try {
    const tp = join(TRANSCRIPT_BASE_DIR, `${UU}.jsonl`);
    assert.ok(existsSync(tp), 'valid session transcript exists');
    assert.equal(mode(tp), '600', 'transcript 0600');
    assert.equal(mode(TRANSCRIPT_BASE_DIR), '700', 'transcript dir 0700');
    assert.ok(!existsSync(join(dirname(TRANSCRIPT_BASE_DIR), 'evil.jsonl')),
      'no file escaped the transcript dir');
  } finally {
    good.kill();
    bad.kill();
  }
});

test('tightenStateModes: existing loose files/dirs are tightened; symlinks skipped', async () => {
  const { tightenStateModes } = await import('../tui/lib/instanceLock.js');
  const looseCfg = join(base, 'loose-cfg');
  const looseState = join(base, 'loose-state');
  mkdirSync(join(looseState, 'sessions'), { recursive: true });
  mkdirSync(looseCfg, { recursive: true });
  writeFileSync(join(looseCfg, 'settings.json'), '{}');
  writeFileSync(join(looseState, 'sessions', 'old-transcript.jsonl'), '{}');
  chmodSync(looseCfg, 0o755);
  chmodSync(looseState, 0o755);
  chmodSync(join(looseState, 'sessions'), 0o755);
  chmodSync(join(looseCfg, 'settings.json'), 0o644);
  chmodSync(join(looseState, 'sessions', 'old-transcript.jsonl'), 0o644);
  // A symlink pointing outside must not be chmod'd through.
  const target = join(base, 'outside.txt');
  writeFileSync(target, 'x');
  chmodSync(target, 0o644);
  symlinkSync(target, join(looseCfg, 'link.txt'));

  const r = tightenStateModes({ configDir: looseCfg, stateDir: looseState });
  assert.ok(r.dirs >= 3 && r.files >= 2, `tightened something (${JSON.stringify(r)})`);
  assert.equal(mode(looseCfg), '700');
  assert.equal(mode(looseState), '700');
  assert.equal(mode(join(looseState, 'sessions')), '700');
  assert.equal(mode(join(looseCfg, 'settings.json')), '600');
  assert.equal(mode(join(looseState, 'sessions', 'old-transcript.jsonl')), '600');
  assert.equal(mode(target), '644', 'symlink target untouched');
  assert.ok(lstatSync(join(looseCfg, 'link.txt')).isSymbolicLink());
});

test('main.jsx wiring: the boot pass runs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'tui', 'main.jsx'), 'utf8');
  assert.ok(/tightenStateModes\(\)/.test(src), 'main.jsx calls tightenStateModes() at boot');
});
