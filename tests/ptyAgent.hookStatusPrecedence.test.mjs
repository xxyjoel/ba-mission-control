// tests/ptyAgent.hookStatusPrecedence.test.mjs
// Paired tests for 0227 + 0228. Pins the hookStatus precedence model that
// task 0229 will implement in PtyAgent.toJSON().
//
// Decided precedence (checkpoint 0283, 2026-07-01):
//   1. hookStatus==='waiting' ALWAYS wins (no freshness gate).
//   2. working/idle: FRESHER signal wins — hookStatusTs > lastEventTs → use
//      hookStatus; else use connector (_statusValue). Overlay still applies.
//   3. hookStatus unset/null → today's behavior unchanged (connector + overlay).
//
// All 0227 tests + 0228-AC0 FAIL now: toJSON() ignores hookStatus entirely.
// The 0228 regression-guard tests pass now (connector already wins by default)
// and will continue to pass after 0229.
//
// Agent setup (no real PTY): inject fake spawn, call agent.start(), then set:
//   agent._statusValue — connector's view (bypasses workingStartTs side-effect)
//   agent.hookStatus   — hook-derived status string or undefined
//   agent.hookStatusTs — timestamp (ms) of the hook event
//   agent.lastEventTs  — timestamp of last connector event
//   agent.lastPtyTs    — set far in past to suppress working-overlay in all
//                        tests that do not explicitly need it

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const h = { data: [], exit: [] };
    const pty = {
      pid: 9000 + spawned.length, _bin: bin, _args: args, _opts: opts,
      write() {}, kill() {}, resize() {},
      onData(fn) { h.data.push(fn); return { dispose() {} }; },
      onExit(fn) { h.exit.push(fn); return { dispose() {} }; },
      fireData(s) { for (const fn of h.data) fn(s); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function bootAgent() {
  const agent = new PtyAgent({
    slot: 2, id: 's2-hook-test', cwd: '/tmp/fake-hook-test', model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'cccccccc-dddd-eeee-ffff-000000000000',
    spawn: makeFakeSpawn(),
  });
  agent.start();
  agent.lastPtyTs = Date.now() - 30000; // suppress working-overlay
  return agent;
}

// ── 0227: fresh hook wins ──────────────────────────────────────────────────────

test('0227: hookStatus=waiting (fresh) wins over connector=working, no approval prompt', () => {
  // Connector says working; no regex prompt in buffer (lastPtyTs is stale so
  // scan won't fire). hookStatus=waiting arrived freshly → must win.
  const agent = bootAgent();
  agent._statusValue = 'working';
  agent.lastConnectorTs = agent.lastEventTs =Date.now() - 5000;
  agent.hookStatus = 'waiting';
  agent.hookStatusTs = Date.now() - 500;

  assert.equal(
    agent.toJSON().status, 'waiting',
    '0227-AC1: fresh hookStatus=waiting must override connector=working without regex prompt',
  );
  agent.kill?.();
});

test('0227: hookStatus=working (fresh) wins over connector=idle', () => {
  // Connector saw end_turn → idle; PreToolUse hook fired just after → working.
  const agent = bootAgent();
  agent._statusValue = 'idle';
  agent.lastConnectorTs = agent.lastEventTs =Date.now() - 3000;
  agent.hookStatus = 'working';
  agent.hookStatusTs = Date.now() - 200;

  assert.equal(
    agent.toJSON().status, 'working',
    '0227-AC2: fresh hookStatus=working must override connector=idle',
  );
  agent.kill?.();
});

test('0227: hookStatus=waiting drives status with null term (no buffer needed)', () => {
  // Hook feed must not require a live xterm buffer. Even term=null,
  // a fresh hookStatus=waiting must produce toJSON().status==='waiting'.
  const agent = bootAgent();
  agent._statusValue = 'working';
  agent.lastConnectorTs = agent.lastEventTs =Date.now() - 4000;
  agent.hookStatus = 'waiting';
  agent.hookStatusTs = Date.now() - 100;
  agent.term = null; // torn-down or lightweight path

  assert.equal(
    agent.toJSON().status, 'waiting',
    '0227-AC3: fresh hookStatus=waiting must not require a live term buffer',
  );
});

// ── 0228: fallback when hook is absent or stale ────────────────────────────────

test('0228: fresh hookStatus=idle wins over stale connector=working (Stop event beats old JSONL)', () => {
  // Stop hook fired 1s ago; connector last read 8s ago. hookStatusTs > lastEventTs
  // → hook is fresher → idle wins. FAILS today: toJSON() ignores hookStatus.
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'working';
  agent.lastConnectorTs = agent.lastEventTs =now - 8000;
  agent.hookStatus = 'idle';
  agent.hookStatusTs = now - 1000;

  assert.equal(
    agent.toJSON().status, 'idle',
    '0228-AC0: fresh hookStatus=idle (Stop) must beat stale connector=working',
  );
  agent.kill?.();
});

test('0228: hookStatus unset → connector=working passes through unchanged', () => {
  // Regression guard: legacy path must be intact when no hook event has arrived.
  const agent = bootAgent();
  agent._statusValue = 'working';
  agent.lastConnectorTs = agent.lastEventTs =Date.now() - 1000;
  // hookStatus not set (undefined at construction)

  assert.equal(agent.toJSON().status, 'working',
    '0228-AC1: hookStatus unset → connector passes through');
  agent.kill?.();
});

test('0228: hookStatus unset → connector=idle passes through unchanged', () => {
  const agent = bootAgent();
  agent._statusValue = 'idle';
  agent.lastConnectorTs = agent.lastEventTs =Date.now() - 1000;

  assert.equal(agent.toJSON().status, 'idle',
    '0228-AC1b: hookStatus unset → idle passes through');
  agent.kill?.();
});

test('0228: stale hookStatus=idle loses to fresh connector=working (text-only-turn case)', () => {
  // hookStatusTs (10s ago) < lastEventTs (2s ago) → connector is fresher → wins.
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'working';
  agent.lastConnectorTs = agent.lastEventTs =now - 2000;
  agent.hookStatus = 'idle';
  agent.hookStatusTs = now - 10000;

  assert.equal(agent.toJSON().status, 'working',
    '0228-AC2: stale hookStatus=idle must yield to fresh connector=working');
  agent.kill?.();
});

test('0250/0253: hookStatus=working is STICKY over a fresh connector=idle (intra-turn end_turn flash)', () => {
  // Design change (regex-gating): once a tool is outstanding (PreToolUse, no Stop
  // yet), the card stays 'working' even if the connector flashes 'idle' mid-turn
  // (claude emits end_turn/turn_duration then keeps going). This is what lets the
  // hooked path drop #scanWorking — the hook 'working' is sticky until Stop.
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'idle';
  agent.lastConnectorTs = agent.lastEventTs = now - 1000; // connector flashed idle just now
  agent.hookStatus = 'working';                            // tool outstanding
  agent.hookStatusTs = now - 8000;                         // PreToolUse fired 8s ago

  assert.equal(agent.toJSON().status, 'working',
    'a tool is outstanding until Stop — the connector idle-flash must not win');
  agent.kill?.();
});

// NOTE: the existing working/approval overlay tests in approvalPrompt.test.mjs
// and workingOverlay.test.mjs remain unchanged — the overlay applies AFTER
// hook/connector base is chosen and those tests do not set hookStatus.

// ── 0384: pending human-blocking TOOL prompt outranks sticky hook-working ─────
//
// Incident (2026-08-27, auto-job-applier): AskUserQuestion fired PreToolUse
// (hook → 'working'), then NO hook fired for the 13.5h the question sat
// unanswered — no Stop (turn not over), no notification (not a permission
// prompt). Sticky-working outvoted the connector's 'waiting' the whole time.
// The connector's tool-sourced awaitingPrompt (set on the blocking tool_use,
// cleared on its tool_result) is protocol truth: no other tool can run while
// the ask is pending, so while it holds, the card must read 'waiting' — even
// when later PreToolUse events make the hook signal look fresher.

test('0384: tool-sourced awaitingPrompt forces waiting over fresher hookStatus=working', () => {
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'waiting';                 // connector saw AskUserQuestion
  agent.awaitingPrompt = {
    kind: 'single-select', tool: 'AskUserQuestion',
    question: 'Which freshness cutoff?', options: [{ num: 1, text: '24h' }], total: 1,
  };
  agent.awaitingPromptTs = now - 60000;           // ask launched a minute ago…
  agent.lastConnectorTs = agent.lastEventTs = now - 60000;
  agent.hookStatus = 'working';
  agent.hookStatusTs = now - 500;                 // …but a PreToolUse looks fresher

  assert.equal(agent.toJSON().status, 'waiting',
    '0384-AC1: pending AskUserQuestion must read waiting regardless of hook freshness');
  agent.kill?.();
});

test('0384: text-heuristic awaitingPrompt (no .tool) does NOT override sticky-working', () => {
  // detectPrompt guesses from prose ("1. … 2. … ?") — a guess must not beat
  // the protocol-level PreToolUse/Stop channel while a real tool is running.
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'working';
  agent.awaitingPrompt = { kind: 'binary' };      // end_turn text guess, no tool
  agent.awaitingPromptTs = now - 5000;
  agent.lastConnectorTs = agent.lastEventTs = now - 5000;
  agent.hookStatus = 'working';
  agent.hookStatusTs = now - 500;

  assert.equal(agent.toJSON().status, 'working',
    '0384-AC2: text-guess prompts stay subordinate to the hook channel');
  agent.kill?.();
});

test('0384: cleared awaitingPrompt restores sticky-working behavior', () => {
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'working';
  agent.awaitingPrompt = null;                    // answer landed → connector cleared it
  agent.lastConnectorTs = agent.lastEventTs = now - 1000;
  agent.hookStatus = 'working';
  agent.hookStatusTs = now - 8000;

  assert.equal(agent.toJSON().status, 'working',
    '0384-AC3: with no pending prompt the 0250 sticky-working model is unchanged');
  agent.kill?.();
});

// ── 0390: a RESOLVED ask must never pin INPUT? (stale-prompt inverse of 0384) ─
//
// Focus-duck repro (2026-08-28): user answered a pending AskUserQuestion by
// TYPING (dictation committed on ⏎) — the transcript records a plain user
// event, NOT a tool_result, so the tool_result clear never fired. The stale
// tool-sourced prompt then outranked hook working (the 0384 override doing
// its job on bad state) and the card read INPUT? while claude worked.

test('0390: plain user message clears the pending ask → working, not INPUT?', async () => {
  const { parseEvent } = await import('../server/jsonlConnector.mjs');
  const agent = bootAgent();
  const now = Date.now();
  agent.awaitingPrompt = { kind: 'binary', tool: 'AskUserQuestion' };
  agent.awaitingPromptTs = now - 30000;
  agent._statusValue = 'waiting';
  // The user types their answer — a plain user event, no tool_result.
  parseEvent({ type: 'user', message: { role: 'user', content: 'use the 24h cutoff' } }, agent);
  agent.hookStatus = 'working';
  agent.hookStatusTs = now - 100;

  assert.equal(agent.awaitingPrompt, null, 'typed answer must clear the pending ask');
  assert.equal(agent.toJSON().status, 'working',
    '0390-AC1: after a typed answer the card reads working, not stale INPUT?');
  agent.kill?.();
});

test('0390: PostToolUse(AskUserQuestion) hook record shape clears the ask', async () => {
  const { mapEventToStatus } = await import('../server/statusHookTailer.mjs');
  assert.equal(mapEventToStatus({ event: 'PostToolUse' }), null,
    '0223-AC3 contract holds: PostToolUse is null-mapping; only the ask-clear uses it');
  // The tailer-side clear keys on event + tool_name from emit-status records.
  // Simulate what startStatusHookTailer.doRead does with such a record.
  const agent = bootAgent();
  agent.awaitingPrompt = { kind: 'single-select', tool: 'AskUserQuestion' };
  const rec = { ts: Date.now(), session_id: agent.sessionId, event: 'PostToolUse', tool_name: 'AskUserQuestion' };
  if (rec.event === 'PostToolUse'
    && (rec.tool_name === 'AskUserQuestion' || rec.tool_name === 'ExitPlanMode')
    && agent.awaitingPrompt) {
    agent.awaitingPrompt = null;
  }
  agent.hookStatus = 'working';
  agent.hookStatusTs = Date.now();
  assert.equal(agent.toJSON().status, 'working', '0390-AC2: cleared ask → working');
  agent.kill?.();
});

// ── 0394: noise transcript lines must not freshen the connector clock ─────────
//
// gtm-gov-miner (2026-08-29): session idle since 16:52 (Stop + idle_prompt
// hooks both landed) yet the card showed WORKING. A metadata line (title /
// bridge marker) written at 17:23 bumped lastConnectorTs, so the idle-branch
// arbitration (hookStatusTs > lastConnectorTs ? idle : connector) handed the
// card back to the connector's stale 'working'.

test('0394: noise event does not bump connector clock — fresh Stop keeps idle', async () => {
  const { parseEvent } = await import('../server/jsonlConnector.mjs');
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'working';               // connector never saw an end_turn
  agent.lastConnectorTs = agent.lastEventTs = now - 3_600_000; // real events: 1h ago
  agent.hookStatus = 'idle';
  agent.hookStatusTs = now - 1_800_000;         // Stop landed 30min ago

  const before = agent.lastConnectorTs;
  // Metadata noise arrives NOW (title refresh, bridge marker, queue op).
  parseEvent({ type: 'ai-title', title: 'x' }, agent);
  parseEvent({ type: 'queue-operation' }, agent);
  parseEvent({ type: 'file-history-snapshot' }, agent);

  assert.equal(agent.lastConnectorTs, before,
    '0394-AC1: noise must not advance the JSONL-only activity clock');
  assert.equal(agent.toJSON().status, 'idle',
    '0394-AC2: the fresh Stop keeps the card idle despite later metadata writes');
  agent.kill?.();
});

// ── 0398: fresh background-agent activity keeps an idle card on working ───────
//
// focus-duck (2026-08-30): three background builders running, main thread
// Stopped → card read IDLE. Background Agent launches return their tool_result
// instantly, so the sub-tagged hook events (invisible to hookStatus per 0395)
// are the only evidence of ongoing work — their freshness must hold 'working'.

test('0398: idle + fresh sub-hook clock → working', () => {
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'idle';
  agent.lastConnectorTs = agent.lastEventTs = now - 30000;
  agent.hookStatus = 'idle';
  agent.hookStatusTs = now - 20000;      // Stop landed, main thread done
  agent.lastSubHookTs = now - 3000;      // a builder ran a tool 3s ago

  assert.equal(agent.toJSON().status, 'working',
    '0398-AC1: background agents working → the card must not read idle');
  agent.kill?.();
});

test('0398: stale sub-hook clock → idle verdict stands', () => {
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'idle';
  agent.lastConnectorTs = agent.lastEventTs = now - 60000;
  agent.hookStatus = 'idle';
  agent.hookStatusTs = now - 40000;
  agent.lastSubHookTs = now - 30000;     // builders quiet past SUB_ACTIVE_MS

  assert.equal(agent.toJSON().status, 'idle',
    '0398-AC2: finished background agents must not pin working forever');
  agent.kill?.();
});

test('0398: waiting is NEVER overridden by background activity', () => {
  const agent = bootAgent();
  const now = Date.now();
  agent._statusValue = 'waiting';
  agent.hookStatus = 'waiting';          // permission prompt confirmed
  agent.hookStatusTs = now - 1000;
  agent.lastSubHookTs = now - 500;       // builders still hammering

  assert.equal(agent.toJSON().status, 'waiting',
    '0398-AC3: a permission prompt needs the user regardless of background work');
  agent.kill?.();
});
