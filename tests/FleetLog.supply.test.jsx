// tests/FleetLog.supply.test.jsx — the fleet log must be ABLE to fill the
// configured line count. Supply, not budget.
//
// Defect (2026-09-18, reported repeatedly as "total output lines in the fleet
// log is still wrong"): with `fleetLogLines: 32`, `fleetLogMode: 'narrative'`
// and 6 live sessions the log drew 19 rows and the header read "19 events".
// The 13 reserved-but-unfilled rows were dead space above the status bar.
//
// Cause was a ceiling, not a clamp. Every toJSON() shipped `tail.slice(-16)`
// over a 40-entry ring, and narrative mode keeps only asst/err/bcast rows with
// non-empty text — ~20% of a real tail. 6 × 16 = 96 shipped entries could
// therefore never yield more than ~19 narrative rows. 32 was unreachable by
// construction, at ANY terminal height.
//
// The decisive assertion below (`deriveFleetLog` over real PtyAgent snapshots)
// FAILS before the fix with 19-ish rows and passes after with the full 32.

import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import FleetLog, { deriveFleetLog } from '../tui/FleetLog.jsx';
import { PtyAgent } from '../server/ptyAgent.mjs';
import { parseEvent, pushTail } from '../server/jsonlConnector.mjs';
import {
  TAIL_SHIP, TAIL_MAX, TAIL_CHARS_MAX, TAIL_TEXT_MAX,
  FLEET_LOG_LINES_MAX, settingMax,
} from '../tui/lib/settings.js';

const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', magenta: 'magenta', white: 'white',
};
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

function makeFakeSpawn() {
  const fake = () => ({
    pid: 9100, write() {}, kill() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  });
  return fake;
}

function bootAgent(slot) {
  const a = new PtyAgent({
    slot, id: `s${slot}-supply`, name: `repo-${slot}`, cwd: `/tmp/fake-supply-${slot}`,
    model: 'sonnet-4.6', permissionMode: 'acceptEdits',
    sessionId: `aaaaaaaa-bbbb-cccc-dddd-00000000000${slot}`,
    spawn: makeFakeSpawn(),
  });
  a.start();
  a.lastPtyTs = Date.now() - 30000;
  return a;
}

// One REALISTIC tool-using turn, driven through the real connector so the mix
// of kinds is whatever claude actually produces: thinking, one assistant line,
// two parallel tool calls, two tool results. Exactly one narrative row per
// turn out of six tail entries — the ~20% yield measured live.
function playTurn(agent, n) {
  parseEvent({ type: 'user', message: { role: 'user', content: `do step ${n}` } }, agent);
  parseEvent({
    type: 'assistant',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content: [
        { type: 'thinking', thinking: `considering step ${n} and the files it touches` },
        { type: 'text', text: `narrative-${String(n).padStart(3, '0')} — reading the two files now` },
        { type: 'tool_use', id: `toolu_${n}_a`, name: 'Read', input: { file_path: `/x/a${n}.js` } },
        { type: 'tool_use', id: `toolu_${n}_b`, name: 'Grep', input: { pattern: `p${n}` } },
      ],
    },
  }, agent);
  parseEvent({
    type: 'user',
    message: {
      role: 'user', content: [
        { type: 'tool_result', tool_use_id: `toolu_${n}_a`, content: 'file a contents' },
        { type: 'tool_result', tool_use_id: `toolu_${n}_b`, content: 'no matches' },
      ],
    },
  }, agent);
}

// ── THE decisive test ────────────────────────────────────────────────────────

test('supply: 6 agents in narrative mode can fill a 32-line fleet log', () => {
  const FLEET = 6;
  const LINES = 32;
  const agents = [];
  try {
    for (let s = 1; s <= FLEET; s++) {
      const a = bootAgent(s);
      agents.push(a);
      // 40 turns each — far more history than the log asks for, so anything
      // short of 32 rows is a SUPPLY ceiling and nothing else.
      for (let n = 1; n <= 40; n++) playTurn(a, n);
    }
    const snaps = agents.map((a) => a.toJSON());

    // Sanity: the transcript really did produce plenty of narrative events.
    const narrativePerAgent = snaps[0].tail.filter(
      (l) => l.kind === 'asst' && (l.preview || l.text || '').trim(),
    ).length;
    assert.ok(
      narrativePerAgent >= LINES / 2,
      `each agent must ship enough narrative rows to matter (shipped ${narrativePerAgent})`,
    );

    // Exactly what App.jsx does with the snapshot list.
    const derived = deriveFleetLog(snaps, Math.max(FLEET_LOG_LINES_MAX, LINES), 'narrative');
    assert.ok(
      derived.length >= LINES,
      `a ${LINES}-line narrative log over ${FLEET} sessions must be FILLABLE — ` +
      `derivation supplied only ${derived.length}. Before the fix this was ~19: ` +
      `toJSON shipped tail.slice(-16) over a 40-entry ring.`,
    );
    for (const r of derived) {
      assert.equal(r.kind, 'asst', 'narrative mode keeps only asst/err/bcast');
      assert.match(r.preview || r.text, /narrative-\d\d\d/);
    }

    // …and the pane the user looks at really draws all 32, with no "short" tag.
    const { lastFrame, unmount } = render(
      <FleetLog log={derived} theme={THEME} maxLines={LINES} requestedLines={LINES}
                mode="narrative" width={226} />,
    );
    const frame = strip(lastFrame());
    const drawn = frame.split('\n').filter((l) => /narrative-\d\d\d/.test(l)).length;
    unmount();
    assert.equal(drawn, LINES,
      `the pane must DRAW ${LINES} rows, not reserve them as dead space (drew ${drawn})`);
    assert.match(frame, new RegExp(`· ${LINES} events`));
    assert.doesNotMatch(frame, /history|height/, 'nothing is short — no tag');
  } finally {
    for (const a of agents) { try { a.kill?.(); } catch {} }
  }
});

test('supply: ONE agent alone can fill the largest log the schema allows', () => {
  // The worst case — more sessions only add supply. This is what sizes the
  // ring at FLEET_LOG_LINES_MAX / narrative-yield rather than at the max.
  let a;
  try {
    a = bootAgent(1);
    for (let n = 1; n <= 120; n++) playTurn(a, n);
    const rows = deriveFleetLog([a.toJSON()], FLEET_LOG_LINES_MAX, 'narrative');
    assert.equal(rows.length, FLEET_LOG_LINES_MAX,
      `one session must be able to fill a ${FLEET_LOG_LINES_MAX}-line narrative log — got ${rows.length}`);
  } finally {
    try { a?.kill?.(); } catch {}
  }
});

// ── the budget is derived from the schema, not hardcoded ─────────────────────

test('supply: the shipped slice is sized from SETTINGS_SCHEMA, not a literal', () => {
  assert.equal(FLEET_LOG_LINES_MAX, settingMax('fleetLogLines'),
    'FLEET_LOG_LINES_MAX must come off the schema row');
  assert.equal(FLEET_LOG_LINES_MAX, 40, 'schema max for fleetLogLines (moves freely — the derivation is the pin)');
  assert.ok(TAIL_SHIP >= FLEET_LOG_LINES_MAX * 4,
    `narrative keeps ~20% of a tail, so the ship budget needs ~5x headroom (is ${TAIL_SHIP})`);
  assert.equal(TAIL_MAX, TAIL_SHIP, 'no point holding history nobody can be shipped');
});

test('supply: every agent class ships the same budget (shape-compatible toJSON)', async () => {
  const { Agent } = await import('../server/agent.mjs');
  const src = await import('node:fs').then((fs) =>
    ['server/ptyAgent.mjs', 'server/agent.mjs', 'server/mockAgent.mjs']
      .map((f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')));
  for (const [i, s] of src.entries()) {
    assert.match(s, /tail: this\.tail\.slice\(-TAIL_SHIP\)/,
      `toJSON site ${i} must ship TAIL_SHIP, not a hardcoded count`);
  }
  assert.ok(Agent, 'Agent still loads with the shared tail budget imported');
});

// ── memory: a bigger ring must not mean bigger memory ────────────────────────

test('memory: the tail ring is bounded by characters as well as by count', () => {
  const agent = { tail: [] };
  // 500 max-size entries — 4M chars if nothing bounds them.
  for (let i = 0; i < 500; i++) {
    pushTail(agent, { kind: 'asst', text: 'x'.repeat(TAIL_TEXT_MAX), preview: 'p'.repeat(1000) });
  }
  const chars = agent.tail.reduce((n, e) => n + (e.text?.length || 0) + (e.preview?.length || 0), 0);
  assert.ok(agent.tail.length <= TAIL_MAX, `count cap holds (${agent.tail.length})`);
  assert.ok(chars <= TAIL_CHARS_MAX + TAIL_TEXT_MAX,
    `char cap holds: ${chars} chars vs budget ${TAIL_CHARS_MAX}`);
  assert.ok(agent.tail.length >= 1, 'the newest entry is never evicted');
});

test('memory: appendTail bounds one pathological entry (raw stderr had no cap)', () => {
  let a;
  try {
    a = bootAgent(3);
    a.appendTail({ kind: 'err', text: 'E'.repeat(500000) });
    const last = a.tail[a.tail.length - 1];
    assert.equal(last.text.length, TAIL_TEXT_MAX,
      'an unbounded error string must be truncated on the way into the ring');
  } finally {
    try { a?.kill?.(); } catch {}
  }
});

// ── header: WHICH limit is binding ───────────────────────────────────────────

const LOG = Array.from({ length: 19 }, (_, i) => ({
  ts: 1000 + i, kind: 'asst', text: `entry${String(i).padStart(2, '0')}`,
  agentId: 's1', slot: 1, name: 'repo-1',
}));

test('header: a SHORT-HISTORY log says "history", not a bare event count', () => {
  // The reported symptom: 32 rows budgeted, 32 allowed by the terminal, only
  // 19 events in existence. The header read "19 events" and nothing else.
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={32} requestedLines={32} width={120} />,
  );
  const frame = strip(lastFrame());
  assert.match(frame, /· 19 events/);
  assert.match(frame, /· 19\/32 history/,
    'the binding limit is available history — say so instead of leaving a bare count');
  assert.doesNotMatch(frame, /height/, 'the terminal is NOT the limit here');
  unmount();
});

test('header: a HEIGHT-clamped log still says "height" (0408/R4 pin kept)', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={8} requestedLines={30} width={120} />,
  );
  const frame = strip(lastFrame());
  assert.match(frame, /· 8\/30/, '0408/R4: the short count-pair form');
  assert.match(frame, /· 8\/30 height/, 'and it now names the terminal as the cause');
  assert.doesNotMatch(frame, /history/);
  unmount();
});

test('header: history wins when BOTH limits are short — it is the tighter one', () => {
  // The terminal clamps 30 down to 25, and only 19 events exist. 19 < 25, so
  // history is what the user is actually short of; report that one.
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={25} requestedLines={30} width={120} />,
  );
  const frame = strip(lastFrame());
  assert.match(frame, /· 19\/30 history/, 'fewer events than even the clamped height allows');
  unmount();
});

test('header: stays quiet when the setting IS honoured', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={12} requestedLines={12} width={120} />,
  );
  const frame = strip(lastFrame());
  assert.doesNotMatch(frame, /history/);
  assert.doesNotMatch(frame, /height/);
  unmount();
});

test('header: stays ONE row at 80 cols with every tag on (frame-tear guard)', () => {
  const { lastFrame, unmount } = render(
    <FleetLog log={LOG} theme={THEME} maxLines={4} requestedLines={40} mode="narrative" width={80} />,
  );
  const lines = strip(lastFrame()).split('\n');
  const headIdx = lines.findIndex((l) => l.includes('FLEET LOG'));
  assert.ok(headIdx >= 0, 'header present');
  assert.match(lines[headIdx + 1] || '', /entry\d\d/,
    'the row right after the header must be a log row — the header must not wrap');
  unmount();
});
