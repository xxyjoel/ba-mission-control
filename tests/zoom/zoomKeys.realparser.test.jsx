// tests/zoom/zoomKeys.realparser.test.jsx
//
// THE trustworthy keybind test: it drives the REAL byte sequences through
// Ink's REAL keypress parser (ink-testing-library's stdin.write feeds the same
// path production uses), then asserts how classifyZoomKey() reacts. This is
// what our old synthetic-`{ctrl:true,input:']'}` tests could not do — and it is
// exactly what catches "the handler checks a shape Ink can never emit" (the
// Ctrl+] / Ctrl+\ dead-zone bug).
//
// If someone re-binds a chrome action to a 0x1c-0x1f key (or any shape Ink
// doesn't produce), the matching case below goes RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { ZOOM_KEYS, classifyZoomKey } from '../../tui/zoom/zoomKeys.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// Render a probe that runs the REAL useInput and records classifyZoomKey's
// verdict for whatever bytes we write to stdin.
function probe() {
  const got = [];
  function Probe() {
    useInput((input, key) => { got.push(classifyZoomKey(input, key)); });
    return React.createElement(Text, null, 'x');
  }
  const { stdin } = render(React.createElement(Probe));
  return { stdin, got };
}

// Every chrome key must classify to its action when its real bytes arrive.
for (const [action, def] of Object.entries(ZOOM_KEYS)) {
  test(`zoom chrome: ${def.name} (${action}) fires from real bytes`, async () => {
    const { stdin, got } = probe();
    await tick();
    stdin.write(def.bytes);
    await tick();
    assert.equal(got[0], action,
      `${def.name}: bytes ${JSON.stringify(def.bytes)} should classify as ${action}, got ${got[0]}`);
  });
}

// Forwarded keys must NOT be intercepted (classify → null) — i.e. they reach
// claude. These guard against over-stealing.
const FORWARDED = {
  'Enter (submit)':       '\r',
  'Esc (claude cancel)':  '\x1b',
  'Ctrl+C (interrupt)':   '\x03',
  'Ctrl+T (claude todos)':'\x14',
  'Ctrl+S (claude stash)':'\x13',
  'plain letter a':       'a',
  'Tab':                  '\t',
};
for (const [label, bytes] of Object.entries(FORWARDED)) {
  test(`zoom forward: ${label} is NOT intercepted (reaches claude)`, async () => {
    const { stdin, got } = probe();
    await tick();
    stdin.write(bytes);
    await tick();
    assert.equal(got[0], null,
      `${label}: bytes ${JSON.stringify(bytes)} must forward to claude, but classified as ${got[0]}`);
  });
}
