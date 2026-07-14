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
