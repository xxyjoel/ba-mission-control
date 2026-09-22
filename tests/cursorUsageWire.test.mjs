import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsagePoller, LAUNCH_LEAD_MS } from '../server/providers/cursor/usageSync.mjs';
import {
  buildCursorUsageSlots, applyCursorUsageTotals, wireCursorUsageSync,
} from '../tui/lib/cursorUsage.js';

const T0 = 1_800_000_000_000;
const CHAT = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'cookie-value-not-secret';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) {
      const t = { fn, ms, unref() { return this; } };
      timers.push(t);
      return t;
    },
    clearTimeoutImpl(t) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
}

function cursorAgent(over = {}) {
  return {
    id: 's2-cur',
    provider: 'cursor',
    sessionId: CHAT,
    status: 'idle',
    spawnedAt: T0,
    stateSince: T0 + 60_000,
    model: 'cursor:gpt-5',
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    context: null,
    costSession: null,
    lastTokRate: 0,
    spark: null,
    ...over,
  };
}

function makeFleet(agent) {
  const agents = [agent];
  let emitted = 0;
  return {
    agents,
    agentById: (id) => agents.find((a) => a && a.id === id) || null,
    emit() { emitted++; },
    get emitted() { return emitted; },
  };
}

test('buildCursorUsageSlots: live cursor agent with joinKeys and window', () => {
  const slots = buildCursorUsageSlots(makeFleet(cursorAgent({ status: 'working' })));
  assert.equal(slots.length, 1);
  assert.equal(slots[0].chatId, CHAT);
  assert.equal(slots[0].model, 'gpt-5');
  assert.equal(slots[0].windows[0].end, null);
  assert.ok(slots[0].joinKeys.has(CHAT));
});

test('applyCursorUsageTotals writes card fields on the live agent', () => {
  const agent = cursorAgent();
  const fleet = makeFleet(agent);
  const totals = new Map([['s2-cur', {
    tokensIn: 130, tokensCacheRead: 1000, tokensOut: 55, context: 1130, costSession: 0.42, estimated: false,
  }]]);
  applyCursorUsageTotals(fleet, totals);
  assert.equal(agent.tokensIn, 130);
  assert.equal(agent.tokensOut, 55);
  assert.equal(agent.costSession, 0.42);
  assert.equal(agent.context, 1130);
});

test('wireCursorUsageSync: poller attributes conversationId to cursor agent', async () => {
  const agent = cursorAgent({ status: 'working' });
  const fleet = makeFleet(agent);
  const ft = fakeTimers();
  let poller;

  const ctl = wireCursorUsageSync({
    fleet,
    enabled: true,
    getSessionToken: () => TOKEN,
    createPoller: (opts) => {
      poller = createUsagePoller({
        ...opts,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            usageEventsDisplay: [{
              timestamp: String(T0 + 5000),
              model: 'gpt-5',
              kind: 'USAGE_EVENT_KIND_USAGE_BASED',
              conversationId: CHAT,
              usageBasedCosts: '$0.08',
              tokenUsage: {
                inputTokens: '100', outputTokens: '40', cacheWriteTokens: '10', cacheReadTokens: '500',
              },
            }],
            totalUsageEventsCount: 1,
          }),
        }),
        now: () => T0 + 120_000,
        intervalMs: 30_000,
        setTimeoutImpl: ft.setTimeoutImpl,
        clearTimeoutImpl: ft.clearTimeoutImpl,
      });
      return poller;
    },
  });

  ctl.sync();
  assert.equal(ft.timers.length, 1);
  ft.timers.shift().fn();
  await poller.settled();

  assert.equal(agent.tokensIn, 110, 'input + cacheWrite');
  assert.equal(agent.tokensOut, 40);
  assert.equal(agent.tokensCacheRead, 500);
  assert.ok(Math.abs(agent.costSession - 0.08) < 1e-12);
  assert.equal(agent.context, 610);

  const j = { ...agent };
  assert.equal(j.provider, 'cursor');
  assert.equal(j.costSession, agent.costSession);

  ctl.stop();
});

test('wireCursorUsageSync: disabled or no cursor slots does not fetch', async () => {
  const ft = fakeTimers();
  let fetches = 0;
  const fleet = makeFleet({ id: 'empty', status: 'empty', provider: 'claude' });
  const ctl = wireCursorUsageSync({
    fleet,
    enabled: false,
    getSessionToken: () => TOKEN,
    createPoller: (opts) => createUsagePoller({
      ...opts,
      fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ usageEventsDisplay: [] }) }; },
      setTimeoutImpl: ft.setTimeoutImpl,
      clearTimeoutImpl: ft.clearTimeoutImpl,
    }),
  });
  ctl.sync();
  assert.equal(ft.timers.length, 0);
  assert.equal(fetches, 0);
  ctl.stop();
});
