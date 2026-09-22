// tests/cursorAgent.test.mjs — CursorAgent with injectable spawn (R13).

import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorAgent } from '../server/providers/cursor/cursorAgent.mjs';
import { createCursorAgent } from '../server/providers/cursor/index.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: [], exit: [] };
    const pty = {
      pid: 4200 + spawned.length,
      _bin: bin,
      _args: args,
      _opts: opts,
      _writes: [],
      _kills: [],
      _resizes: [],
      write(s) { this._writes.push(s); },
      kill(sig) { this._kills.push(sig); },
      resize(c, r) { this._resizes.push([c, r]); },
      onData(fn) { handlers.data.push(fn); return { dispose() {} }; },
      onExit(fn) { handlers.exit.push(fn); return { dispose() {} }; },
      fireData(s) { for (const fn of handlers.data) fn(s); },
      fireExit({ exitCode = 0, signal = null } = {}) {
        for (const fn of handlers.exit) fn({ exitCode, signal });
      },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeAgent(spawn, overrides = {}) {
  return new CursorAgent({
    slot: 2,
    id: 's2-cursor',
    cwd: '/tmp/fake-cursor-cwd',
    model: 'cursor:composer-2.5',
    permissionMode: 'default',
    sessionId: '11111111-2222-3333-4444-555555555555',
    spawn,
    mintChat: async () => 'minted-should-not-run',
    ...overrides,
  });
}

test('CursorAgent: provider + null cost/tokens until usage sync', () => {
  const a = makeAgent(makeFakeSpawn());
  assert.equal(a.provider, 'cursor');
  const j = a.toJSON();
  assert.equal(j.provider, 'cursor');
  assert.equal(j.costSession, null);
  assert.equal(j.tokensIn, null);
  assert.equal(j.tokensOut, null);
  assert.equal(j.tokensCacheRead, null);
  assert.equal(j.context, null);
  assert.equal(j.spark, null);
  a.kill();
});

test('CursorAgent.buildSpawn: --resume chatId, --model stripped, --workspace, mode args', () => {
  const fake = makeFakeSpawn();
  const a = makeAgent(fake, { permissionMode: 'plan', autoTrust: false });
  a.start();
  assert.equal(fake.spawned.length, 1);
  const { _bin: bin, _args: args, _opts: opts } = fake.spawned[0];
  assert.match(bin, /cursor-agent|agent/);
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], a.sessionId);
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5');
  assert.ok(args.includes('--workspace'));
  assert.equal(args[args.indexOf('--workspace') + 1], '/tmp/fake-cursor-cwd');
  assert.deepEqual(
    args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2),
    ['--mode', 'plan'],
  );
  assert.ok(!args.includes('--trust'));
  assert.equal(opts.env.TERM, 'xterm-256color');
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
  a.kill();
});

test('CursorAgent.buildSpawn: autoTrust passes --trust; MC_SLOT_TOKEN when set', () => {
  const fake = makeFakeSpawn();
  const a = makeAgent(fake, { autoTrust: true, slotToken: 'tok-xyz' });
  a.start();
  const args = fake.spawned[0]._args;
  const env = fake.spawned[0]._opts.env;
  assert.ok(args.includes('--trust'));
  assert.equal(env.MC_SLOT_TOKEN, 'tok-xyz');
  a.kill();
});

test('CursorAgent: mints sessionId via create-chat when missing', async () => {
  const fake = makeFakeSpawn();
  const mints = [];
  const a = new CursorAgent({
    slot: 1,
    cwd: '/tmp/x',
    model: 'cursor:auto',
    permissionMode: 'default',
    spawn: fake,
    mintChat: async ({ bin, args }) => {
      mints.push({ bin, args });
      return 'dc1435e1-18b7-4868-8a51-8e811dc470e4';
    },
  });
  assert.equal(a.sessionId, null);
  await a.ensureSessionId();
  assert.equal(a.sessionId, 'dc1435e1-18b7-4868-8a51-8e811dc470e4');
  assert.equal(mints.length, 1);
  assert.deepEqual(mints[0].args, ['create-chat']);
  a.start();
  assert.equal(fake.spawned[0]._args[fake.spawned[0]._args.indexOf('--resume') + 1], a.sessionId);
  a.kill();
});

test('createCursorAgent factory returns CursorAgent', () => {
  const a = createCursorAgent({
    slot: 3,
    cwd: '/tmp/y',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn: makeFakeSpawn(),
  });
  assert.ok(a instanceof CursorAgent);
  assert.equal(a.provider, 'cursor');
  a.kill();
});

test('CursorAgent.changeModel: teardown + restart with new model', () => {
  const fake = makeFakeSpawn();
  const a = makeAgent(fake);
  a.start();
  assert.equal(fake.spawned.length, 1);
  // Simulate ready + kill path used by changeModel
  a.ready = true;
  const ok = a.changeModel('cursor:auto');
  assert.equal(ok, true);
  assert.equal(a.model, 'cursor:auto');
  assert.equal(fake.spawned.length, 2);
  const args = fake.spawned[1]._args;
  assert.equal(args[args.indexOf('--model') + 1], 'auto');
  a.kill();
});

test('CursorAgent.changePermissionMode: restarts with force argv', () => {
  const fake = makeFakeSpawn();
  const a = makeAgent(fake);
  a.start();
  a.ready = true;
  assert.equal(a.changePermissionMode('force'), true);
  assert.equal(a.permissionMode, 'force');
  assert.ok(fake.spawned[1]._args.includes('--force'));
  a.kill();
});

test('CursorAgent.readiness: trust prompt blocks ready', () => {
  const a = makeAgent(makeFakeSpawn());
  const r = a.readiness();
  assert.equal(typeof r.predicate, 'function');
  // Without a term, detectors fail closed → not ready
  assert.equal(r.predicate(a), false);
  a.kill();
});

test('CursorAgent.reservedKeys is empty (zoom SCROLL relocated to Ctrl+G)', () => {
  const a = makeAgent(makeFakeSpawn());
  assert.deepEqual(a.reservedKeys, []);
  a.kill();
});
