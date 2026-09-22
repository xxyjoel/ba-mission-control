// tests/lib/cardGolden0420.js — the representative Claude agents whose Card
// frames were captured from the pre-0420 Card.jsx into
// tests/fixtures/card-golden-0420.json. Card.providerPlaceholder.test.jsx
// re-renders these and demands byte equality, so the D1 placeholder change
// provably leaves every Claude card untouched.
//
// Time is pinned (Card reads Date.now() for uptime / time-in-state) and cwd
// points nowhere so readProjectHealth() stays null.

export const GOLDEN_NOW = 1_790_000_000_000;

const base = {
  slot: 1, id: 's1-golden', name: 'golden', model: 'sonnet-4.6',
  branch: 'main', cwd: '/nonexistent/mc-0420-golden', dirty: 0, ahead: 0, behind: 0,
  status: 'working',
  context: 1000, tokensIn: 100, tokensOut: 50, tokensCacheRead: 0,
  costSession: 0.01, costWeek: 0,
  spark: [], lastTokRate: 0,
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', permissionMode: 'default',
  turnCount: 0, messageCount: 0,
  sessionStartedAt: GOLDEN_NOW - 5000, spawnedAt: GOLDEN_NOW - 5000, stateSince: GOLDEN_NOW - 3000,
  todos: [], tail: [], activeSubagents: [],
};

export const GOLDEN_CASES = [
  {
    name: 'working sonnet, todos, spark, live tok/min, proc stats',
    props: { cardWidth: 56 },
    agent: {
      ...base,
      context: 142_000, tokensIn: 38_400, tokensOut: 12_100, costSession: 0.42,
      spark: [0.5, 1, 2, 3, 5, 8, 5, 3, 2, 1, 2, 3, 4, 5],
      lastTokRate: 3240, procCpu: 12.4, procMemKb: 182 * 1024,
      turnCount: 12, messageCount: 340,
      todos: [
        { content: 'a', status: 'completed', activeForm: 'doing a' },
        { content: 'b', status: 'in_progress', activeForm: 'wiring the retry handler' },
        { content: 'c', status: 'pending', activeForm: 'doing c' },
      ],
    },
  },
  {
    name: 'idle fable-5.1 (estimated pricing ~), dirty branch ahead/behind, other sessions',
    props: { cardWidth: 56 },
    agent: {
      ...base, slot: 2, id: 's2-golden', name: 'estimate', model: 'fable-5.1', status: 'idle',
      dirty: 3, ahead: 2, behind: 1, otherSessions: 2,
      context: 20_000, tokensIn: 2_400_000, tokensOut: 999, costSession: 12.3456,
    },
  },
  {
    name: 'waiting approval, near ctx threshold, stuck',
    props: { cardWidth: 56 },
    agent: {
      ...base, slot: 3, id: 's3-golden', name: 'approver', model: 'opus-4.8', status: 'waiting',
      context: 140_000, stuckMin: 4,
      tail: [{ kind: 'sys', text: 'x', awaitingPrompt: { kind: 'approval' } }],
    },
  },
  {
    name: 'unknown model (resolvedModel outside the catalog) → limit ?',
    props: { cardWidth: 56 },
    agent: {
      ...base, slot: 4, id: 's4-golden', name: 'drift', model: 'nope', resolvedModel: 'claude-zeta-9',
      status: 'idle', context: 50_000,
    },
  },
  {
    name: 'legacy shape: cost/token fields absent (undefined) → $0.00 / 0↓ 0↑',
    props: { cardWidth: 56 },
    agent: (() => {
      const a = { ...base, slot: 5, id: 's5-golden', name: 'legacy', status: 'idle' };
      delete a.costSession; delete a.tokensIn; delete a.tokensOut; delete a.context;
      delete a.spark; delete a.lastTokRate;
      return a;
    })(),
  },
  {
    name: 'zero-valued fresh session, focused, narrow card',
    props: { cardWidth: 30, focused: true },
    agent: {
      ...base, slot: 6, id: 's6-golden', name: 'fresh', model: 'haiku-4.5', status: 'idle',
      context: 0, tokensIn: 0, tokensOut: 0, costSession: 0,
    },
  },
];
