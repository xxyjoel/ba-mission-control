// tests/statusHookTailer.sidRepoint.test.mjs — 0408-F3 + 0408-P3.
//
// F3: the hook-file path used to be computed ONCE from the launch sid. After a
// /clear rotation (or a claude-minted sid) the session tailer reassigns
// agent.sessionId, and every hook event — permission prompts, PostToolUse,
// sub-agent liveness — landed in a file nobody read. The tailer must follow
// agent.sessionId, the same way subagentUsageTailer re-resolves its dir each
// scan.
//
// P3: after the user approves a permission prompt, nothing status-bearing
// fires until the next PreToolUse or Stop — so the card showed NEEDS INPUT for
// a median 15.1s (p90 41.6s) while the approved tool ran. A main-thread
// PostToolUse while hookStatus==='waiting' must resolve it to 'working'.
// PostToolUse stays null-mapping for every other prior state (0223-AC3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { startStatusHookTailer } from '../server/statusHookTailer.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureStatusFile(sid) {
  const filePath = statusFilePath({ sessionId: sid });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
  return filePath;
}
const line = (sid, o) => JSON.stringify({ ts: Date.now(), session_id: sid, ...o }) + '\n';

test('F3: the tailer follows agent.sessionId to the rotated sid\'s status file', async () => {
  const sidA = randomUUID();
  const sidB = randomUUID();
  const agent = { sessionId: sidA, hookStatus: undefined };
  const fileA = ensureStatusFile(sidA);
  const fileB = ensureStatusFile(sidB);
  const handle = startStatusHookTailer({ agent, drive: 'external' });
  try {
    await sleep(50); // let the attach-time doRead settle (readingLock) so tick() isn't swallowed
    appendFileSync(fileA, line(sidA, { event: 'PreToolUse', tool_name: 'Bash' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'working', 'launch-sid events flow');

    // The session tailer re-points the slot (a /clear rotation).
    agent.sessionId = sidB;
    appendFileSync(fileB, line(sidB, { event: 'Notification', notification_type: 'permission_prompt' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'waiting',
      '0408-F3: events written under the CURRENT sid must reach hookStatus');

    // The old sid's file is no longer read.
    appendFileSync(fileA, line(sidA, { event: 'Stop' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'waiting', 'the abandoned launch-sid file is ignored');
  } finally {
    handle.stop();
    try { rmSync(fileA); rmSync(fileB); } catch {}
  }
});

test('F3: a repoint onto a not-yet-created status file starts reading once it appears', async () => {
  const sidA = randomUUID();
  const sidB = randomUUID();
  const agent = { sessionId: sidA, hookStatus: undefined };
  const fileA = ensureStatusFile(sidA);
  const fileB = statusFilePath({ sessionId: sidB }); // NOT created yet
  const handle = startStatusHookTailer({ agent, drive: 'external' });
  try {
    agent.sessionId = sidB;
    handle.tick(); await sleep(30); // repoint while the file is absent — must not throw
    writeFileSync(fileB, line(sidB, { event: 'UserPromptSubmit' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'working',
      'the backstop keeps reading and picks the file up on creation');
  } finally {
    handle.stop();
    try { rmSync(fileA); rmSync(fileB); } catch {}
  }
});

test('P3: a main-thread PostToolUse resolves hookStatus waiting → working', async () => {
  const sid = randomUUID();
  const agent = { sessionId: sid, hookStatus: undefined, emitted: 0, emit() { this.emitted++; } };
  const filePath = ensureStatusFile(sid);
  const handle = startStatusHookTailer({ agent, drive: 'external' });
  try {
    await sleep(50); // let the attach-time doRead settle (readingLock) so tick() isn't swallowed
    appendFileSync(filePath,
      line(sid, { event: 'PreToolUse', tool_name: 'Bash' }) +
      line(sid, { event: 'Notification', notification_type: 'permission_prompt' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'waiting', 'permission prompt pins waiting');

    // The user approves; the tool runs and finishes.
    appendFileSync(filePath, line(sid, { event: 'PostToolUse', tool_name: 'Bash' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'working',
      '0408-P3: PostToolUse after an approval must lift the stale waiting');
    assert.ok(agent.hookStatusTs > 0, 'hookStatusTs stamped by the resolution');
  } finally {
    handle.stop();
    try { rmSync(filePath); } catch {}
  }
});

test('P3 keeps the 0223-AC3 contract: PostToolUse over working stays null-mapping', async () => {
  const sid = randomUUID();
  const agent = { sessionId: sid, hookStatus: undefined };
  const filePath = ensureStatusFile(sid);
  const handle = startStatusHookTailer({ agent, drive: 'external' });
  try {
    await sleep(50); // let the attach-time doRead settle (readingLock) so tick() isn't swallowed
    appendFileSync(filePath, line(sid, { event: 'PreToolUse', tool_name: 'Bash' }));
    handle.tick(); await sleep(60);
    const tsAfterPre = agent.hookStatusTs;
    appendFileSync(filePath, line(sid, { event: 'PostToolUse', tool_name: 'Bash' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'working', 'unchanged');
    assert.equal(agent.hookStatusTs, tsAfterPre,
      'PostToolUse over a non-waiting state must not touch hookStatusTs (0223-AC3)');
  } finally {
    handle.stop();
    try { rmSync(filePath); } catch {}
  }
});

test('P3: a SUB-tagged PostToolUse never lifts waiting (0395 gate holds)', async () => {
  const sid = randomUUID();
  const agent = { sessionId: sid, hookStatus: undefined };
  const filePath = ensureStatusFile(sid);
  const handle = startStatusHookTailer({ agent, drive: 'external' });
  try {
    await sleep(50); // let the attach-time doRead settle (readingLock) so tick() isn't swallowed
    appendFileSync(filePath, line(sid, { event: 'Notification', notification_type: 'permission_prompt' }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'waiting');
    appendFileSync(filePath, line(sid, { event: 'PostToolUse', tool_name: 'Bash', sub: true }));
    handle.tick(); await sleep(60);
    assert.equal(agent.hookStatus, 'waiting',
      'a background agent\'s tool finishing says nothing about the main-thread prompt');
    assert.ok(agent.lastSubHookTs > 0, 'the sub event still feeds the liveness clock');
  } finally {
    handle.stop();
    try { rmSync(filePath); } catch {}
  }
});
