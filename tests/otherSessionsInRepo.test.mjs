// 0414: a card must be able to say how many OTHER conversations claude holds
// in the same folder. Built from the real listing recorded on 2026-09-19,
// where bluearch/stonks had three live sessions and the card showed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentsJson, otherLiveSessionsInRepo } from '../server/claudeSessions.mjs';

const STONKS = '/Users/joelproctor/source/git/projects/bluearch/stonks';
const MC = '/Users/joelproctor/source/git/projects/bluearch/ba-mission-control';

// Shape copied from `claude agents --json` on 2026-09-19 20:50.
const REAL = JSON.stringify([
  { kind: 'background', id: 'a4060968', sessionId: 'a4060968', cwd: STONKS, state: 'done', startedAt: 1789784919068 },
  { kind: 'background', id: '698fb2df', sessionId: '698fb2df', cwd: STONKS, state: 'working', startedAt: 1789868620740 },
  { kind: 'background', id: 'add052b8', sessionId: 'add052b8', cwd: STONKS, state: 'done', startedAt: 1789868644799 },
  { kind: 'background', id: '9ca62749', sessionId: '9ca62749', cwd: '/repo/crm', state: 'blocked', startedAt: 1789784127097 },
  { kind: 'interactive', sessionId: '9ca62749', cwd: '/repo/crm', status: 'idle', startedAt: 1789868605842 },
  { kind: 'interactive', sessionId: 'aae20e51', cwd: MC, status: 'busy', startedAt: 1789868606400 },
]);

test('counts the other conversations claude holds in the same folder', () => {
  const list = parseAgentsJson(REAL);
  const others = otherLiveSessionsInRepo(list, { cwd: STONKS, sessionId: 'add052b8' });
  assert.deepEqual(others.map((e) => e.sessionId).sort(), ['698fb2df', 'a4060968']);
});

test('a folder with only this slot in it reports none', () => {
  const list = parseAgentsJson(REAL);
  assert.deepEqual(otherLiveSessionsInRepo(list, { cwd: MC, sessionId: 'aae20e51' }), []);
});

test('one session listed twice is counted once', () => {
  // 9ca62749 appears as BOTH background/blocked and interactive/idle in the
  // real listing. A slot on some other id in that folder must see it once.
  const list = parseAgentsJson(REAL);
  const others = otherLiveSessionsInRepo(list, { cwd: '/repo/crm', sessionId: 'zz' });
  assert.equal(others.length, 1);
  assert.equal(others[0].sessionId, '9ca62749');
});

test('state and kind are never used to filter', () => {
  // add052b8 was listed background/`done` while Mission Control had a live
  // terminal on it writing user messages. Dropping `done` rows would have
  // hidden the very session the user was typing into.
  const list = parseAgentsJson(REAL);
  const others = otherLiveSessionsInRepo(list, { cwd: STONKS, sessionId: '698fb2df' });
  assert.ok(others.some((e) => e.sessionId === 'add052b8' && e.state === 'done'));
});

test('an unreadable listing is unknown, not none', () => {
  assert.equal(otherLiveSessionsInRepo(null, { cwd: STONKS, sessionId: 'x' }), null);
});

test('a slot with no folder is unknown, not none', () => {
  const list = parseAgentsJson(REAL);
  assert.equal(otherLiveSessionsInRepo(list, { cwd: null, sessionId: 'x' }), null);
});
