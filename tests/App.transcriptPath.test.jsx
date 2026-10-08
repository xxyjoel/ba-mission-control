// tests/App.transcriptPath.test.jsx — 0462. `:transcript` and `:where` used to
// print mc's legacy stream-json log path (~/.local/state/claude-mc/sessions/…)
// via transcriptPathFor, or `null` when the sid was not a UUID. The session's
// real record is the file claude writes and the PTY tailer follows:
// ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl (claudeSessionPath). A
// Cursor slot prints the file findTranscriptPath finds, or says there is none.
// Rendered wide (renderAt) so a long temp HOME path is not truncated.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const CFG = join(process.env.MC_TEST_SCRATCH || tmpdir(), 'mc-0462-transcript-path');
rmSync(CFG, { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });
process.env.MC_CONFIG_DIR = CFG;
// The tests write under homedir() (~/.claude/projects, ~/.cursor/projects), so
// point HOME at scratch even when run outside the hermetic runner.
process.env.HOME = join(CFG, 'home');
mkdirSync(process.env.HOME, { recursive: true });
after(() => rmSync(CFG, { recursive: true, force: true }));

const React = await import('react');
const { default: App } = await import('../tui/App.jsx');
const { FakeFleet, strip, tick } = await import('./lib/fakeFleet0408.js');
const { renderAt } = await import('./lib/render-size.js');
const { claudeSessionPath, claudeProjectDir } = await import('../server/sessionFileTailer.mjs');
const { TRANSCRIPT_BASE_DIR } = await import('../server/agent.mjs');

const AUTH = { ok: true, plan: 'mock', account: 'test', source: 'env' };
const SID = '0462aaaa-bbbb-4ccc-8ddd-eeeeffff0001';
const CWD = '/tmp/mc_0462.repo';

const mount = (fleet) => renderAt(React.createElement(App, { fleet, auth: AUTH }), { cols: 400, rows: 50 });
const toasts = (f) => strip(f).split('\n').filter(l => /●/.test(l)).map(l => l.replace(/.*●\s*/, '').replace(/[│\s]+$/, '').trim());

async function type(stdin, line) {
  stdin.write(':'); await tick();
  stdin.write(line); await tick();
  stdin.write('\r'); await tick(); await tick();
}

function fleetWith(patch) {
  const fleet = new FakeFleet([1]);
  Object.assign(fleet.agentBySlot(1), patch);
  return fleet;
}

for (const verb of ['transcript', 'where']) {
  test(`0462: :${verb} prints the claude session file the tailer follows`, async () => {
    const want = claudeSessionPath({ cwd: CWD, sessionId: SID });
    mkdirSync(join(want, '..'), { recursive: true });
    writeFileSync(want, '');
    try {
      const fleet = fleetWith({ sessionId: SID, cwd: CWD });
      const { stdin, lastFrame, unmount } = mount(fleet);
      await tick(); await tick();
      await type(stdin, verb);
      const ts = toasts(lastFrame());
      assert.ok(ts.some(t => t === `transcript · ${want}`), `want "transcript · ${want}"; got ${JSON.stringify(ts)}`);
      assert.ok(!ts.some(t => /null/.test(t) || t.includes(TRANSCRIPT_BASE_DIR)), `no null / legacy path; got ${JSON.stringify(ts)}`);
      unmount();
    } finally {
      rmSync(want, { force: true });
    }
  });

  test(`0462: :${verb} on a claude slot whose file is not written yet says none`, async () => {
    const fleet = fleetWith({ sessionId: SID, cwd: CWD });
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, verb);
    const ts = toasts(lastFrame());
    assert.ok(ts.some(t => t.startsWith('transcript · none')), `got ${JSON.stringify(ts)}`);
    assert.ok(!ts.some(t => t.includes(SID)), `no path to a missing file; got ${JSON.stringify(ts)}`);
    unmount();
  });

  test(`0462: :${verb} with no usable session id says so instead of printing null`, async () => {
    const fleet = fleetWith({ sessionId: 'not-a-uuid', cwd: CWD });
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, verb);
    const ts = toasts(lastFrame());
    assert.ok(!ts.some(t => /null/.test(t) || t.includes(TRANSCRIPT_BASE_DIR)), `got ${JSON.stringify(ts)}`);
    assert.ok(ts.some(t => t.startsWith('transcript · none')), `got ${JSON.stringify(ts)}`);
    unmount();
  });

  test(`0462: :${verb} on a cursor slot prints the cursor transcript that exists`, async () => {
    const chatId = 'chat-0462-a';
    const dir = join(homedir(), '.cursor', 'projects', 'enc-0462', 'agent-transcripts', chatId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${chatId}.jsonl`);
    writeFileSync(file, '');
    try {
      const fleet = fleetWith({ sessionId: chatId, cwd: CWD, provider: 'cursor', model: 'cursor:auto' });
      const { stdin, lastFrame, unmount } = mount(fleet);
      await tick(); await tick();
      await type(stdin, verb);
      const ts = toasts(lastFrame());
      assert.ok(ts.some(t => t === `transcript · ${file}`), `want ${file}; got ${JSON.stringify(ts)}`);
      unmount();
    } finally {
      rmSync(join(homedir(), '.cursor', 'projects', 'enc-0462'), { recursive: true, force: true });
    }
  });

  test(`0462: :${verb} on a cursor slot with no transcript on disk says none`, async () => {
    const fleet = fleetWith({ sessionId: 'chat-0462-missing', cwd: CWD, provider: 'cursor', model: 'cursor:auto' });
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, verb);
    const ts = toasts(lastFrame());
    assert.ok(ts.some(t => t.startsWith('transcript · none')), `got ${JSON.stringify(ts)}`);
    assert.ok(!ts.some(t => /not available for/.test(t)), `no refusal; got ${JSON.stringify(ts)}`);
    unmount();
  });

  test(`0462: :${verb} with no focused session names claude's projects dir, not the legacy dir`, async () => {
    const fleet = new FakeFleet([]);
    const { stdin, lastFrame, unmount } = mount(fleet);
    await tick(); await tick();
    await type(stdin, verb);
    const ts = toasts(lastFrame());
    const base = join(claudeProjectDir('x'), '..');
    assert.ok(ts.some(t => /^transcripts( dir)? · /.test(t) && t.endsWith(join(homedir(), '.claude', 'projects'))), `want ${base}; got ${JSON.stringify(ts)}`);
    assert.ok(!ts.some(t => t.includes(TRANSCRIPT_BASE_DIR)), `got ${JSON.stringify(ts)}`);
    unmount();
  });
}
