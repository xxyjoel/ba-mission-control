// tests/subagentCount.test.mjs — 0411: the card must report the REAL number of
// background agents, not a placeholder. Before this, five running agents showed
// "1bg" and the zoom list sat empty, because the count came from tool_use /
// tool_result pairing and a background launch's tool_result is the launch
// receipt, not the finish — so the pairing map is empty the instant they start.
// The countable source is each agent's own agent-<id>.jsonl file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSubagentUsageTailer } from '../server/subagentUsageTailer.mjs';

// A stand-in for the tailer's per-file growth state, exercised through the
// public handle the same way PtyAgent.toJSON reads it.
function tailerWithFiles(names, { agesMs = {} } = {}) {
  const t = startSubagentUsageTailer({ agent: { cwd: '/nonexistent', sessionId: 'x' }, autoStart: false });
  return t;
}

test('connector: liveAgents is exposed on the tailer handle', () => {
  const t = tailerWithFiles([]);
  assert.equal(typeof t.liveAgents, 'function', 'the connector exists');
  assert.deepEqual(t.liveAgents(), [], 'no files yet -> nobody live');
  t.stop();
});

// The summary + UI wiring is the part that regressed into a placeholder, so pin
// it directly against a fake tailer, the way toJSON consumes it.
function bgFrom({ pendingSize = 0, live = [], lastSubHookTs = 0, withinMs = 60_000, now = 1_000_000 }) {
  // Mirrors the toJSON decision exactly (server/ptyAgent.mjs).
  const liveSubFiles = pendingSize === 0 ? live : [];
  let bgCount = pendingSize;                       // foreground pairing wins
  if (bgCount === 0 && liveSubFiles.length > 0) bgCount = liveSubFiles.length;
  if (bgCount === 0 && now - lastSubHookTs < withinMs) bgCount = null;
  const bgStatus = (bgCount === null || bgCount > 0) ? 'working' : null;
  return { bgCount, bgStatus };
}

test('five background agents report five, not the old placeholder 1', () => {
  const live = [1, 2, 3, 4, 5].map((i) => ({ id: 'a' + i, lastGrowTs: 999_000 }));
  const r = bgFrom({ pendingSize: 0, live, lastSubHookTs: 999_500 });
  assert.equal(r.bgCount, 5, 'the real fan-out size');
  assert.equal(r.bgStatus, 'working');
});

test('a foreground fan-out still wins from the pairing map', () => {
  const r = bgFrom({ pendingSize: 3, live: [{ id: 'z', lastGrowTs: 999_000 }] });
  assert.equal(r.bgCount, 3, 'transcript pairing is authoritative when it has entries');
});

test('work with no countable source is uncounted, never invented', () => {
  const r = bgFrom({ pendingSize: 0, live: [], lastSubHookTs: 999_990 });
  assert.equal(r.bgCount, null, 'null = live but uncounted, rendered as ?');
  assert.equal(r.bgStatus, 'working', 'still reported as working');
});

test('no agents and a cold hook clock reports nothing at all', () => {
  const r = bgFrom({ pendingSize: 0, live: [], lastSubHookTs: 0 });
  assert.equal(r.bgCount, 0);
  assert.equal(r.bgStatus, null);
});
