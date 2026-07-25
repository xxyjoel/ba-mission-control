// tests/shell/shellKeys.realparser.test.jsx
//
// THE trustworthy keybind test for the shell overlay: drives REAL byte sequences
// through Ink's REAL keypress parser (ink-testing-library stdin.write = same path
// production uses), then asserts how classifyShellKey() and keyToBytes() react.
//
// This is the realparser variant for 0314 — paired test for 0313 (shellKeys.js).
// The existing tests/shell/shellKeys.test.js uses hand-constructed (input, key)
// objects; this test exercises what Ink actually delivers for real terminal bytes.
//
// Critical concern (flagged in plan): Ctrl+J (0x0a) — zoom chrome intercepted '\n'
// as NEWLINE, so keyToBytes was never exercised on '\n' in production. Here it must
// pass through and produce 0x0a (the LF byte a readline shell expects for accept).
// If Ink sets key.return for '\x0a', keyToBytes returns '\r' (0x0d) instead —
// that is a real acceptance violation to surface, not paper over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { SHELL_KEYS, classifyShellKey } from '../../tui/shell/shellKeys.js';
import { keyToBytes } from '../../tui/zoom/ptyKeys.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// Render a probe that captures the REAL (input, key) from Ink's actual parser.
// We need both: classifyShellKey verdict AND keyToBytes output for the same event.
function probe() {
  const events = [];
  function Probe() {
    useInput((input, key) => { events.push({ input, key }); });
    return React.createElement(Text, null, 'x');
  }
  const { stdin } = render(React.createElement(Probe));
  return { stdin, events };
}

// ────────────────────────────────────────────────────────────────────────────
// Chrome key: Ctrl+Q must classify as EXIT and must NOT be forwarded to PTY
// ────────────────────────────────────────────────────────────────────────────

test('shell chrome: Ctrl+Q (EXIT) fires from real bytes', async () => {
  const { stdin, events } = probe();
  await tick();
  stdin.write('\x11');  // Ctrl+Q
  await tick();
  assert.ok(events.length > 0, 'Ctrl+Q bytes should trigger a useInput event');
  const { input, key } = events[0];
  const verdict = classifyShellKey(input, key);
  assert.equal(verdict, 'EXIT',
    `Ctrl+Q bytes '\\x11' must classify as EXIT, got ${JSON.stringify(verdict)} (input=${JSON.stringify(input)}, key=${JSON.stringify(key)})`);
});

// ────────────────────────────────────────────────────────────────────────────
// Forwarded keys: Ctrl+K, Ctrl+U, Ctrl+J must pass through (classify → null)
// ────────────────────────────────────────────────────────────────────────────

const SHELL_FORWARDED = {
  'Ctrl+K (readline kill-line)':          '\x0b',  // 0x0b — must not be stolen by chrome
  'Ctrl+U (readline kill-line-backward)': '\x15',  // 0x15 — must not be stolen
  'Ctrl+J (readline accept / newline)':   '\x0a',  // 0x0a — was zoom NEWLINE; must NOT be chrome here
};

for (const [label, bytes] of Object.entries(SHELL_FORWARDED)) {
  test(`shell forward: ${label} is NOT intercepted (classifyShellKey → null)`, async () => {
    const { stdin, events } = probe();
    await tick();
    stdin.write(bytes);
    await tick();
    assert.ok(events.length > 0, `${label}: bytes should trigger a useInput event`);
    const { input, key } = events[0];
    const verdict = classifyShellKey(input, key);
    assert.equal(verdict, null,
      `${label}: bytes ${JSON.stringify(bytes)} must NOT be chrome (classifyShellKey → null), got ${JSON.stringify(verdict)} (input=${JSON.stringify(input)}, key=${JSON.stringify(key)})`);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Byte mapping: keyToBytes must produce correct control bytes for K, U, J
// This verifies the PTY receives the right bytes when these keys are forwarded.
// ────────────────────────────────────────────────────────────────────────────

test('keyToBytes: Ctrl+K real bytes → 0x0b (kill-line byte for PTY)', async () => {
  const { stdin, events } = probe();
  await tick();
  stdin.write('\x0b');  // Ctrl+K
  await tick();
  assert.ok(events.length > 0, 'Ctrl+K bytes should trigger a useInput event');
  const { input, key } = events[0];
  const result = keyToBytes(input, key);
  assert.equal(result, '\x0b',
    `Ctrl+K: keyToBytes must produce 0x0b for PTY, got ${JSON.stringify(result)} (input=${JSON.stringify(input)}, key=${JSON.stringify(key)})`);
});

test('keyToBytes: Ctrl+U real bytes → 0x15 (kill-line-backward byte for PTY)', async () => {
  const { stdin, events } = probe();
  await tick();
  stdin.write('\x15');  // Ctrl+U
  await tick();
  assert.ok(events.length > 0, 'Ctrl+U bytes should trigger a useInput event');
  const { input, key } = events[0];
  const result = keyToBytes(input, key);
  assert.equal(result, '\x15',
    `Ctrl+U: keyToBytes must produce 0x15 for PTY, got ${JSON.stringify(result)} (input=${JSON.stringify(input)}, key=${JSON.stringify(key)})`);
});

test('keyToBytes: Ctrl+J real bytes → 0x0a (newline/accept byte for PTY)', async () => {
  // NOTE: This is the discriminating check from the plan (0314).
  // Zoom chrome intercepted '\n' as NEWLINE, so keyToBytes was never exercised
  // on '\n' via real Ink parser bytes in the codebase before.
  // If Ink sets key.return for 0x0a, keyToBytes returns '\r' (0x0d) — which
  // would be a real acceptance violation (shell readline expects LF for accept).
  // This test makes that failure loud rather than silent.
  const { stdin, events } = probe();
  await tick();
  stdin.write('\x0a');  // Ctrl+J / LF
  await tick();
  assert.ok(events.length > 0, 'Ctrl+J bytes should trigger a useInput event');
  const { input, key } = events[0];
  const result = keyToBytes(input, key);
  assert.equal(result, '\n',
    `Ctrl+J: keyToBytes must produce 0x0a (\\n) for PTY, got ${JSON.stringify(result)} (input=${JSON.stringify(input)}, key=${JSON.stringify(key)}). If this is '\\r', Ink set key.return on the 0x0a byte — check ptyKeys.js key.return branch.`);
});

// ────────────────────────────────────────────────────────────────────────────
// Ctrl+Q must NOT be forwarded via keyToBytes (it is chrome, not PTY-bound)
// ────────────────────────────────────────────────────────────────────────────

test('keyToBytes: Ctrl+Q bytes — forwarding to PTY is the caller\'s concern, but verify the byte mapping is sane', async () => {
  // ShellOverlay calls classifyShellKey first; if it returns EXIT, keyToBytes
  // is never called. This test documents what keyToBytes *would* produce so
  // a refactor that calls keyToBytes before classifyShellKey gets caught.
  // 0x11 = Ctrl+Q = XON — keyToBytes should produce '\x11' (not null, not error).
  const { stdin, events } = probe();
  await tick();
  stdin.write('\x11');  // Ctrl+Q
  await tick();
  assert.ok(events.length > 0, 'Ctrl+Q bytes should trigger a useInput event');
  const { input, key } = events[0];
  // We only verify classifyShellKey fires — NOT that keyToBytes forwards it.
  // The overlay must check classifyShellKey BEFORE calling keyToBytes.
  const verdict = classifyShellKey(input, key);
  assert.equal(verdict, 'EXIT',
    `Ctrl+Q must classify as EXIT (chrome guard), not reach keyToBytes: got ${JSON.stringify(verdict)}`);
});
