// tests/agent.costCap.test.mjs — verifies Agent's cost-cap guardrail.
//
// We don't spawn a real claude subprocess. The cap check lives at the
// top of send() and short-circuits before any I/O, so we can exercise
// it by mutating costSession + costCapUSD on a constructed agent and
// asserting send() returns false (and appends an err to the tail).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../server/agent.mjs';

function makeAgentBare() {
  return new Agent({
    slot: 1,
    cwd: '/tmp',
    branch: 'main',
    model: 'sonnet-4.6',
    name: 'unit',
    permissionMode: 'acceptEdits',
  });
}

test('agent.send: returns false when costSession exceeds costCapUSD', () => {
  const a = makeAgentBare();
  a.costCapUSD = 5.0;
  a.costSession = 5.5;
  const result = a.send('any message');
  assert.equal(result, false, 'send must refuse past the cap');
  const last = a.tail[a.tail.length - 1];
  assert.equal(last.kind, 'err');
  assert.match(last.text, /cost cap reached/);
  assert.match(last.text, /:cap 1 <usd>/);
});

test('agent.send: cap=0 means disabled even with high costSession', () => {
  const a = makeAgentBare();
  a.costCapUSD = 0;
  a.costSession = 50;
  // We still expect false because there's no live process — but the
  // refusal reason must NOT be the cap. Verify by tail entries: should
  // not contain "cost cap reached".
  a.send('any message');
  const capEntries = a.tail.filter(t => /cost cap reached/.test(t.text || ''));
  assert.equal(capEntries.length, 0, 'no cap message when cap is disabled');
});

test('agent.toJSON.capReached: true exactly when over cap with cap>0', () => {
  const a = makeAgentBare();
  a.costCapUSD = 5.0;

  a.costSession = 4.5;
  assert.equal(a.toJSON().capReached, false);

  a.costSession = 5.0;
  assert.equal(a.toJSON().capReached, true, 'reaching the cap counts as capped');

  a.costSession = 10.0;
  assert.equal(a.toJSON().capReached, true);
});

test('agent.toJSON: includes costCapUSD field', () => {
  const a = makeAgentBare();
  a.costCapUSD = 12.5;
  assert.equal(a.toJSON().costCapUSD, 12.5);
});
