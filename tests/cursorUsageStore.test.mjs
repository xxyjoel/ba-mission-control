// tests/cursorUsageStore.test.mjs — persisted Cursor usage under MC_CONFIG_DIR.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mc-cursor-usage-'));
process.env.MC_CONFIG_DIR = sandbox;

const CHAT_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHAT_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

const {
  load, get, upsert, seedAgentFromStore, storeFilePath,
} = await import('../tui/lib/cursorUsageStore.js');
const { applyCursorUsageTotals } = await import('../tui/lib/cursorUsage.js');

test('cursorUsageStore: file lives under MC_CONFIG_DIR', () => {
  assert.ok(storeFilePath().startsWith(sandbox));
  upsert(CHAT_A, {
    tokensIn: 1, tokensCacheRead: null, tokensOut: null, context: null,
    costSession: null, estimated: false, lastEventTs: 100, seen: ['h:1'],
  });
  assert.ok(existsSync(join(sandbox, 'cursor-usage.json')));
});

test('cursorUsageStore: load/save roundtrip', () => {
  upsert(CHAT_B, {
    tokensIn: 10, tokensCacheRead: 20, tokensOut: 5, context: 30,
    costSession: 0.11, estimated: true, lastEventTs: 2000, seen: ['a', 'b'],
  });
  const disk = JSON.parse(readFileSync(join(sandbox, 'cursor-usage.json'), 'utf8'));
  assert.deepEqual(disk.byChatId[CHAT_B].tokensIn, 10);
  assert.deepEqual(disk.byChatId[CHAT_B].seen, ['a', 'b']);

  const mem = load();
  assert.equal(get(CHAT_B, mem).tokensOut, 5);
});

test('cursorUsageStore: upsert is idempotent for the same seen ids', () => {
  const CHAT = 'cccccccc-dddd-eeee-ffff-000000000000';
  const totals = {
    tokensIn: 50, tokensCacheRead: 0, tokensOut: 10, context: 50,
    costSession: 0.5, estimated: false, lastEventTs: 3000, seen: new Set(['k:1']),
  };
  upsert(CHAT, totals);
  const first = readFileSync(join(sandbox, 'cursor-usage.json'), 'utf8');
  upsert(CHAT, totals);
  const second = readFileSync(join(sandbox, 'cursor-usage.json'), 'utf8');
  assert.equal(first, second);
});

test('seedAgentFromStore restores null agent fields from disk', () => {
  const CHAT = 'dddddddd-eeee-ffff-0000-111111111111';
  upsert(CHAT, {
    tokensIn: 99, tokensCacheRead: 1, tokensOut: 2, context: 100,
    costSession: 0.03, estimated: false, lastEventTs: 4000, seen: ['x'],
  });
  const agent = {
    id: 's1-x',
    provider: 'cursor',
    sessionId: CHAT,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    context: null,
    costSession: null,
  };
  assert.ok(seedAgentFromStore(agent));
  assert.equal(agent.tokensIn, 99);
  assert.equal(agent.costSession, 0.03);
  assert.equal(agent.tokensOut, 2);
});

test('applyCursorUsageTotals upserts persisted totals by chatId', () => {
  const CHAT = 'eeeeeeee-ffff-0000-1111-222222222222';
  const agent = {
    id: 's2-cur',
    provider: 'cursor',
    sessionId: CHAT,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    context: null,
    costSession: null,
  };
  const fleet = {
    agents: [agent],
    agentById: (id) => (id === agent.id ? agent : null),
    emit() {},
  };
  applyCursorUsageTotals(fleet, new Map([[agent.id, {
    tokensIn: 7, tokensCacheRead: 0, tokensOut: 3, context: 7, costSession: 0.01,
    estimated: false, lastEventTs: 5000, seen: new Set(['k:9']),
  }]]));
  const row = JSON.parse(readFileSync(join(sandbox, 'cursor-usage.json'), 'utf8')).byChatId[CHAT];
  assert.equal(row.tokensIn, 7);
  assert.deepEqual(row.seen, ['k:9']);
});
