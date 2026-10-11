// tests/App.idleRedraw.test.jsx — 0464: an idle fleet must not redraw or
// rewrite sessions.json.
//
// Before 0464 every slow-clock tick (3 s at idle) called setNow, setSnapshot
// and setAggSpark with NEW objects, so React re-rendered App and Ink rewrote
// the whole screen (948 B/s measured with nothing running), and the header
// clock's seconds digit changed every frame. Every re-render also re-ran the
// session-store sync, which in save mode rewrote sessions.json each time.
//
// The fake fleet below returns a DEEP-fresh snapshot on every call (like the
// real Agent.toJSON) with a new `now`, so a reference compare cannot pass by
// accident — only a structural one can.
//
// Scope of the sessions.json check (review of 0464, finding 4): in this window
// neither the snapshot nor `now` changes, so the store sync never runs at all.
// It proves App stops re-syncing at idle; it does NOT prove the store skips a
// write when it does sync. That (sessionStore recordChanged) is pinned by
// tests/sessionStore.persistOnChange.test.mjs.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import App, { snapshotSig } from '../tui/App.jsx';
import { getConfigDir } from '../tui/lib/configDir.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class IdleFleet extends EventEmitter {
  constructor() {
    super();
    this._snap = { sessionStart: Date.now() - 5 * 60_000, slots: 10, background: null, agents: [] };
    for (let i = 1; i <= 10; i++) {
      this._snap.agents.push(i === 1 ? {
        id: 's1-fake', slot: 1, status: 'idle', name: 'repo-1', provider: 'claude',
        model: 'claude-sonnet-4-6', branch: 'main', cwd: '/tmp',
        context: 1000, tokensIn: 100, tokensOut: 50, costSession: 0.01,
        spark: [0.5, 0.5, 0.5], activity: '', tail: [{ kind: 'text', text: 'done' }],
        permissionMode: 'default', sessionId: '00000001-0000-4000-8000-000000000000',
        stuckMin: 0, lastTokRate: 0, otherSessions: 0,
      } : { id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
    }
  }
  snapshot() { return { ...structuredClone(this._snap), now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find((a) => a.id === id) || null; }
  setViewport() { return 0; }
  setCostCap() {}
  setSlots(n) { return n; }
  killAll() {}
}

const storeStamp = () => {
  try { const s = statSync(join(getConfigDir(), 'sessions.json')); return `${s.ino}:${s.mtimeMs}`; }
  catch { return null; }
};

test('0464: idle ticks with an unchanged fleet cause zero App re-renders and zero session-store writes', async () => {
  const fleet = new IdleFleet();
  // ink-testing-library renders in Ink's debug mode, which writes one frame per
  // React commit (identical output included), so frames.length counts commits.
  // (React.Profiler is inert here: the tests run under NODE_ENV=production.)
  const { frames, unmount } = render(
    <App fleet={fleet} auth={{ ok: true, plan: 'mock', account: 'test', source: 'env' }} />,
  );
  // Settle past boot effects, the 2 s-throttled first session sync and the
  // boot "auth · ok" toast (4 s default) — its expiry is a real change.
  await wait(5000);
  assert.ok(frames.length > 0, 'no frame was ever written — the commit count below would be vacuous');

  const startCommits = frames.length;
  const startStore = storeStamp();
  assert.ok(startStore, 'the boot sync should have written sessions.json for the live slot');
  const startMin = Math.floor(Date.now() / 60_000);
  // Covers at least two idle ticks (first at ~0.7 s, then every 3 s).
  await wait(7000);
  const endMin = Math.floor(Date.now() / 60_000);

  // A minute boundary inside the window legitimately repaints the
  // minute-resolution clock once.
  const allowed = endMin - startMin;
  const renders = frames.length - startCommits;
  assert.ok(renders <= allowed,
    `${renders} App commits during an idle window with an unchanged fleet (allowed ${allowed})`);
  assert.equal(storeStamp(), startStore, 'sessions.json was rewritten while nothing changed');
  unmount();
});

test('0464 snapshotSig: ignores `now` and sub-display ps jitter, catches real and in-place changes', () => {
  const agent = { slot: 1, status: 'idle', procCpu: 2.2, procMemKb: 204_800, tail: [{ text: 'a' }] };
  const snap = { sessionStart: 1, now: 100, agents: [agent] };
  const sig = snapshotSig(snap);
  assert.equal(snapshotSig({ ...snap, now: 999 }), sig, 'now is not drawn');
  assert.equal(snapshotSig({ ...snap, agents: [{ ...agent, procCpu: 2.4, procMemKb: 204_900 }] }), sig,
    'ps jitter below the card resolution (whole %, MiB) is not a change');
  assert.notEqual(snapshotSig({ ...snap, agents: [{ ...agent, procCpu: 3.1 }] }), sig);
  assert.notEqual(snapshotSig({ ...snap, agents: [{ ...agent, status: 'working' }] }), sig);
  // A field shared by reference and mutated in place still reads as a change:
  // the previous signature is a string taken before the mutation.
  agent.tail.push({ text: 'b' });
  assert.notEqual(snapshotSig(snap), sig);
});
