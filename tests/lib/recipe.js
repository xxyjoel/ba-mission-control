// tests/lib/recipe.js — declarative interaction test runner.
//
// A "recipe" is a JSON-shaped list of steps that drive a rendered Ink
// component through a user-facing scenario and assert on what the frame
// shows (or which callback prop fired) at each step. The goal is to make
// adding a test for "press X, expect Y in the frame" cost ~5 lines
// instead of ~30 lines of `render` / `await tick` / `stdin.write`
// boilerplate — so feature coverage scales with feature count.
//
// Step shapes (all optional; multiple may appear in one step):
//
//   { type: 'string' }
//       Type each character with a tick before/after (~60ms per char).
//       Use for composer input.
//
//   { press: '\x1b[A' }
//       Send a single key sequence (escape codes welcome). Same timing
//       as `type` but treats the value as one key, not a char-stream.
//
//   { tick: ms }
//       Wait `ms` milliseconds (for timer-driven behavior — auto-close,
//       blink, etc.).
//
//   { expectFrame: [/regex/, ...] }
//       lastFrame() must MATCH every pattern.
//
//   { expectNotFrame: [/regex/, ...] }
//       lastFrame() must NOT match any pattern.
//
//   { expectCallback: ['propName', predicateOrCount] }
//       The named callback prop must have been called `predicateOrCount`
//       times (number), or the predicate must return truthy when given
//       the array of recorded call args.
//
//   { label: 'human-readable step name' }
//       Free annotation surfaced in failure messages.
//
// On failure the runner throws an Error containing the failed step's
// label (if any), the assertion that broke, and the current frame —
// so the user can diff the actual UI against expectations.

import React from 'react';
import { render } from 'ink-testing-library';

const TICK_MS = 30;
const tick = (ms = TICK_MS) => new Promise((r) => setTimeout(r, ms));

// Wrap every function-valued prop in a recorder so steps can assert on
// "this callback got called with these args N times." We mutate the
// caller's props object so JSX equality stays stable.
function recordCallbacks(props) {
  const records = {};
  const wrapped = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') {
      records[key] = [];
      wrapped[key] = (...args) => {
        records[key].push(args);
        return value(...args);
      };
    }
  }
  return { wrapped, records };
}

export async function runRecipe({ component: Component, props = {}, steps }) {
  const { wrapped, records } = recordCallbacks(props);
  const { lastFrame, stdin, unmount } = render(React.createElement(Component, wrapped));

  let stepIdx = 0;
  const fail = (msg) => {
    const label = steps[stepIdx]?.label ? ` [${steps[stepIdx].label}]` : '';
    const frame = lastFrame() || '(no frame)';
    unmount();
    throw new Error(
      `recipe failed at step ${stepIdx}${label}: ${msg}\n--- LAST FRAME ---\n${frame}\n--- END FRAME ---`,
    );
  };

  try {
    for (; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];

      if (step.tick != null) {
        await tick(step.tick);
      }

      if (step.type != null) {
        for (const ch of String(step.type)) {
          await tick();
          stdin.write(ch);
          await tick();
        }
      }

      if (step.press != null) {
        await tick();
        stdin.write(String(step.press));
        await tick();
      }

      if (step.expectFrame) {
        const frame = lastFrame() || '';
        for (const pattern of step.expectFrame) {
          if (!frame.match(pattern)) {
            fail(`expected frame to match ${pattern} but it did not`);
          }
        }
      }

      if (step.expectNotFrame) {
        const frame = lastFrame() || '';
        for (const pattern of step.expectNotFrame) {
          if (frame.match(pattern)) {
            fail(`expected frame NOT to match ${pattern} but it did`);
          }
        }
      }

      if (step.expectCallback) {
        const [name, expected] = step.expectCallback;
        const calls = records[name];
        if (!calls) fail(`no callback prop named "${name}" was wrapped (was it passed in props?)`);
        if (typeof expected === 'function') {
          if (!expected(calls)) {
            fail(`callback "${name}" predicate returned false (calls=${JSON.stringify(calls)})`);
          }
        } else if (calls.length !== expected) {
          fail(`callback "${name}" should have fired ${expected} times, got ${calls.length}`);
        }
      }
    }
  } finally {
    unmount();
  }
  return { records };
}
