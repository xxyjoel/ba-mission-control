// tests/claudeSessions.test.mjs — the session list must come from claude, and
// an unreadable list must never look like "no background sessions".
//
// The fixture is a real `claude agents --json` capture from 2026-09-19, with
// paths and names replaced. It held nine sessions: three attached to Mission
// Control and six running in claude's background daemon that the fleet view
// could not see at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseAgentsJson, backgroundSessionCount, findSession, listClaudeSessions, _resetSessionCache,
} from '../server/claudeSessions.mjs';

const RAW = readFileSync(fileURLToPath(new URL('./fixtures/claude-agents.json', import.meta.url)), 'utf8');

test('splits the real list into attached and background sessions', () => {
  const list = parseAgentsJson(RAW);
  assert.ok(list, 'the real output parses');
  assert.equal(list.attached.length + list.background.length, 9, 'every row is accounted for');
  assert.ok(list.background.length > 0, 'background sessions are found — these are the invisible ones');
  for (const e of list.background) {
    assert.match(e.sessionId, /^[0-9a-f-]{36}$/, 'each carries a full session id');
  }
});

test('a background session is found by id, and reports that it is background', () => {
  const list = parseAgentsJson(RAW);
  const bg = list.background[0];
  const hit = findSession(list, bg.sessionId);
  assert.equal(hit.kind, 'background');
  // This is the crm-helper case: a slot tried to resume a session claude
  // already held in the background, retried three times, and errored itself.
  // With this lookup the slot can say so instead of burning its restarts.
});

test('an unknown id is simply not found', () => {
  assert.equal(findSession(parseAgentsJson(RAW), 'ffffffff-0000-0000-0000-000000000000'), null);
  assert.equal(findSession(null, 'anything'), null, 'no list means no answer, not a false negative');
});

test('an unreadable list is UNKNOWN, never an empty list', () => {
  assert.equal(parseAgentsJson('not json'), null);
  assert.equal(parseAgentsJson('{"sessions":[]}'), null, 'a wrong shape is unknown too');
  assert.equal(backgroundSessionCount(null), null, 'unknown count stays unknown');
  assert.equal(backgroundSessionCount(parseAgentsJson(RAW)) > 0, true);
});

test('rows without a session id are skipped rather than half-counted', () => {
  const list = parseAgentsJson(JSON.stringify([
    { kind: 'background', cwd: '/repos/x' },
    { kind: 'background', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  ]));
  assert.equal(list.background.length, 1);
});

test('a failing claude binary reports unknown and does not throw', async () => {
  _resetSessionCache();
  const r = await listClaudeSessions({ claudeBin: '/nonexistent/claude-binary', timeoutMs: 2000 });
  assert.equal(r, null, 'unknown, so the UI shows unknown');
  _resetSessionCache();
});
