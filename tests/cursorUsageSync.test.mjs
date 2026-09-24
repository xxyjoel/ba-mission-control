// tests/cursorUsageSync.test.mjs — Cursor usage events → per-slot card numbers.
//
// The dashboard API is private and account-wide, so the three things that
// matter are: a shape we don't recognise reads as unknown (never $0), an event
// lands on the right slot or on none, and polling the same window twice never
// counts an event twice. The fixture is synthetic until the spike records a
// real response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseCost, parseUsageResponse, eventIdentity, attribute, foldIntoTotals, createUsagePoller,
  USAGE_URL, GRACE_AFTER_MS, LAUNCH_LEAD_MS, MAX_BACKOFF_MS,
} from '../server/providers/cursor/usageSync.mjs';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/cursor/usage-events.synthetic.json', import.meta.url)), 'utf8'));

const T0 = 1_800_000_000_000;

function ev(over = {}) {
  return {
    ts: T0 + 10_000, model: 'gpt-5', kind: 'USAGE_EVENT_KIND_USAGE_BASED', charged: 0.01,
    tokens: { input: 100, output: 50, cacheWrite: 20, cacheRead: 1000 }, joinKey: null,
    ...over,
  };
}
function slot(slotId, over = {}) {
  return { slotId, chatId: `chat-${slotId}`, model: 'gpt-5', windows: [{ start: T0, end: T0 + 60_000 }], joinKeys: new Set(), ...over };
}

// ── parseCost ──────────────────────────────────────────────────────────────

test('parseCost reads every form the reference implementation reads', () => {
  assert.equal(parseCost('$0.05'), 0.05);
  assert.equal(parseCost('$1,234.50'), 1234.5);
  assert.equal(parseCost(0.12), 0.12);
  assert.equal(parseCost(0), 0);
  assert.equal(parseCost({ cost: '$0.05' }), 0.05);
  assert.equal(parseCost({ totalCost: 2 }), 2);
  assert.equal(parseCost({ amount: '$3' }), 3);
  assert.ok(Math.abs(parseCost(['$0.01', 0.02]) - 0.03) < 1e-12);
});

test('parseCost: anything it cannot read is unknown, not $0', () => {
  for (const v of [undefined, null, '', 'n/a', 'Included', '$', NaN, Infinity, {}, { note: 'x' }, [], ['$0.01', 'n/a'], true]) {
    assert.equal(parseCost(v), null, `${JSON.stringify(v)} → null`);
  }
});

// ── parseUsageResponse ─────────────────────────────────────────────────────

test('parses the fixture: malformed rows dropped, int64 strings read as numbers', () => {
  const r = parseUsageResponse(FIXTURE);
  assert.ok(r);
  assert.equal(r.events.length, 9, 'the row with no timestamp is dropped');
  assert.equal(r.total, 10);
  assert.equal(r.count, 10, 'count is the raw page size, for pagination');
  const [first] = r.events;
  assert.equal(first.ts, T0 + 10_000);
  assert.equal(first.model, 'gpt-5');
  assert.equal(first.kind, 'USAGE_EVENT_KIND_INCLUDED_IN_PRO');
  assert.equal(first.charged, 0);
  assert.deepEqual(first.tokens, { input: 1200, output: 300, cacheWrite: 800, cacheRead: 40000 });
  assert.equal(first.joinKey, null, 'no join key without an extractor');
});

test('charged: explicit numbers win; not-charged kinds are 0; unreadable is null', () => {
  const byTs = new Map(parseUsageResponse(FIXTURE).events.map((e) => [e.ts - T0, e]));
  assert.equal(byTs.get(20_000).charged, 0.12);
  assert.equal(byTs.get(30_000).charged, 0.05);
  assert.ok(Math.abs(byTs.get(40_000).charged - 0.03) < 1e-12);
  assert.equal(byTs.get(50_000).charged, 0, '"Included" on an included kind is $0');
  assert.equal(byTs.get(60_000).charged, null, '"n/a" on a billed kind is unknown');
  assert.equal(byTs.get(70_000).charged, 0, 'ERRORED_NOT_CHARGED is $0 whatever the cost field says');
  assert.equal(byTs.get(80_000).charged, 1234.5);
  assert.equal(byTs.get(90_000).charged, 0, 'included with no cost field is $0');
});

test('tokens: a missing tokenUsage is unknown; a missing field inside one is 0', () => {
  const byTs = new Map(parseUsageResponse(FIXTURE).events.map((e) => [e.ts - T0, e]));
  const noUsage = byTs.get(80_000);
  assert.deepEqual(noUsage.tokens, { input: null, output: null, cacheWrite: null, cacheRead: null });
  assert.equal(noUsage.model, null);
  assert.deepEqual(byTs.get(90_000).tokens, { input: 0, output: 64, cacheWrite: 0, cacheRead: 0 });
});

test('schema surprises return null so callers render unknown', () => {
  for (const bad of [null, undefined, 42, 'nope', '{"x":1}', [], {}, { usageEventsDisplay: null },
    { usageEventsDisplay: {} }, { usageEventsDisplay: 'x' }, { usageEventsDisplay: [{ model: 'gpt-5' }, 7] }]) {
    assert.equal(parseUsageResponse(bad), null, `${JSON.stringify(bad)} → null`);
  }
});

test('an empty page is a real answer, not a surprise', () => {
  const r = parseUsageResponse({ usageEventsDisplay: [] });
  assert.deepEqual(r, { events: [], total: null, count: 0 });
});

test('accepts the raw JSON string too', () => {
  assert.equal(parseUsageResponse(JSON.stringify(FIXTURE)).events.length, 9);
  assert.equal(parseUsageResponse('{not json'), null);
});

test('joinKey is pluggable and a throwing extractor degrades to null', () => {
  const raw = { usageEventsDisplay: [{ timestamp: String(T0), model: 'gpt-5', requestId: 'req-1' }, { timestamp: String(T0 + 1) }] };
  const r = parseUsageResponse(raw, { joinKey: (e) => e.requestId });
  assert.equal(r.events[0].joinKey, 'req-1');
  assert.equal(r.events[1].joinKey, null);
  const r2 = parseUsageResponse(raw, { joinKey: () => { throw new Error('boom'); } });
  assert.equal(r2.events[0].joinKey, null);
});

// ── attribute ──────────────────────────────────────────────────────────────

const NOW = T0 + 120_000;

test('an event inside one slot\'s working window on its model goes to that slot', () => {
  const { assigned, unattributed } = attribute([ev()], [slot(1)], { now: NOW });
  assert.equal(unattributed.length, 0);
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].slotId, 1);
  assert.equal(assigned[0].share, 1);
  assert.equal(assigned[0].estimated, false);
});

test('IDE usage outside every window is unattributed', () => {
  const { assigned, unattributed } = attribute([ev({ ts: T0 - 3_600_000 }), ev({ ts: T0 + 500_000 })], [slot(1)], { now: T0 + 600_000 });
  assert.equal(assigned.length, 0);
  assert.equal(unattributed.length, 2);
});

test('an event before the slot launched is unattributed', () => {
  const { assigned } = attribute([ev({ ts: T0 - 1 })], [slot(1)], { now: NOW });
  assert.equal(assigned.length, 0);
});

test('a short grace after a window closes, then nothing', () => {
  const inGrace = ev({ ts: T0 + 60_000 + GRACE_AFTER_MS - 1 });
  const late = ev({ ts: T0 + 60_000 + GRACE_AFTER_MS + 1 });
  const { assigned, unattributed } = attribute([inGrace, late], [slot(1)], { now: NOW });
  assert.deepEqual(assigned.map((a) => a.event), [inGrace]);
  assert.deepEqual(unattributed, [late]);
});

test('an open window (end null) runs to now', () => {
  const s = slot(1, { windows: [{ start: T0, end: null }] });
  assert.equal(attribute([ev({ ts: NOW - 1 })], [s], { now: NOW }).assigned.length, 1);
});

test('a model mismatch keeps the event off the slot', () => {
  const { assigned } = attribute([ev({ model: 'claude-4.5-sonnet' })], [slot(1)], { now: NOW });
  assert.equal(assigned.length, 0);
});

test('two overlapping slots on different models: the model decides, exactly', () => {
  const a = slot(1, { model: 'gpt-5' });
  const b = slot(2, { model: 'cursor:claude-4.5-sonnet' });
  const { assigned } = attribute([ev({ model: 'claude-4.5-sonnet' })], [a, b], { now: NOW });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].slotId, 2);
  assert.equal(assigned[0].share, 1);
  assert.equal(assigned[0].estimated, false);
});

test('two overlapping slots on the same model: split evenly, both estimated', () => {
  const { assigned, unattributed } = attribute([ev()], [slot(1), slot(2)], { now: NOW });
  assert.equal(unattributed.length, 0);
  assert.deepEqual(assigned.map((a) => [a.slotId, a.share, a.estimated]), [[1, 0.5, true], [2, 0.5, true]]);
});

test('an event with model auto or none matches any slot', () => {
  for (const model of ['auto', null]) {
    const { assigned } = attribute([ev({ model })], [slot(1, { model: 'gpt-5' }), slot(2, { model: 'claude-4.5-sonnet' })], { now: NOW });
    assert.equal(assigned.length, 2, `model ${model}`);
    assert.ok(assigned.every((a) => a.share === 0.5 && a.estimated));
  }
});

test('a slot on auto competes with a slot on the event\'s model: the exact model wins, flagged estimated', () => {
  const { assigned } = attribute([ev({ model: 'gpt-5' })], [slot(1, { model: 'auto' }), slot(2, { model: 'gpt-5' })], { now: NOW });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].slotId, 2);
  assert.equal(assigned[0].share, 1);
  assert.equal(assigned[0].estimated, true, 'the auto slot could have produced it');
});

test('an exact join key beats windows and models', () => {
  const a = slot(1, { windows: [{ start: T0 + 90_000, end: null }], model: 'claude-4.5-sonnet', joinKeys: new Set(['req-1']) });
  const b = slot(2);
  const { assigned } = attribute([ev({ joinKey: 'req-1' })], [a, b], { now: NOW });
  assert.deepEqual(assigned.map((x) => [x.slotId, x.share, x.estimated, x.exact]), [[1, 1, false, true]]);
});

test('a keyed event no slot claims is not window-guessed onto a slot that has keys', () => {
  const keyed = slot(1, { joinKeys: new Set(['req-other']) });
  const unkeyed = slot(2, { model: 'claude-4.5-sonnet' });
  const e = ev({ joinKey: 'req-ide' });
  assert.equal(attribute([e], [keyed], { now: NOW }).assigned.length, 0);
  // A slot that has no keys yet still falls back to the window rule.
  const { assigned } = attribute([ev({ joinKey: 'req-ide', model: 'claude-4.5-sonnet' })], [keyed, unkeyed], { now: NOW });
  assert.deepEqual(assigned.map((x) => x.slotId), [2]);
});

test('attribute is pure: inputs are not mutated', () => {
  const events = [ev()];
  const slots = [slot(1), slot(2)];
  const before = JSON.stringify([events, slots.map((s) => ({ ...s, joinKeys: [...s.joinKeys] }))]);
  attribute(events, slots, { now: NOW });
  assert.equal(JSON.stringify([events, slots.map((s) => ({ ...s, joinKeys: [...s.joinKeys] }))]), before);
});

// ── foldIntoTotals ─────────────────────────────────────────────────────────

function assign(slotId, event, share = 1, estimated = false) {
  return { slotId, event, share, estimated, exact: false };
}

test('folds tokens the same way the Claude connector does', () => {
  const e1 = ev({ ts: T0 + 1, tokens: { input: 100, output: 50, cacheWrite: 20, cacheRead: 1000 }, charged: 0.01 });
  const e2 = ev({ ts: T0 + 2, tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 2000 }, charged: 0.02 });
  const t = foldIntoTotals(null, [assign(1, e1), assign(1, e2)]).get(1);
  assert.equal(t.tokensIn, 130, 'input + cacheWrite');
  assert.equal(t.tokensCacheRead, 3000);
  assert.equal(t.tokensOut, 55);
  assert.equal(t.context, 10 + 0 + 2000, 'last event\'s input + cacheWrite + cacheRead');
  assert.ok(Math.abs(t.costSession - 0.03) < 1e-12);
  assert.equal(t.estimated, false);
  assert.equal(t.lastEventTs, T0 + 2);
  assert.equal(t.seen.size, 2);
});

test('context follows the newest event even when events arrive out of order', () => {
  const newer = ev({ ts: T0 + 5, tokens: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } });
  const older = ev({ ts: T0 + 1, tokens: { input: 900, output: 1, cacheWrite: 0, cacheRead: 0 } });
  const t = foldIntoTotals(null, [assign(1, newer), assign(1, older)]).get(1);
  assert.equal(t.context, 3);
  assert.equal(t.lastEventTs, T0 + 5);
});

test('re-folding the same events (overlapping poll windows) never double counts', () => {
  const events = [ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 })];
  const once = foldIntoTotals(null, events.map((e) => assign(1, e)));
  // A second poll returns the same events as fresh objects plus one new one.
  const again = [...events.map((e) => ({ ...e, tokens: { ...e.tokens } })), ev({ ts: T0 + 3 })];
  const twice = foldIntoTotals(once, again.map((e) => assign(1, e)));
  assert.equal(once.get(1).tokensOut, 100);
  assert.equal(twice.get(1).tokensOut, 150);
  assert.equal(foldIntoTotals(twice, again.map((e) => assign(1, e))).get(1).tokensOut, 150);
});

test('identity prefers the join key, else ts + model + tokens', () => {
  assert.equal(eventIdentity(ev({ joinKey: 'k' })), eventIdentity(ev({ joinKey: 'k', ts: 1 })));
  assert.equal(eventIdentity(ev()), eventIdentity(ev()));
  assert.notEqual(eventIdentity(ev()), eventIdentity(ev({ tokens: { input: 101, output: 50, cacheWrite: 20, cacheRead: 1000 } })));
  assert.notEqual(eventIdentity(ev()), eventIdentity(ev({ model: 'other' })));
});

test('foldIntoTotals does not mutate the previous totals', () => {
  const prev = foldIntoTotals(null, [assign(1, ev({ ts: T0 + 1 }))]);
  const snap = { ...prev.get(1), seen: prev.get(1).seen.size };
  foldIntoTotals(prev, [assign(1, ev({ ts: T0 + 2 }))]);
  assert.deepEqual({ ...prev.get(1), seen: prev.get(1).seen.size }, snap);
});

test('cost is null only when every charge was unreadable; tokens likewise', () => {
  const unknownCost = foldIntoTotals(null, [assign(1, ev({ ts: T0 + 1, charged: null })), assign(1, ev({ ts: T0 + 2, charged: null }))]).get(1);
  assert.equal(unknownCost.costSession, null);
  const mixed = foldIntoTotals(null, [assign(1, ev({ ts: T0 + 1, charged: null })), assign(1, ev({ ts: T0 + 2, charged: 0.5 }))]).get(1);
  assert.equal(mixed.costSession, 0.5);
  const noTokens = { input: null, output: null, cacheWrite: null, cacheRead: null };
  const t = foldIntoTotals(null, [assign(1, ev({ tokens: noTokens }))]).get(1);
  assert.equal(t.tokensIn, null);
  assert.equal(t.tokensOut, null);
  assert.equal(t.tokensCacheRead, null);
  assert.equal(t.context, null);
});

test('a split event contributes its share, marks estimated, and never sets context', () => {
  const e = ev({ ts: T0 + 1, tokens: { input: 100, output: 50, cacheWrite: 0, cacheRead: 1000 }, charged: 0.2 });
  const totals = foldIntoTotals(null, [assign(1, e, 0.5, true), assign(2, e, 0.5, true)]);
  for (const id of [1, 2]) {
    const t = totals.get(id);
    assert.equal(t.tokensIn, 50);
    assert.equal(t.tokensOut, 25);
    assert.equal(t.tokensCacheRead, 500);
    assert.ok(Math.abs(t.costSession - 0.1) < 1e-12);
    assert.equal(t.estimated, true);
    assert.equal(t.context, null, 'half a context window is not a context window');
  }
});

// ── createUsagePoller ──────────────────────────────────────────────────────

const TOKEN = 'SECRET-session-token-abc123';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) {
      const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
      timers.push(t);
      return t;
    },
    clearTimeoutImpl(t) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function page(events, total) {
  const body = { usageEventsDisplay: events.map((e) => ({
    timestamp: String(e.ts), model: e.model, kind: e.kind, usageBasedCosts: e.cost ?? '$0.01',
    tokenUsage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100 },
  })) };
  if (total !== undefined) body.totalUsageEventsCount = total;
  return body;
}

function harness(over = {}) {
  const ft = fakeTimers();
  const calls = [];
  const errors = [];
  const totals = [];
  let clock = over.startNow ?? T0 + 120_000;
  let slots = over.slots ?? [slot(1, { windows: [{ start: T0, end: null }] })];
  const responder = over.responder ?? (() => okResponse(page([{ ts: T0 + 1000, model: 'gpt-5' }], 1)));
  const poller = createUsagePoller({
    fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return responder(calls.length, JSON.parse(init.body)); },
    getSessionToken: over.getSessionToken ?? (() => TOKEN),
    slotsProvider: () => slots,
    onTotals: (t, meta) => totals.push({ t, meta }),
    onError: (e) => errors.push(e),
    now: () => clock,
    intervalMs: 30_000,
    setTimeoutImpl: ft.setTimeoutImpl,
    clearTimeoutImpl: ft.clearTimeoutImpl,
    ...over.opts,
  });
  async function fire() {
    const t = ft.timers.shift();
    assert.ok(t, 'a timer is pending');
    t.fn();
    await poller.settled();
    return t;
  }
  return {
    poller, ft, calls, errors, totals, fire,
    setSlots: (s) => { slots = s; }, advance: (ms) => { clock += ms; },
  };
}

test('poller: one tick posts the documented request and reports per-slot totals', async () => {
  const h = harness();
  h.poller.start();
  assert.equal(h.ft.timers.length, 1);
  assert.equal(h.ft.timers[0].unrefd, true, 'the timer never holds the process open');
  await h.fire();
  assert.equal(h.calls.length, 1);
  const { url, init, body } = h.calls[0];
  assert.equal(url, USAGE_URL);
  assert.equal(init.method, 'POST');
  const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.origin, 'https://cursor.com');
  assert.equal(headers.cookie, `WorkosCursorSessionToken=${TOKEN}`);
  assert.deepEqual(body, { teamId: 0, startDate: String(T0 - LAUNCH_LEAD_MS), endDate: String(T0 + 120_000), page: 1, pageSize: 100 });
  assert.equal(h.totals.length, 1);
  const t = h.totals[0].t.get(1);
  assert.equal(t.tokensIn, 10);
  assert.equal(t.tokensOut, 5);
  assert.equal(h.errors.length, 0);
  assert.equal(h.ft.timers.length, 1, 'next poll scheduled');
  assert.equal(h.ft.timers[0].ms, 30_000);
  h.poller.stop();
});

test('poller: does nothing while no slot is live, and start() wakes it', async () => {
  const h = harness({ slots: [] });
  h.poller.start();
  await h.fire();
  assert.equal(h.calls.length, 0);
  assert.equal(h.ft.timers.length, 0, 'dormant: no timer, no egress');
  h.setSlots([slot(1, { windows: [{ start: T0, end: null }] })]);
  h.poller.start();
  await h.fire();
  assert.equal(h.calls.length, 1);
  h.setSlots([]);
  await h.fire();
  assert.equal(h.calls.length, 1);
  assert.equal(h.ft.timers.length, 0, 'goes dormant again when the last slot closes');
});

test('poller: start() twice does not double-schedule', () => {
  const h = harness();
  h.poller.start();
  h.poller.start();
  assert.equal(h.ft.timers.length, 1);
  h.poller.stop();
});

test('poller: no credential → reported once, fetch never called', async () => {
  const h = harness({ getSessionToken: () => null });
  h.poller.start();
  await h.fire();
  await h.fire();
  await h.fire();
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].status, 'no-credential');
  h.poller.stop();
});

test('poller: follows pagination by totalUsageEventsCount', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ ts: T0 + 1000 + i, model: 'gpt-5' }));
  const h = harness({
    responder: (n, body) => okResponse(body.page === 1 ? page(full, 130) : page(full.slice(0, 30).map((e) => ({ ...e, ts: e.ts + 500 })), 130)),
  });
  h.poller.start();
  await h.fire();
  assert.deepEqual(h.calls.map((c) => c.body.page), [1, 2]);
  assert.equal(h.totals[0].t.get(1).seen.size, 130);
  h.poller.stop();
});

test('poller: without a total, a full page means ask for the next one', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ ts: T0 + 1000 + i, model: 'gpt-5' }));
  const h = harness({ responder: (n, body) => okResponse(body.page === 1 ? page(full) : page([])) });
  h.poller.start();
  await h.fire();
  assert.deepEqual(h.calls.map((c) => c.body.page), [1, 2]);
  h.poller.stop();

  const h2 = harness({ responder: () => okResponse(page([{ ts: T0 + 1000, model: 'gpt-5' }])) });
  h2.poller.start();
  await h2.fire();
  assert.equal(h2.calls.length, 1, 'a short page is the last page');
  h2.poller.stop();
});

test('poller: errors back off exponentially, capped at 5 min, and reset on success', async () => {
  let fail = true;
  const h = harness({ responder: () => { if (fail) throw new Error('ECONNRESET'); return okResponse(page([])); } });
  h.poller.start();
  const delays = [];
  for (let i = 0; i < 6; i++) { await h.fire(); delays.push(h.ft.timers[0].ms); }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  assert.equal(MAX_BACKOFF_MS, 300_000);
  assert.ok(h.errors.every((e) => e.status === 'network'));
  fail = false;
  await h.fire();
  assert.equal(h.ft.timers[0].ms, 30_000);
  h.poller.stop();
});

test('poller: the token never appears in an error, even when the transport echoes it', async () => {
  const cases = [
    () => { throw new Error(`request failed: Cookie: WorkosCursorSessionToken=${TOKEN}`); },
    () => ({ ok: false, status: 401, json: async () => ({ error: TOKEN }) }),
    () => ({ ok: false, status: 500, json: async () => ({}) }),
    () => okResponse({ unexpected: TOKEN }),
    () => ({ ok: true, status: 200, json: async () => { throw new Error(`bad json near ${TOKEN}`); } }),
  ];
  const statuses = [];
  for (const responder of cases) {
    const h = harness({ responder });
    h.poller.start();
    await h.fire();
    h.poller.stop();
    assert.equal(h.errors.length, 1);
    const e = h.errors[0];
    statuses.push(e.status);
    assert.ok(!JSON.stringify(e).includes(TOKEN), `error ${JSON.stringify(e)} leaks the token`);
    assert.ok(!String(e.message).includes(TOKEN));
    assert.equal(h.totals.length, 0, 'no totals from a failed poll');
  }
  assert.deepEqual(statuses, ['network', 'auth', 'http', 'schema', 'schema']);
});

test('poller: stop() cancels the timer and drops an in-flight result', async () => {
  let release;
  const h = harness({ responder: () => new Promise((r) => { release = () => r(okResponse(page([]))); }) });
  h.poller.start();
  const t = h.ft.timers.shift();
  t.fn();
  await new Promise((r) => setImmediate(r));
  h.poller.stop();
  release();
  await h.poller.settled();
  assert.equal(h.totals.length, 0);
  assert.equal(h.ft.timers.length, 0);

  const h2 = harness();
  h2.poller.start();
  h2.poller.stop();
  assert.equal(h2.ft.timers.length, 0);
});

test('poller: start() right after stop() re-arms even with a stale poll in flight', async () => {
  let release;
  const h = harness({ responder: () => new Promise((r) => { release = () => r(okResponse(page([]))); }) });
  h.poller.start();
  h.ft.timers.shift().fn();
  await new Promise((r) => setImmediate(r));
  h.poller.stop();
  h.poller.start();
  assert.equal(h.ft.timers.length, 1);
  release();
  h.poller.stop();
});

test('poller: overlapping polls do not double count', async () => {
  const h = harness();
  h.poller.start();
  await h.fire();
  h.advance(30_000);
  await h.fire();
  assert.equal(h.calls.length, 2);
  assert.equal(h.totals[1].t.get(1).tokensOut, 5, 'same event seen twice, counted once');
  h.poller.stop();
});

test('poller: a throwing slotsProvider or getSessionToken never escapes', async () => {
  const h = harness({ getSessionToken: () => { throw new Error(TOKEN); } });
  h.poller.start();
  await h.fire();
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors[0].status, 'no-credential');
  assert.ok(!JSON.stringify(h.errors).includes(TOKEN));
  h.poller.stop();
});
