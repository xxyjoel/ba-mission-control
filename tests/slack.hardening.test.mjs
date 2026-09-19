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

test('S6: a hung POST times out instead of wedging forever', async () => {
  // A fetch that resolves only when its signal aborts — like a stalled server.
  const hung = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const t0 = Date.now();
  const r = await postSlack({ webhook: OK_HOOK, text: 'hi', fetchImpl: hung, timeoutMs: 60 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 5000, 'returned promptly');
  assert.match(String(r.error), /timeout|timed out|abort/i);
});

test('S6: empty webhook still refused with the configuration hint', async () => {
  const r = await postSlack({ webhook: '', text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /:slack <url>/);
});
