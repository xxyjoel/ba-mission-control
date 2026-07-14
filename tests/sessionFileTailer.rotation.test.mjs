// tests/sessionFileTailer.rotation.test.mjs — 0187: the fleet tailer must
// FOLLOW a transcript rotation (claude mints a fresh session file on /clear or
// when --session-id isn't honored) instead of freezing at the dead file. Live
// bug: a slot pinned to session 9b30a87d showed its frozen 689k context while
// the live conversation had rotated to a new file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startSessionTailer, claudeProjectDir, findRotatedSession,
} from '../server/sessionFileTailer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// distinct valid-UUID-shaped sids per call (the 0181 guard requires the shape)
const mkSid = () => `0a1b2c3d-4e5f-6789-abcd-${String(++n).padStart(12, '0')}`;

function userEvent(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-rot-'));
  mkdirSync(claudeProjectDir(cwd), { recursive: true });
  const agent = new EventEmitter();
  Object.assign(agent, {
    cwd, sessionId: mkSid(), status: 'idle', activity: '', tail: [], todos: [],
    tokensIn: 0, tokensOut: 0, context: 0, costSession: 0, resolvedModel: null,
    permissionMode: 'acceptEdits', lastEventTs: 0,
    spawnedAt: Date.now() - 5000,                       // files written now are "newer"
    appendTail(e) { this.tail.push(e); },
  });
  return { agent, cwd };
}
const fileFor = (cwd, sid) => join(claudeProjectDir(cwd), `${sid}.jsonl`);

test('findRotatedSession picks the newest non-current UUID file newer than spawn', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('A'));
  const sidB = mkSid();
  writeFileSync(fileFor(cwd, sidB), userEvent('B'));
  const got = await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt);
  assert.equal(got, sidB);
  rmSync(cwd, { recursive: true, force: true });
});

test('findRotatedSession skips a sibling-claimed sid even when it is newest (0188)', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('A'));
  const sibling = mkSid();   // another live slot's transcript in the same cwd
  writeFileSync(fileFor(cwd, sibling), userEvent('B'));
  // claimed → must NOT be returned, leaving no candidate.
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt, [sibling]), null);
  // a free newer file IS returned (exclusion is specific, not blanket).
  const free = mkSid();
  writeFileSync(fileFor(cwd, free), userEvent('C'));
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt, [sibling]), free);
  rmSync(cwd, { recursive: true, force: true });
});

test('findRotatedSession returns null when the only file is the current sid', async () => {
  const { agent, cwd } = setup();
  writeFileSync(fileFor(cwd, agent.sessionId), userEvent('A'));
  assert.equal(await findRotatedSession(cwd, agent.sessionId, agent.spawnedAt), null);
  rmSync(cwd, { recursive: true, force: true });
});

test('tailer re-points to the rotated transcript and reflects its state', async () => {
  const { agent, cwd } = setup();
  const sidA = agent.sessionId;
  writeFileSync(fileFor(cwd, sidA), userEvent('session-A-content'));

  const tailer = startSessionTailer({ agent, statPollMs: 30, rotateAfterFrozenPolls: 2 });
  await sleep(120);
  assert.equal(agent.activity, 'session-A-content', 'primed from file A');
  assert.equal(agent.sessionId, sidA);

  // claude rotates: a fresh transcript appears, file A goes dead.
  const sidB = mkSid();
  writeFileSync(fileFor(cwd, sidB), userEvent('ROTATED-TO-B'));

  await sleep(300); // a few frozen polls → hunt → re-point → prime B
  assert.equal(agent.sessionId, sidB, 'tailer followed the rotation');
  assert.equal(agent.activity, 'ROTATED-TO-B', 'state now reflects file B');
  assert.ok(
    agent.tail.some((e) => e.kind === 'sys' && /session rotated/.test(e.text || '')),
    'left a rotation breadcrumb',
  );

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test('tailer does NOT re-point when an idle file simply stops growing (no sibling)', async () => {
  const { agent, cwd } = setup();
  const sidA = agent.sessionId;
  writeFileSync(fileFor(cwd, sidA), userEvent('only-session'));

  const tailer = startSessionTailer({ agent, statPollMs: 30, rotateAfterFrozenPolls: 2 });
  await sleep(300); // plenty of frozen polls, but no sibling exists
  assert.equal(agent.sessionId, sidA, 'stayed on the only session');
  assert.ok(!agent.tail.some((e) => /session rotated/.test(e.text || '')));

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test('tailer does NOT re-point onto a sibling slot\'s active file (0188)', async () => {
  const { agent, cwd } = setup();
  const sidA = agent.sessionId;
  writeFileSync(fileFor(cwd, sidA), userEvent('slot-1-content'));
  // slot 2 shares the cwd; its (newer) transcript is claimed by the fleet.
  const sidSibling = mkSid();
  writeFileSync(fileFor(cwd, sidSibling), userEvent('slot-2-content'));

  const tailer = startSessionTailer({
    agent, statPollMs: 30, rotateAfterFrozenPolls: 2,
    claimedSids: () => [sidSibling],
  });
  await sleep(300); // slot 1 idle (dead file), but the only sibling is claimed
  assert.equal(agent.sessionId, sidA, 'did not steal the sibling slot\'s session');
  assert.equal(agent.activity, 'slot-1-content');
  assert.ok(!agent.tail.some((e) => /session rotated/.test(e.text || '')));

  tailer.stop();
  rmSync(cwd, { recursive: true, force: true });
});
