// tests/statusHookTailer.eventTs.test.mjs
//
// 0449: hook status time comes from the EVENT (record.ts), not from when mc
// read the line. A rebuilt tailer replays the status file from offset 0, so a
// 14-hour-old PreToolUse used to be stamped ~0.3 s old and the card sat on
// WORKING. The file is written BEFORE the tailer starts so every case goes
// through that offset-0 replay path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { startStatusHookTailer, eventTs } from '../server/statusHookTailer.mjs';
import { deriveStatus } from '../server/deriveStatus.mjs';
import { statusFilePath } from '../server/statusFile.mjs';

const HOUR = 3600_000;

function makeAgent() {
  const agent = new EventEmitter();
  agent.sessionId = randomUUID();
  agent.hookStatus = undefined;
  agent.hookStatusTs = undefined;
  agent.lastSubHookTs = 0;
  return agent;
}

function writeRecords(agent, records) {
  const filePath = statusFilePath({ sessionId: agent.sessionId });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, records.map(r => JSON.stringify({ session_id: agent.sessionId, ...r }) + '\n').join(''));
  return filePath;
}

async function pollUntil(pred, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

async function replay(records, pred) {
  const agent = makeAgent();
  const filePath = writeRecords(agent, records);
  const handle = startStatusHookTailer({ agent });
  try {
    assert.ok(await pollUntil(() => pred(agent)), 'tailer never applied the replayed record');
  } finally {
    handle.stop();
    try { rmSync(filePath); } catch {}
  }
  return agent;
}

describe('0449: hook status time comes from the event', () => {
  test('a 14 h old PreToolUse replayed from offset 0 is not fresh', async () => {
    const ts = Date.now() - 14 * HOUR;
    const agent = await replay([{ ts, event: 'PreToolUse' }], a => a.hookStatus === 'working');
    const age = Date.now() - agent.hookStatusTs;
    assert.ok(age > 13 * HOUR, `hookStatusTs must carry the event's age; stamped ${age} ms old`);
    assert.equal(agent.hookStatusTs, ts);
  });

  test('a 14 h old sub-agent tool event does not refresh lastSubHookTs', async () => {
    const ts = Date.now() - 14 * HOUR;
    const agent = await replay([{ ts, event: 'PreToolUse', sub: true }], a => a.lastSubHookTs > 0);
    const age = Date.now() - agent.lastSubHookTs;
    assert.ok(age > 13 * HOUR, `lastSubHookTs must carry the event's age; stamped ${age} ms old`);
  });

  test('a future ts is clamped to now', async () => {
    const before = Date.now();
    const agent = await replay([{ ts: before + 10 * HOUR, event: 'PreToolUse' }], a => a.hookStatus === 'working');
    assert.ok(agent.hookStatusTs <= Date.now(), 'a future record must not stamp a future time');
    assert.ok(agent.hookStatusTs >= before);
  });

  test('a missing ts falls back to now', async () => {
    const before = Date.now();
    const agent = await replay([{ event: 'PreToolUse' }], a => a.hookStatus === 'working');
    assert.ok(agent.hookStatusTs >= before && agent.hookStatusTs <= Date.now());
  });

  test('the P3 waiting→working lift stamps the PostToolUse time', async () => {
    const t0 = Date.now() - 14 * HOUR;
    const agent = await replay([
      { ts: t0, event: 'Notification', notification_type: 'permission_prompt' },
      { ts: t0 + 1000, event: 'PostToolUse', tool_name: 'Bash' },
    ], a => a.hookStatus === 'working');
    assert.equal(agent.hookStatusTs, t0 + 1000);
  });

  test('an older sub event cannot move lastSubHookTs backwards (max)', async () => {
    const recent = Date.now() - 1000;
    const agent = makeAgent();
    agent.lastSubHookTs = recent;
    const filePath = writeRecords(agent, [
      { ts: Date.now() - 14 * HOUR, event: 'PreToolUse', sub: true },
      { ts: Date.now(), event: 'PreToolUse' }, // main-thread record to wait on
    ]);
    const handle = startStatusHookTailer({ agent });
    try {
      assert.ok(await pollUntil(() => agent.hookStatus === 'working'));
      assert.equal(agent.lastSubHookTs, recent);
    } finally {
      handle.stop();
      try { rmSync(filePath); } catch {}
    }
  });

  test('a Stop keeps the read-time stamp (same clock as lastConnectorTs)', async () => {
    const ts = Date.now() - 14 * HOUR;
    const before = Date.now();
    const agent = await replay([{ ts, event: 'Stop' }], a => a.hookStatus === 'idle');
    assert.ok(agent.hookStatusTs >= before && agent.hookStatusTs <= Date.now(),
      'idle is compared with the read-time transcript clock, so it must be stamped at read time');
  });

  test('a live Stop still beats a transcript record read just before it (deriveStatus)', async () => {
    // Cloud-synced path: Stop written at T, the transcript's end-of-turn
    // record (question-shaped -> connector 'waiting') read at T+1.2 s, the
    // hook line read after that. The turn is over: the card must read idle.
    const T = Date.now() - 1400;
    const agent = await replay([{ ts: T, event: 'Stop' }], a => a.hookStatus === 'idle');
    for (const connectorStatus of ['waiting', 'working']) {
      const d = deriveStatus({
        hookStatus: agent.hookStatus, hookStatusTs: agent.hookStatusTs,
        connectorStatus, lastConnectorTs: T + 1200, hasPty: true, lastPtyTs: 0,
      }, Date.now());
      assert.equal(d.status, 'idle', `connector ${connectorStatus} must not beat a later-read Stop`);
    }
  });
});

describe('0449: eventTs rejects untrusted ts values', () => {
  for (const [label, ts] of [
    ['true', true], ['"5"', '5'], ['[7]', [7]], ['seconds 1.7e9', 1.7e9],
    ['negative', -1], ['NaN', NaN], ['Infinity', Infinity], ['null', null], ['string ms', String(Date.now() - HOUR)],
  ]) {
    test(`${label} falls back to now`, () => {
      const before = Date.now();
      const got = eventTs({ ts });
      assert.ok(got >= before && got <= Date.now(), `${label} -> ${got}`);
    });
  }

  test('a valid ms ts passes through', () => {
    const ts = Date.now() - HOUR;
    assert.equal(eventTs({ ts }), ts);
  });
});
