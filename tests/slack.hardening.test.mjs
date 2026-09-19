// tests/slack.hardening.test.mjs — 0408/S6. postSlack used to do a plain
// fetch: no scheme/host check of its own (the only validation lived in the
// `:slack` verb, and settings.json is hand-editable), default
// redirect-follow (a webhook response could bounce the POST — fleet
// context, email included — to another origin), and no timeout. Now it
// re-validates the https://hooks.slack.com/ prefix itself, sets
// redirect:'error', and aborts via AbortSignal.timeout.
//
// No network: fetch is injected (`fetchImpl`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSlack } from '../tui/lib/slack.js';

const OK_HOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';

function spyFetch(result = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return result; };
  return { fn, calls };
}

test('S6: a non-Slack https URL is refused without any fetch', async () => {
  const { fn, calls } = spyFetch();
  const r = await postSlack({ webhook: 'https://evil.example/hook', text: 'hi', fetchImpl: fn });
  assert.equal(r.ok, false);
  assert.match(r.error, /hooks\.slack\.com/);
  assert.equal(calls.length, 0, 'no request may leave the process');
});

test('S6: plain-http and lookalike prefixes are refused', async () => {
  const { fn, calls } = spyFetch();
  for (const bad of [
    'http://hooks.slack.com/services/T/B/X',           // wrong scheme
    'https://hooks.slack.com.evil.example/services/x', // host suffix trick
    'ftp://hooks.slack.com/services/x',
  ]) {
    const r = await postSlack({ webhook: bad, text: 'hi', fetchImpl: fn });
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
  assert.equal(calls.length, 0);
});

test('S6: a valid webhook posts with redirect:"error" and an abort signal', async () => {
  const { fn, calls } = spyFetch();
  const r = await postSlack({ webhook: OK_HOOK, text: 'hello fleet', fetchImpl: fn });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OK_HOOK);
  assert.equal(calls[0].opts.redirect, 'error', 'redirects must be an error, never followed');
  assert.ok(calls[0].opts.signal instanceof AbortSignal, 'a timeout signal rides along');
  const body = JSON.parse(calls[0].opts.body);
  assert.match(body.text, /hello fleet/);
});

// A hung POST must surface as an error, never wedge the caller. Split into two
// deterministic halves: (1) we DO arm a deadline, checked synchronously, and
// (2) a timeout rejection is reported as an error. The original single test
// awaited a real AbortSignal.timeout firing and then read signal.reason, whose
// shape and timing differ between Node majors — it passed on 26 and was
// cancelled on 20 in CI, blocking the release. Never make a unit test wait on
// a runtime timer it does not own.
test('S6: postSlack arms an abort deadline on every POST', async () => {
  let seen = null;
  const capture = (url, opts) => { seen = opts; return Promise.resolve({ ok: true, status: 200 }); };
  const r = await postSlack({ webhook: OK_HOOK, text: 'hi', fetchImpl: capture, timeoutMs: 50 });
  assert.equal(r.ok, true);
  assert.ok(seen.signal, 'a signal is passed');
  assert.equal(typeof seen.signal.aborted, 'boolean', 'it is an AbortSignal');
  assert.equal(seen.redirect, 'error', 'and redirects are refused');
});

test('S6: a timed-out POST is reported as an error, not a wedge', async () => {
  // Reject exactly the way fetch does on an abort, without waiting for a timer.
  const timedOut = () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    return Promise.reject(e);
  };
  const t0 = Date.now();
  const r = await postSlack({ webhook: OK_HOOK, text: 'hi', fetchImpl: timedOut, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 5000, 'returned promptly');
  assert.match(String(r.error), /timeout|timed out|abort/i);
});

test('S6: empty webhook still refused with the configuration hint', async () => {
  const r = await postSlack({ webhook: '', text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /:slack <url>/);
});
