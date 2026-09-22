// tests/fleet.provider.test.mjs — 0420: a slot can hold a non-Claude agent.
//
// Claude keeps its exact selection order (MC_MOCK → MockAgent, else PtyAgent
// / legacy Agent). Any other provider is built by an injected factory
// (`new Fleet({ agentFactories: { cursor } })`); with none registered the
// launch refuses and the slot stays empty. The snapshot carries `provider`
// on every live slot, and a non-Claude slot's `otherSessions` is null —
// claude's session list says nothing about Cursor chats.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.MC_MOCK = 'approval-request';
const { Fleet } = await import('../server/fleet.mjs');
const { MockAgent } = await import('../server/mockAgent.mjs');

const SID = '11111111-1111-4111-8111-111111111111';

class FakeCursorAgent extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    Object.assign(this, { slot: opts.slot, id: opts.id, cwd: opts.cwd, sessionId: opts.sessionId, status: 'idle' });
    this.started = 0; this.sent = []; this.killed = 0;
  }
  start() { this.started++; }
  send(t) { this.sent.push(t); }
  kill() { this.killed++; }
  toJSON() {
    return {
      id: this.id, slot: this.slot, status: this.status, cwd: this.cwd, sessionId: this.sessionId,
      model: this.opts.model, costSession: null, tokensIn: null, tokensOut: null,
    };
  }
}

function bare(opts) {
  const f = new Fleet(opts);
  f.stopPolling();
  return f;
}

test('claude is the default provider and keeps the MC_MOCK selection (MockAgent)', () => {
  const f = bare({ slots: 2 });
  const a = f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'x' });
  assert.ok(a instanceof MockAgent);
  assert.equal(a.provider, 'claude');
  assert.equal(f.snapshot().agents[0].provider, 'claude');
  f.killAll();
});

test('explicit provider "claude" is identical to the default path', () => {
  const f = bare({ slots: 1 });
  const a = f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'x', provider: 'claude' });
  assert.ok(a instanceof MockAgent);
  f.killAll();
});

test('cursor without a registered factory throws and leaves the slot empty, no change emitted', () => {
  const f = bare({ slots: 2 });
  let changes = 0;
  f.on('change', () => changes++);
  assert.throws(
    () => f.launch({ slot: 1, cwd: '/tmp', model: 'cursor:auto', name: 'c', provider: 'cursor' }),
    { message: 'Cursor sessions are not available yet' },
  );
  assert.equal(f.agents[0], null);
  assert.equal(f.snapshot().agents[0].status, 'empty');
  assert.equal(changes, 0);
});

test('an unknown provider id is refused, slot stays empty', () => {
  const f = bare({ slots: 1 });
  assert.throws(() => f.launch({ slot: 1, cwd: '/tmp', provider: 'nope' }), /unknown provider/i);
  assert.equal(f.agents[0], null);
});

test('cursor with a factory: built with launch opts, provider set, started, wired to change', () => {
  let built = null;
  const f = bare({
    slots: 3,
    viewport: { cols: 200, rows: 50 },
    agentFactories: { cursor: (opts) => (built = new FakeCursorAgent(opts)) },
  });
  let changes = 0;
  f.on('change', () => changes++);
  const a = f.launch({
    slot: 2, cwd: '/repo/x', branch: 'main', model: 'cursor:composer-2.5', name: 'x',
    permissionMode: 'plan', sessionId: SID, provider: 'cursor',
  });
  assert.equal(a, built);
  assert.equal(a.provider, 'cursor');
  assert.equal(a.started, 1);
  assert.equal(f.agentBySlot(2), a);
  for (const [k, v] of Object.entries({ slot: 2, cwd: '/repo/x', branch: 'main', model: 'cursor:composer-2.5', name: 'x', permissionMode: 'plan', sessionId: SID })) {
    assert.equal(a.opts[k], v, `factory got ${k}`);
  }
  assert.match(a.opts.id, /^s2-/);
  assert.equal(typeof a.opts.siblingSids, 'function');
  assert.ok(a.opts.cols > 0 && a.opts.rows > 0, 'fleet viewport geometry is passed');
  assert.ok(changes >= 1);
  const before = changes;
  a.emit('change');
  assert.equal(changes, before + 1, "agent 'change' is forwarded");
  assert.equal(a.costCapUSD, 0, 'fleet cost cap applied like any agent');
});

test('a factory that throws leaves the slot empty', () => {
  const f = bare({ slots: 1, agentFactories: { cursor: () => { throw new Error('cursor-agent missing'); } } });
  assert.throws(() => f.launch({ slot: 1, cwd: '/tmp', provider: 'cursor' }), /cursor-agent missing/);
  assert.equal(f.agents[0], null);
});

test('a factory never sees claude launches', () => {
  let calls = 0;
  const f = bare({ slots: 1, agentFactories: { cursor: () => { calls++; return new FakeCursorAgent({ slot: 1 }); }, claude: () => { calls++; } } });
  const a = f.launch({ slot: 1, cwd: '/tmp', model: 'sonnet-4.6', name: 'x' });
  assert.ok(a instanceof MockAgent);
  assert.equal(calls, 0);
  f.killAll();
});

test('resume() routes provider through to launch and keeps resume semantics', () => {
  let built = null;
  const f = bare({ slots: 2, agentFactories: { cursor: (opts) => (built = new FakeCursorAgent(opts)) } });
  f.resume({ slot: 1, sessionId: SID, cwd: '/repo/y', model: 'cursor:auto', name: 'y', provider: 'cursor' });
  assert.equal(built.opts.resume, true);
  assert.equal(built.opts.sessionId, SID);
  assert.equal(built.opts.permissionMode, 'default', 'a Cursor resume without a saved mode uses the Cursor default');
  assert.equal(built.provider, 'cursor');
});

test('resume() for claude keeps the acceptEdits fallback', () => {
  const f = bare({ slots: 1 });
  const a = f.resume({ slot: 1, sessionId: SID, cwd: '/tmp', model: 'sonnet-4.6', name: 'z' });
  assert.equal(a.permissionMode, 'acceptEdits');
  assert.equal(a.provider, 'claude');
  f.killAll();
});

test('snapshot: provider on each live slot; cursor otherSessions is null, claude still counted', () => {
  const f = bare({ slots: 3, agentFactories: { cursor: (opts) => new FakeCursorAgent(opts) } });
  f.launch({ slot: 1, cwd: '/repo/shared', model: 'sonnet-4.6', name: 'cl' });
  f.launch({ slot: 2, cwd: '/repo/shared', model: 'cursor:auto', name: 'cu', sessionId: SID, provider: 'cursor' });
  f.claudeSessions = {
    background: [{ sessionId: 'bg-1', cwd: '/repo/shared', state: 'working', startedAt: 1 }],
    attached: [],
  };
  const snap = f.snapshot();
  assert.equal(snap.agents[0].provider, 'claude');
  assert.equal(snap.agents[0].otherSessions, 1);
  assert.equal(snap.agents[1].provider, 'cursor');
  assert.equal(snap.agents[1].otherSessions, null);
  assert.equal(snap.agents[2].status, 'empty');
  assert.ok(!('provider' in snap.agents[2]), 'empty slots are unchanged');
  f.killAll();
});

test('snapshot: an agent that reports its own provider in toJSON is not overridden', () => {
  const f = bare({ slots: 1 });
  f.agents[0] = { toJSON: () => ({ id: 'x', slot: 1, status: 'idle', provider: 'cursor' }), cwd: '/tmp', sessionId: 'x' };
  assert.equal(f.snapshot().agents[0].provider, 'cursor');
});
