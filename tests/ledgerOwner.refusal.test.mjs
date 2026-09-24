// tests/ledgerOwner.refusal.test.mjs — Mission Control must recognise claude's
// CURRENT refusal when a session is already open somewhere else.
//
// When it does not, the slot treats the refusal as a crash and auto-restarts
// into the same refusal until its budget runs out. Measured on crm-helper,
// 2026-09-19: three restarts, then "auto-restart exhausted — leaving slot
// errored", while the conversation was alive in claude's background daemon.
//
// The wording below is copied from the claude 2.1.267 binary, not invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEarlyExit } from '../server/ledgerOwner.mjs';

const SOON = 1200;   // the refusal lands seconds after spawn

test('recognises claude 2.1.267: "belongs to another running Claude Code session"', () => {
  const out = 'Session 9ca62749 belongs to another running Claude Code session (locked: 96113)';
  assert.equal(classifyEarlyExit(out, SOON), 'held-by-agent');
});

test('recognises claude 2.1.273: "running as a background session"', () => {
  // Measured 2026-09-24 on labor-market-app after quit + :resume-all — the
  // session was still a daemon job (state: done, pid still held). Prior
  // patterns only said "background agent", so this refused as a crash.
  const out = 'Error: Session b0398ccf-0e92-43fe-88f8-968aa2a58152 is running as a background session (b0398ccf). Run `claude attach b0398ccf` to open it, or `claude stop b0398ccf` first to resume it here.';
  assert.equal(classifyEarlyExit(out, SOON), 'held-by-agent');
});

test('recognises the generic lock wording too', () => {
  assert.equal(classifyEarlyExit('fatal: locked by another process', SOON), 'held-by-agent');
});

test('still recognises the older wordings', () => {
  for (const out of [
    'this session is currently running as a background agent',
    'session is held by a background agent',
    'session in use by another process',
    'session is already active elsewhere',
  ]) {
    assert.equal(classifyEarlyExit(out, SOON), 'held-by-agent', out);
  }
});

test('a genuine crash is NOT mistaken for a lock, so it still restarts', () => {
  assert.equal(classifyEarlyExit('Error: ENOENT spawn failed', SOON), null);
  assert.equal(classifyEarlyExit('', SOON), null);
});

test('replayed conversation text cannot suppress a real restart', () => {
  // --resume replays the whole prior conversation, which may discuss locks.
  // The guard only applies to an exit that lands seconds after spawn.
  const prose = 'earlier we saw it belongs to another running Claude Code session';
  assert.equal(classifyEarlyExit(prose, 60_000), null, 'outside the window, so not a lock');
  assert.equal(classifyEarlyExit(prose, SOON), 'held-by-agent', 'inside the window, treated as a lock');
});
