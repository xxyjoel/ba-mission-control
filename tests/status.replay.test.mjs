// tests/status.replay.test.mjs — 0288: status replay harness over the corpus.
//
// Anti-whack-a-mole engine: every real status incident becomes a checked-in
// recording (tests/fixtures/status-corpus/) that replays through the REAL
// pipeline — statusHookTailer's mapEventToStatus applied exactly as doRead()
// applies it, jsonlConnector.parseEvent for transcript events, and
// PtyAgent.toJSON() as the assertion surface. No simulated arbitration: if
// toJSON()'s precedence model regresses, the recording that caught the
// original bug goes red.
//
// Time is virtualized by mocking Date.now() to the replay cursor. Both the
// tailer (hookStatusTs = Date.now()) and the connector (lastConnectorTs =
// Date.now()) stamp with the wall clock, so setting the mocked clock to each
// event's recorded ts before applying it reproduces production timing
// relationships bit-for-bit — including multi-hour gaps no synthetic test
// would ever write.
//
// Fixture format (tests/fixtures/status-corpus/):
//   <name>.status.ndjson — hook records, the emit-status.mjs on-disk shape:
//                          { ts, session_id, event, notification_type? }
//   <name>.jsonl         — OPTIONAL claude transcript events (real lines,
//                          verbatim), interleaved by their `timestamp`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { mapEventToStatus } from '../server/statusHookTailer.mjs';
import { parseEvent } from '../server/jsonlConnector.mjs';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'status-corpus');

function makeFakeSpawn() {
  return (bin, args, opts) => ({
    pid: 9999, _bin: bin, _args: args, _opts: opts,
    write() {}, kill() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  });
}

function loadFixture(name) {
  const hookPath = join(CORPUS, `${name}.status.ndjson`);
  const jsonlPath = join(CORPUS, `${name}.jsonl`);
  const events = [];
  for (const line of readFileSync(hookPath, 'utf8').trim().split('\n')) {
    const rec = JSON.parse(line);
    events.push({ ts: rec.ts, src: 'hook', rec });
  }
  if (existsSync(jsonlPath)) {
    for (const line of readFileSync(jsonlPath, 'utf8').trim().split('\n')) {
      const ev = JSON.parse(line);
      const ts = Date.parse(ev.timestamp);
      assert.ok(Number.isFinite(ts), `${name}.jsonl event needs a parseable timestamp`);
      events.push({ ts, src: 'jsonl', ev });
    }
  }
  // Stable merge by recorded ts — hook and transcript interleave exactly as
  // they did live.
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * replay(t, name, opts) — feed a corpus fixture through the real pipeline.
 * Returns the agent so callers can assert beyond the final status.
 *
 * opts.settleMs — advance the virtual clock this far past the last event
 * before the final read (models "the user glances at the card later").
 */
function replay(t, name, { settleMs = 0 } = {}) {
  const events = loadFixture(name);
  assert.ok(events.length > 0, `fixture ${name} is empty`);

  let now = events[0].ts - 5000; // boot the agent shortly before the recording
  t.mock.method(Date, 'now', () => now);

  const agent = new PtyAgent({
    slot: 1, id: 's1-replay', cwd: '/tmp/fake-replay', model: 'opus-4.6',
    permissionMode: 'auto',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000000',
    spawn: makeFakeSpawn(),
  });
  agent.start();
  t.after(() => { try { agent.kill?.(); } catch {} });

  for (const e of events) {
    now = e.ts;
    if (e.src === 'hook') {
      // Mirror statusHookTailer.doRead() exactly: null-mapping events leave
      // hookStatus/hookStatusTs untouched.
      const s = mapEventToStatus(e.rec);
      if (s != null) {
        agent.hookStatus = s;
        agent.hookStatusTs = Date.now();
      }
    } else {
      parseEvent(e.ev, agent);
    }
  }
  now += settleMs;
  return agent;
}

// ── clean turn cycle — UserPromptSubmit → tools → Stop → idle_prompt ─────────
// Recording 1365e6c3 (2026-08-12): an ordinary session ending cleanly. The
// baseline: after Stop + idle notification the card must read idle, however
// long the user stares at it.

test('corpus 1365e6c3: clean turn cycle settles to idle', (t) => {
  const agent = replay(t, '1365e6c3-2382-4814-8064-179789ca0639', { settleMs: 60_000 });
  assert.equal(agent.toJSON().status, 'idle');
});

// ── permission prompt — Notification:permission_prompt must read waiting ─────
// Recording a9d66b68 (2026-08-12): a run of PreToolUse ending in a permission
// prompt. hookStatus='waiting' always wins (0227 precedence rule 1).

test('corpus a9d66b68: permission prompt reads waiting', (t) => {
  const agent = replay(t, 'a9d66b68-e73c-42f6-812e-ae56b2c466c2', { settleMs: 30_000 });
  assert.equal(agent.toJSON().status, 'waiting');
});

// ── dropped Stop (RC1b) — sticky-working is the CURRENT contract ─────────────
// Recording 6776f170 (2026-08-11): the feed ends on a run of PreToolUse with
// no closing Stop (hook line lost). Today's model (0250/0253) is sticky:
// working-until-Stop, deliberately — the intra-turn end_turn flash must not
// flip the card. This pins the current contract; 0293's freshness floor will
// change the expectation to decay working→idle after WORKING_STALE_MS.

test('corpus 6776f170: dropped Stop stays working (0250 sticky contract)', (t) => {
  const agent = replay(t, '6776f170-dropped-stop', { settleMs: 30_000 });
  assert.equal(agent.toJSON().status, 'working');
});

test.todo('0293: dropped Stop should decay working→idle after WORKING_STALE_MS');

// ── 0384 incident — pending AskUserQuestion must read waiting, forever ───────
// Recording a9386068 (2026-08-27, auto-job-applier): AskUserQuestion launched
// at 02:41:53Z; the user answered 13.5h later. The hook feed keeps bursting
// PreToolUse until 02:53:18Z (making the hook channel look fresher than the
// ask), then goes silent — no Stop, no notification, nothing, for the entire
// human-wait. Pre-0384 this read WORKING the whole time. The tool-sourced
// awaitingPrompt must hold 'waiting' no matter how stale it gets.

test('corpus a9386068: pending AskUserQuestion reads waiting at the ask', (t) => {
  const agent = replay(t, 'a9386068-askuserquestion-pending');
  const snap = agent.toJSON();
  assert.equal(snap.status, 'waiting',
    '0384: hook PreToolUse burst must not outvote the pending ask');
  assert.equal(agent.awaitingPrompt?.tool, 'AskUserQuestion',
    'the prompt driving the status must be the tool-sourced ask');
});

test('corpus a9386068: still waiting 13.5 hours later', (t) => {
  const agent = replay(t, 'a9386068-askuserquestion-pending', { settleMs: 13.5 * 3600_000 });
  assert.equal(agent.toJSON().status, 'waiting',
    '0384: the wait has no timeout — the card lies only when it stops saying INPUT');
});
