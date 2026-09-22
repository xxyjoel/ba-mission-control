// server/providers/cursor/usageSync.mjs — Cursor's usage feed → card numbers.
//
// cursor-agent writes no usage to disk. Its tokens and charges exist only in
// Cursor's dashboard API, a private endpoint the web dashboard calls (the
// approach comes from Ittipong/cursor-price-tracking). This module reads that
// feed and turns it into the same fields a Claude card shows, with the same
// accounting as server/jsonlConnector.mjs:
//
//   tokensIn        Σ input + cacheWrite      (fresh input, like input + cache_creation)
//   tokensCacheRead Σ cacheRead               (kept out of tokensIn; it re-counts context)
//   tokensOut       Σ output
//   context         newest event's input + cacheWrite + cacheRead
//   costSession     Σ charged
//
// The feed is account-wide: Cursor IDE usage lands in it too, and nothing
// in an event says which terminal made it. Attribution is therefore a separate,
// pure step (attribute) with its rule written down next to it.
//
// The API is undocumented and can change without notice. Anything we do not
// recognise reads as null (unknown), never 0. A $0.00 on a card that is really
// "we could not read it" would switch off costCapUSD and dailyBudgetUSD
// without anyone noticing.
//
// SECURITY: the session token is a live login credential for the user's Cursor
// account. It is held only for the duration of one request. It is never
// logged, stored, or put in an error message, and messages from the transport
// are scrubbed before they reach onError.

export const USAGE_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
// An event can be stamped slightly after the turn that caused it ends.
export const GRACE_AFTER_MS = 20_000;
// Covers skew between this machine's clock and Cursor's.
export const LAUNCH_LEAD_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
// After a good poll, the next one re-reads this far back rather than
// the whole session. Events show up late, and foldIntoTotals dedupes the
// overlap.
const REFETCH_OVERLAP_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const COST_FIELDS = ['cost', 'totalCost', 'amount', 'price', 'value'];

// parseCost — one `usageBasedCosts` value → dollars, or null when unreadable.
// The forms (string "$0.05", number, object with a cost-ish field, array to
// sum) are the ones the reference implementation handles. The reference
// returns 0 for anything else; we return null. An array with any unreadable
// element is null too, because a partial sum would under-report.
export function parseCost(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.replace(/[$,\s]/g, '');
    return /^-?(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : null;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    let sum = 0;
    for (const item of v) {
      const c = parseCost(item);
      if (c == null) return null;
      sum += c;
    }
    return sum;
  }
  if (v && typeof v === 'object') {
    for (const f of COST_FIELDS) if (v[f] !== undefined) return parseCost(v[f]);
  }
  return null;
}

// The dashboard speaks proto3 JSON: int64 values arrive as strings, and
// zero-valued fields are left out entirely.
function toCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

function parseTokens(tu) {
  if (!tu || typeof tu !== 'object' || Array.isArray(tu)) {
    return { input: null, output: null, cacheWrite: null, cacheRead: null };
  }
  // Inside a present tokenUsage, an absent field is a proto3-omitted zero.
  const f = (v) => (v === undefined ? 0 : toCount(v));
  return {
    input: f(tu.inputTokens),
    output: f(tu.outputTokens),
    cacheWrite: f(tu.cacheWriteTokens),
    cacheRead: f(tu.cacheReadTokens),
  };
}

function parseCharged(raw, kind) {
  if (typeof kind === 'string' && kind.includes('NOT_CHARGED')) return 0;
  const c = parseCost(raw.usageBasedCosts);
  if (c != null) return c;
  // Included events carry no cost, or a label such as "Included". The kind
  // tells us that nothing was billed.
  if (typeof kind === 'string' && kind.includes('INCLUDED')) return 0;
  return null;
}

// parseUsageResponse — one response page → normalised events.
//
// `joinKey(rawEvent) → string|null` extracts a request/generation id when the
// feed carries one (spike question 12). With no extractor every event has
// joinKey null and attribution falls back to working windows.
//
// Returns null on any shape we don't recognise: a missing or non-array
// usageEventsDisplay, or a non-empty page in which no row parses. Rows that
// fail on their own (no timestamp) are dropped. `count` is the raw row count,
// so pagination is judged on what the server sent, not on what we kept.
export function parseUsageResponse(json, { joinKey } = {}) {
  let body = json;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rows = body.usageEventsDisplay;
  if (!Array.isArray(rows)) return null;

  const events = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const ts = toCount(raw.timestamp);
    if (!ts) continue;
    const kind = typeof raw.kind === 'string' ? raw.kind : null;
    let key = null;
    if (joinKey) {
      try {
        const k = joinKey(raw);
        key = typeof k === 'string' && k ? k : null;
      } catch { key = null; }
    }
    events.push({
      ts,
      model: typeof raw.model === 'string' && raw.model ? raw.model : null,
      kind,
      charged: parseCharged(raw, kind),
      tokens: parseTokens(raw.tokenUsage),
      joinKey: key,
    });
  }
  if (rows.length > 0 && events.length === 0) return null;
  return { events, total: toCount(body.totalUsageEventsCount), count: rows.length };
}

// eventIdentity — what makes two sightings the same event across polls. The
// join key when the feed has one. Otherwise timestamp + model + tokens: the
// feed has no other stable id, and two distinct requests matching on all of
// these in the same millisecond is not a realistic case.
export function eventIdentity(e) {
  if (e.joinKey) return `k:${e.joinKey}`;
  const t = e.tokens || {};
  return `h:${e.ts}|${e.model ?? ''}|${t.input}|${t.output}|${t.cacheWrite}|${t.cacheRead}`;
}

function normModel(m) {
  if (typeof m !== 'string' || !m) return null;
  const s = m.replace(/^cursor:/, '').toLowerCase();
  return s === 'auto' ? null : s;
}

// TODO(cursor-usage-models): event `model` names vs cursor-agent --list-models
// ids are unverified (the spike records both). If they differ, pass a
// `modelsMatch` that maps one to the other rather than loosening this.
function defaultModelsMatch(slotModel, eventModel) {
  const a = normModel(slotModel);
  const b = normModel(eventModel);
  if (a == null || b == null) return 'any';
  return a === b ? 'exact' : null;
}

function inWindow(ts, windows, now, graceMs) {
  if (!Array.isArray(windows)) return false;
  for (const w of windows) {
    if (!w || !Number.isFinite(w.start) || ts < w.start) continue;
    const end = Number.isFinite(w.end) ? w.end + graceMs : now + graceMs;
    if (ts <= end) return true;
  }
  return false;
}

// attribute — decide which slot each event belongs to. Pure.
//
// The rule, in order:
//   1. A join key claimed by exactly one slot → that slot, exact.
//   2. Candidates are slots whose working window (plus GRACE_AFTER_MS) holds
//      the event's timestamp and whose model is compatible. 'auto' or a
//      missing model on either side is compatible with anything. A slot
//      that has join keys is left out when the event carries a key it didn't
//      claim: its own events come keyed, so an unclaimed key belongs to
//      something else, or to a hook that hasn't landed yet. In that case the
//      next poll picks it up exactly.
//   3. If some candidates match the model exactly, the wildcard ones drop out.
//   4. One candidate → share 1. It is estimated if a wildcard candidate
//      dropped out in step 3. Several → split evenly, all estimated. None →
//      unattributed.
//
// Why split rather than drop or duplicate: costSession feeds the fleet
// aggregate, costCapUSD and dailyBudgetUSD. Giving the event to none of the
// candidates makes real spend vanish from the budget. Giving the whole event
// to each counts it once per slot. An even split keeps the fleet total right,
// and the `estimated` flag lets the card mark the per-slot number `~`.
export function attribute(events, slots, { now = Date.now(), graceMs = GRACE_AFTER_MS, modelsMatch = defaultModelsMatch } = {}) {
  const assigned = [];
  const unattributed = [];
  const list = Array.isArray(slots) ? slots : [];
  for (const event of events || []) {
    if (event.joinKey) {
      const owners = list.filter((s) => s.joinKeys?.has?.(event.joinKey));
      if (owners.length === 1) {
        assigned.push({ slotId: owners[0].slotId, event, share: 1, estimated: false, exact: true });
        continue;
      }
    }
    const candidates = [];
    for (const s of list) {
      if (event.joinKey && s.joinKeys?.size > 0) continue;
      if (!inWindow(event.ts, s.windows, now, graceMs)) continue;
      const m = modelsMatch(s.model, event.model);
      if (m) candidates.push({ s, m });
    }
    const exactOnes = candidates.filter((c) => c.m === 'exact');
    const chosen = exactOnes.length > 0 ? exactOnes : candidates;
    if (chosen.length === 0) { unattributed.push(event); continue; }
    const narrowed = chosen.length < candidates.length;
    const share = 1 / chosen.length;
    for (const { s } of chosen) {
      assigned.push({ slotId: s.slotId, event, share, estimated: chosen.length > 1 || narrowed, exact: false });
    }
  }
  return { assigned, unattributed };
}

function emptyTotals() {
  return {
    tokensIn: null, tokensCacheRead: null, tokensOut: null, context: null, contextTs: null,
    costSession: null, estimated: false, lastEventTs: null, seen: new Set(),
  };
}

function addKnown(sum, v, share) {
  return v == null ? sum : (sum ?? 0) + v * share;
}

// foldIntoTotals — add attributed events to per-slot running totals.
// prevTotals: Map<slotId, totals> | null. Returns a new Map; prevTotals is not
// touched. An event already in a slot's `seen` is skipped, so folding the
// same poll window twice counts nothing twice.
//
// A field stays null until at least one event supplies it. Context is taken
// only from events that went wholly to one slot: a split event's token count
// is not that slot's context window.
export function foldIntoTotals(prevTotals, attributedEvents) {
  const out = new Map();
  for (const [id, t] of prevTotals ?? []) out.set(id, { ...t, seen: new Set(t.seen) });
  for (const a of attributedEvents || []) {
    let t = out.get(a.slotId);
    if (!t) { t = emptyTotals(); out.set(a.slotId, t); }
    const e = a.event;
    const id = eventIdentity(e);
    if (t.seen.has(id)) continue;
    t.seen.add(id);
    const share = a.share ?? 1;
    const k = e.tokens || {};
    const fresh = k.input == null || k.cacheWrite == null ? null : k.input + k.cacheWrite;
    t.tokensIn = addKnown(t.tokensIn, fresh, share);
    t.tokensCacheRead = addKnown(t.tokensCacheRead, k.cacheRead, share);
    t.tokensOut = addKnown(t.tokensOut, k.output, share);
    t.costSession = addKnown(t.costSession, e.charged, share);
    if (a.estimated || share < 1) t.estimated = true;
    if (t.lastEventTs == null || e.ts > t.lastEventTs) t.lastEventTs = e.ts;
    if (share === 1 && fresh != null && k.cacheRead != null && (t.contextTs == null || e.ts >= t.contextTs)) {
      t.context = fresh + k.cacheRead;
      t.contextTs = e.ts;
    }
  }
  return out;
}

class PollError extends Error {
  constructor(status, message, httpStatus = null) {
    super(message);
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

function redact(text, token) {
  const s = String(text ?? '');
  return token ? s.split(token).join('[redacted]') : s;
}

// TODO(cursor-usage-auth): the spike decides how the credential is presented
// (spike question 11). If it is not the dashboard cookie, pass `authHeaders`.
function cookieHeaders(token) {
  return { cookie: `WorkosCursorSessionToken=${token}` };
}

function launchOf(s) {
  if (Number.isFinite(s.launchTs)) return s.launchTs;
  const starts = (s.windows || []).map((w) => w?.start).filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

// createUsagePoller — poll the feed while any Cursor slot is live.
//
// slotsProvider() → the attribute() slot list (optionally with launchTs). An
// empty list puts the poller to sleep with no timer armed. The fleet calls
// start() again when a Cursor slot launches. onTotals(Map, meta) receives
// cumulative per-slot totals after each good poll. onError({ status, message,
// httpStatus }) gets one of: 'no-credential' (once per loss, no request
// made), 'auth', 'http', 'network', 'schema'. After an error the last good
// totals stay in place and the next poll backs off.
export function createUsagePoller({
  fetchImpl = globalThis.fetch,
  getSessionToken,
  slotsProvider,
  onTotals = () => {},
  onError = () => {},
  now = Date.now,
  intervalMs = 30_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  joinKey,
  authHeaders = cookieHeaders,
  modelsMatch,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
} = {}) {
  let timer = null;
  let inflight = null;
  let gen = 0;
  let failures = 0;
  let noCredReported = false;
  let totals = new Map();
  let cursor = null;

  let inflightGen = -1;

  function schedule(ms) {
    timer = setTimeoutImpl(() => {
      timer = null;
      // A throwing onTotals/onError is a caller bug; it must not surface as an
      // unhandled rejection that takes the fleet down.
      const p = tick(gen).catch(() => {});
      inflight = p;
      inflightGen = gen;
      p.finally(() => { if (inflight === p) inflight = null; });
    }, ms);
    timer?.unref?.();
  }

  async function fetchWindow(token, slots, t) {
    const launches = slots.map(launchOf).filter(Number.isFinite);
    let start = (launches.length ? Math.min(...launches) : t) - LAUNCH_LEAD_MS;
    const slotKey = slots.map((s) => s.slotId).sort().join(',');
    if (cursor && cursor.slotKey === slotKey) start = Math.max(start, cursor.end - REFETCH_OVERLAP_MS);
    const events = [];
    let truncated = true;
    let seenRows = 0;
    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await fetchImpl(USAGE_URL, {
          method: 'POST',
          headers: {
            accept: '*/*',
            'content-type': 'application/json',
            origin: 'https://cursor.com',
            referer: 'https://cursor.com/dashboard?tab=usage',
            ...authHeaders(token),
          },
          body: JSON.stringify({ teamId: 0, startDate: String(start), endDate: String(t), page, pageSize }),
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
        });
      } catch (e) {
        throw new PollError('network', `usage API request failed: ${redact(e?.message, token)}`);
      }
      if (!res?.ok) {
        const code = Number(res?.status) || null;
        throw new PollError(code === 401 || code === 403 ? 'auth' : 'http', `usage API HTTP ${code ?? '?'}`, code);
      }
      let json;
      try { json = await res.json(); } catch {
        throw new PollError('schema', 'usage API returned non-JSON');
      }
      const parsed = parseUsageResponse(json, { joinKey });
      if (!parsed) throw new PollError('schema', 'usage API response shape not recognised');
      events.push(...parsed.events);
      seenRows += parsed.count;
      const done = parsed.total != null ? seenRows >= parsed.total : parsed.count < pageSize;
      if (done || parsed.count === 0) { truncated = false; break; }
    }
    return { events, truncated, slotKey };
  }

  async function tick(myGen) {
    let slots;
    try { slots = slotsProvider?.() || []; } catch { slots = []; }
    if (!Array.isArray(slots) || slots.length === 0) return;

    let token = null;
    try { token = await getSessionToken?.(); } catch { token = null; }
    if (myGen !== gen) return;
    if (typeof token !== 'string' || !token) {
      if (!noCredReported) {
        noCredReported = true;
        onError({ status: 'no-credential', message: 'no Cursor session available for usage sync', httpStatus: null });
      }
      schedule(intervalMs);
      return;
    }
    noCredReported = false;

    const t = now();
    try {
      const { events, truncated, slotKey } = await fetchWindow(token, slots, t);
      if (myGen !== gen) return;
      failures = 0;
      cursor = { slotKey, end: t };
      const { assigned, unattributed } = attribute(events, slots, { now: t, ...(modelsMatch ? { modelsMatch } : {}) });
      const live = new Set(slots.map((s) => s.slotId));
      for (const id of totals.keys()) if (!live.has(id)) totals.delete(id);
      totals = foldIntoTotals(totals, assigned);
      onTotals(totals, { fetchedAt: t, events: events.length, unattributed: unattributed.length, truncated });
      schedule(intervalMs);
    } catch (e) {
      if (myGen !== gen) return;
      failures++;
      const status = e instanceof PollError ? e.status : 'network';
      const message = redact(e instanceof PollError ? e.message : 'usage sync failed', token);
      onError({ status, message, httpStatus: e?.httpStatus ?? null });
      schedule(Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS));
    }
  }

  return {
    start() {
      if (timer || (inflight && inflightGen === gen)) return;
      schedule(0);
    },
    stop() {
      gen++;
      if (timer) { clearTimeoutImpl(timer); timer = null; }
    },
    // Resolves when the poll in flight (if any) has finished. For tests and
    // for a caller that wants fresh totals before reading them.
    settled() {
      return inflight ? inflight.then(() => {}, () => {}) : Promise.resolve();
    },
    get totals() { return totals; },
  };
}
