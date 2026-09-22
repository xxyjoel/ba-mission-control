// tests/cursorPtySignals.test.mjs — Cursor PTY scrape detectors vs real
// screen fixtures (spike 2026-09-22). Pure functions over row arrays.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectTrustPrompt,
  detectReady,
  detectWorking,
  detectApproval,
} from '../server/providers/cursor/ptySignals.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor');

function rows(name) {
  return readFileSync(join(FIX, name), 'utf8').split(/\r?\n/);
}

test('detectTrustPrompt: trust-first-run fixture', () => {
  assert.equal(detectTrustPrompt(rows('trust-first-run.trust-prompt.screen.txt')), true);
});

test('detectTrustPrompt: ready / working / approval screens are false', () => {
  assert.equal(detectTrustPrompt(rows('session.ready.screen.txt')), false);
  assert.equal(detectTrustPrompt(rows('session.t1-working-composing.screen.txt')), false);
  assert.equal(detectTrustPrompt(rows('session.t3-approval-shell.screen.txt')), false);
});

test('detectReady: session.ready shows Plan, search, build anything', () => {
  assert.equal(detectReady(rows('session.ready.screen.txt')), true);
});

test('detectReady: trust prompt alone is not ready', () => {
  assert.equal(detectReady(rows('trust-first-run.trust-prompt.screen.txt')), false);
});

test('detectWorking: composing + editing fixtures (ctrl+c to stop)', () => {
  assert.equal(detectWorking(rows('session.t1-working-composing.screen.txt')), true);
  assert.equal(detectWorking(rows('session.t2-working-editing.screen.txt')), true);
});

test('detectWorking: ready / idle / trust are false', () => {
  assert.equal(detectWorking(rows('session.ready.screen.txt')), false);
  assert.equal(detectWorking(rows('session.t1-idle-after.screen.txt')), false);
  assert.equal(detectWorking(rows('trust-first-run.trust-prompt.screen.txt')), false);
});

test('detectApproval: shell approval fixture', () => {
  assert.equal(detectApproval(rows('session.t3-approval-shell.screen.txt')), true);
});

test('detectApproval: subagent approval fixture', () => {
  assert.equal(detectApproval(rows('session.t4-subagent-approval.screen.txt')), true);
});

test('detectApproval: ready / working are false', () => {
  assert.equal(detectApproval(rows('session.ready.screen.txt')), false);
  assert.equal(detectApproval(rows('session.t1-working-composing.screen.txt')), false);
});

test('detectors are safe on empty / non-array', () => {
  for (const fn of [detectTrustPrompt, detectReady, detectWorking, detectApproval]) {
    assert.equal(fn([]), false);
    assert.equal(fn(null), false);
    assert.equal(fn(undefined), false);
  }
});
