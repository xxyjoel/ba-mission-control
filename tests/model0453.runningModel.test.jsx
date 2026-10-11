// tests/model0453.runningModel.test.jsx — 0453: `:model` and the Dashboard
// both read the model claude is RUNNING, not the launch-time field.
//
//   changeModel — after an in-claude `/model`, agent.resolvedModel holds the
//     running cli id and agent.model still holds the launch id. Comparing with
//     agent.model made `:model <launch model>` a silent no-op ("already on").
//   Dashboard — after :resume-all agent.model can hold a CLI-form id
//     ('claude-opus-4-8'). MODELS[a.model] missed it: MODEL '—', CTX 0%.

import './lib/force-color.js';
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { PtyAgent } from '../server/ptyAgent.mjs';

const { default: Dashboard } = await import('../tui/modals/Dashboard.jsx');
const { THEMES } = await import('../tui/lib/themes.js');

const theme = THEMES['BlueArch'];
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 9100 + spawned.length,
      _args: args,
      write() {},
      kill() {},
      resize() {},
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireExit(e = { exitCode: 0, signal: 15 }) { for (const fn of [...handlers.exit]) fn(e); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

function makeAgent(spawn, overrides = {}) {
  return new PtyAgent({
    slot: 1,
    id: 's1-0453',
    cwd: '/tmp/fake-cwd-0453',
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000453',
    spawn,
    ...overrides,
  });
}

test('0453: after an in-claude /model, `:model <launch model>` switches back', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.resolvedModel = 'claude-opus-4-8'; // user typed /model opus inside claude
  const changed = p.changeModel('sonnet-4.6');
  assert.equal(changed, true, 'running opus-4.8, so sonnet-4.6 is a real switch');
  assert.equal(p.model, 'sonnet-4.6');
  assert.equal(p.resolvedModel, null);
  fake.spawned[0].fireExit();
  assert.ok(fake.spawned[1], 'relaunched');
  const args = fake.spawned[1]._args;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  p.kill();
});

test('0453: `:model <running model>` is a no-op even when the launch field differs', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.resolvedModel = 'claude-opus-4-8';
  assert.equal(p.changeModel('opus-4.8'), false, 'already running opus-4.8');
  assert.equal(fake.spawned.length, 1, 'no restart');
  p.kill();
});

test('0453: a CLI-form launch model (after :resume-all) compares as its catalog id', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake, { model: 'claude-opus-4-8' });
  p.start();
  assert.equal(p.changeModel('opus-4.8'), false, 'claude-opus-4-8 IS opus-4.8');
  assert.equal(p.changeModel('sonnet-4.6'), true, 'a different model still switches');
  p.kill();
});

test('0453: Dashboard shows MODEL and CTX for a CLI-form model id', () => {
  const agent = {
    id: 's1-cli', slot: 1, status: 'idle', name: 'cli-form', model: 'claude-opus-4-8',
    context: 500_000, costSession: 1, spark: [0, 0, 0], permissionMode: 'default',
  };
  const { lastFrame, unmount } = render(
    <Dashboard agents={[agent]} threshold={150_000} theme={theme} onClose={() => {}}
      onZoom={() => {}} onFocus={() => {}} initialSlot={1} width={120} />,
  );
  const row = strip(lastFrame()).split('\n').find((l) => l.includes('cli-form')) || '';
  unmount();
  assert.match(row, /OPS/, `MODEL badge for claude-opus-4-8: ${row}`);
  assert.match(row, /\b50%/, `CTX 500k / 1M: ${row}`);
});

test('0453: Dashboard follows the running model (resolvedModel) over the launch id', () => {
  const agent = {
    id: 's1-res', slot: 1, status: 'idle', name: 'switched', model: 'opus-4.8',
    resolvedModel: 'claude-haiku-4-5-20251001',
    context: 100_000, costSession: 1, spark: [0, 0, 0], permissionMode: 'default',
  };
  const { lastFrame, unmount } = render(
    <Dashboard agents={[agent]} threshold={150_000} theme={theme} onClose={() => {}}
      onZoom={() => {}} onFocus={() => {}} initialSlot={1} width={120} />,
  );
  const row = strip(lastFrame()).split('\n').find((l) => l.includes('switched')) || '';
  unmount();
  assert.match(row, /HAI/, `running haiku: ${row}`);
  assert.match(row, /\b50%/, `CTX 100k / 200k: ${row}`);
});

test('0453: a running model the catalog does not know never matches a catalog request', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  p.resolvedModel = 'claude-opus-9-9'; // in-claude /model to a model newer than the catalog
  assert.equal(p.changeModel('sonnet-4.6'), true, 'launch model is not what claude runs');
  assert.equal(fake.spawned.length, 1, 'restart waits for the old pty to exit');
  fake.spawned[0].fireExit();
  const args = fake.spawned[1]._args;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  p.kill();
});

test('0453: a dated CLI id in the launch field compares as its catalog id', () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake, { model: 'claude-sonnet-4-6-20260101' });
  p.start();
  assert.equal(p.changeModel('sonnet-4.6'), false, 'dated snapshot IS sonnet-4.6');
  assert.equal(fake.spawned.length, 1, 'no restart');
  p.kill();
});

test('0453: Dashboard borrows the newest same-family model for an unknown Claude id', () => {
  // Same rule as Card / Zoom (resolveAgentModel): family badge, that model's maxCtx.
  const agent = {
    id: 's1-unk', slot: 1, status: 'idle', name: 'unknown-id', model: 'claude-opus-9-9',
    context: 100_000, costSession: 1, spark: [0, 0, 0], permissionMode: 'default',
  };
  const { lastFrame, unmount } = render(
    <Dashboard agents={[agent]} threshold={150_000} theme={theme} onClose={() => {}}
      onZoom={() => {}} onFocus={() => {}} initialSlot={1} width={120} />,
  );
  const row = strip(lastFrame()).split('\n').find((l) => l.includes('unknown-id')) || '';
  unmount();
  assert.match(row, /OPS/, `family badge for an unknown opus id: ${row}`);
  assert.doesNotMatch(row, /\s0%/, `CTX measured against the borrowed maxCtx: ${row}`);
});
