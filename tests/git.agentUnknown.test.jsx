// tests/git.agentUnknown.test.jsx — 0452 (agent half). server/git.mjs already
// returns null on a failed read and isRepo:false for a non-repo, and the Card
// renders that. But the live agents started dirty/ahead/behind at 0, returned
// early from refreshGit on a non-repo and put no isRepo in toJSON — so a
// non-repo slot still reached the Card as dirty 0 and drew the green clean dot.
// Zoom and the Slack context line also read null dirty as clean.
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { render } from 'ink-testing-library';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { Agent } from '../server/agent.mjs';
import { CursorAgent } from '../server/providers/cursor/cursorAgent.mjs';
import Card from '../tui/Card.jsx';
import Zoom from '../tui/modals/Zoom.jsx';
import { postSlack } from '../tui/lib/slack.js';
import { UNKNOWN } from '../tui/lib/format.js';
import { makeStubAgent } from './lib/zoom-stub.js';
import { zoomBodyDims, zoomModalWidth } from '../tui/lib/zoomGeometry.js';
import { renderAt, tick, stripAnsi, THEME } from './lib/render-size.js';

// Keep git from walking up into whatever repo the temp dir sits in.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-0452-agent-')));
process.env.GIT_CEILING_DIRECTORIES = dirname(root);
const nonRepo = mkdtempSync(join(root, 'plain-'));
// A repo whose index is garbage: rev-parse still says "inside a work tree",
// but `git status` fails — a real failed dirty read.
const brokenRepo = mkdtempSync(join(root, 'broken-'));
execFileSync('git', ['init', '-q'], { cwd: brokenRepo });
writeFileSync(join(brokenRepo, '.git', 'index'), 'not an index');

const noSpawn = () => { throw new Error('test must not spawn'); };
const makePty = (cwd) => new PtyAgent({
  slot: 3, id: 's3-0452', cwd, model: 'sonnet-4.6', permissionMode: 'default',
  sessionId: '04520452-0000-4000-8000-000000000000', spawn: noSpawn,
});

const cardMeta = (snap) => {
  const f = render(
    <Card agent={{ name: 'x', spawnedAt: Date.now() - 3000, tail: [], spark: [0], ...snap }}
      width={56} theme={THEME} threshold={100000} now={Date.now()} />,
  ).lastFrame();
  return stripAnsi(f).split('\n').find((l) => l.includes('⎇'));
};

async function zoomHeader(fields) {
  const termCols = 140, termRows = 30;
  const dims = zoomBodyDims(termCols, termRows);
  const stub = makeStubAgent({ cols: dims.cols, rows: dims.rows });
  Object.assign(stub.agent, {
    name: 'stub', branch: 'main', model: 'sonnet-4.6', status: 'idle',
    context: 1000, tokensIn: 1, tokensOut: 1, tokensCacheRead: 0, costSession: 0,
    todos: [], tail: [], activeSubagents: [], ...fields,
  });
  const r = renderAt(
    <Zoom agent={stub.agent} threshold={100000} onClose={() => {}} onCyclePerm={() => {}}
      theme={THEME} width={zoomModalWidth(termCols)} height={termRows - 5}
      usage={{}} fmtReset={() => ''} weekCost={0} />,
    { cols: termCols + 20, rows: termRows },
  );
  await tick(60);
  const frame = stripAnsi(r.lastFrame());
  r.unmount();
  return frame.split('\n').find((l) => l.includes('⎇'));
}

async function slackBody(agent) {
  let body = '';
  const fetchImpl = async (_u, opts) => { body = JSON.parse(opts.body).text; return { ok: true, status: 200 }; };
  await postSlack({
    webhook: 'https://hooks.slack.com/services/T/B/X', text: 'hi', fetchImpl,
    context: { agents: [{ slot: 1, name: 'n', model: 'm', branch: 'b', status: 'idle', ...agent }] },
  });
  return body.split('\n').find((l) => l.includes('slot 1'));
}

// ── agents ────────────────────────────────────────────────────────────────────

test('a fresh PtyAgent has unknown git counts, not a clean 0', () => {
  const j = makePty(nonRepo).toJSON();
  assert.equal(j.dirty, null);
  assert.equal(j.ahead, null);
  assert.equal(j.behind, null);
  assert.ok('isRepo' in j, 'toJSON carries isRepo');
  assert.equal(j.isRepo, null, 'not yet checked');
});

test('a PtyAgent in a non-repo cwd reports isRepo false and the Card draws no clean dot', async () => {
  const a = makePty(nonRepo);
  await a.refreshGit();
  const j = a.toJSON();
  assert.equal(j.isRepo, false);
  assert.equal(j.dirty, null);
  const row = cardMeta(j);
  assert.doesNotMatch(row, /●/, `no clean dot for a non-repo: ${row}`);
});

test('a PtyAgent whose git read fails shows unknown on the Card', async () => {
  const a = makePty(brokenRepo);
  await a.refreshGit();
  const j = a.toJSON();
  assert.equal(j.isRepo, true);
  assert.equal(j.dirty, null);
  const row = cardMeta(j);
  assert.doesNotMatch(row, /●/);
  assert.ok(row.includes(UNKNOWN), `unknown marker on the Card: ${row}`);
});

test('the stream-json Agent and CursorAgent follow the same contract', async () => {
  const agents = [
    new Agent({ slot: 1, cwd: nonRepo, branch: 'main', model: 'sonnet-4.6', name: 'u', permissionMode: 'acceptEdits' }),
    new CursorAgent({
      slot: 2, id: 's2-0452', cwd: nonRepo, model: 'cursor:composer-2.5', permissionMode: 'default',
      sessionId: '11111111-2222-3333-4444-555555555555', spawn: noSpawn, mintChat: async () => 'x',
    }),
  ];
  for (const a of agents) {
    const fresh = a.toJSON();
    assert.equal(fresh.dirty, null, `${a.constructor.name} starts unknown`);
    await a.refreshGit();
    const j = a.toJSON();
    assert.equal(j.isRepo, false, `${a.constructor.name} snapshots isRepo`);
    assert.equal(j.dirty, null);
    assert.equal(j.ahead, null);
  }
});

// ── Zoom header ───────────────────────────────────────────────────────────────

test('Zoom: a non-repo shows no git chips, an unknown count shows ?, a clean tree still shows ●clean', async () => {
  const none = await zoomHeader({ isRepo: false, dirty: null, ahead: null, behind: null });
  assert.doesNotMatch(none, /●|clean/, `non-repo: ${none}`);
  const unk = await zoomHeader({ isRepo: true, dirty: null, ahead: null, behind: null });
  assert.doesNotMatch(unk, /●|clean/, `unknown: ${unk}`);
  assert.match(unk, /⎇ main \?/, `unknown marker after the branch: ${unk}`);
  const clean = await zoomHeader({ isRepo: true, dirty: 0, ahead: 0, behind: 0 });
  assert.match(clean, /●clean/);
  const dirty = await zoomHeader({ isRepo: true, dirty: 2, ahead: 1, behind: 0 });
  assert.match(dirty, /\+2 ↑1/);
});

// ── Slack context ─────────────────────────────────────────────────────────────

test('Slack: unknown dirty is not reported clean; a non-repo shows nothing', async () => {
  assert.match(await slackBody({ isRepo: true, dirty: null }), /`b` \+\? ·/);
  assert.match(await slackBody({ isRepo: false, dirty: null }), /`b` · status/);
  assert.match(await slackBody({ isRepo: true, dirty: 0 }), /`b` · status/);
  assert.match(await slackBody({ isRepo: true, dirty: 4 }), /`b` \+4 ·/);
});

test('Agent: an older git read that finishes last does not overwrite a newer one', async () => {
  // 0452 review: every turn end starts refreshGit without waiting for the
  // previous one, so two reads can finish in the wrong order.
  const a = new Agent({ slot: 1, cwd: nonRepo, branch: 'main', model: 'sonnet-4.6', name: 'u', permissionMode: 'acceptEdits' });
  let releaseOld;
  const oldRead = () => new Promise((r) => { releaseOld = () => r({ isRepo: true, branch: 'main', dirty: 5, ahead: 0, behind: 0 }); });
  const newRead = async () => ({ isRepo: true, branch: 'main', dirty: 0, ahead: 1, behind: 0 });
  const pOld = a.refreshGit(oldRead);
  await a.refreshGit(newRead);
  releaseOld();
  await pOld;
  assert.equal(a.dirty, 0, 'the newer read (dirty 0) must win');
  assert.equal(a.ahead, 1);
});
