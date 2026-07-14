// tests/lib/recipe-pty.js — full-PTY backend for the recipe runner.
//
// Spawns a real subprocess inside a pseudo-terminal (via node-pty), feeds
// its stdout into a headless xterm.js Terminal so escape sequences are
// processed the way a real terminal would process them, and exposes the
// rendered text grid to assertion steps.
//
// This is the slow-but-honest counterpart to tests/lib/recipe.js — same
// step DSL, different backend. Use the in-process runner for "does this
// Ink component behave," and use this runner for "does this thing work
// when wrapped by a real terminal" (catches escape-encoding bugs the
// in-process runner can't see — e.g. Option+Return split-read on macOS).
//
// Step shapes share `type` / `press` / `tick` / `expectFrame` /
// `expectNotFrame` / `label` with the in-process runner. `expectCallback`
// does not apply here because callbacks are an in-process concept.
//
// Recipe inputs:
//
//   command   — absolute path or PATH-resolved name of the binary to run.
//   args      — argv for the spawned process.
//   env       — environment object (defaults to process.env).
//   cwd       — working directory for the spawn.
//   cols/rows — pseudo-terminal dimensions (defaults 100×30).
//   bootDelayMs — ms to wait after spawn before the first step runs
//                 (gives the TUI time to draw its first frame).
//   steps     — the recipe step list.
//
// On failure the runner throws an Error containing the step index, the
// step label (if any), the assertion that broke, and the rendered frame
// at the moment of failure — same shape as the in-process runner's
// errors, so test output is consistent across backends.

import { spawn } from 'node-pty';
import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg.default || xtermPkg;

const DEFAULT_TICK_MS = 50;
const DEFAULT_BOOT_MS = 200;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
// Ceiling for how long a frame assertion polls before giving up. Generous on
// purpose: a cold CI runner JIT-compiling the JSX (tsx) can take seconds to
// paint its first frame. A match returns the instant it appears, so fast/local
// runs pay nothing — only a genuine failure waits out the full budget.
const DEFAULT_EXPECT_TIMEOUT_MS = 8000;
const FRAME_POLL_MS = 25;

const wait = (ms = DEFAULT_TICK_MS) => new Promise((r) => setTimeout(r, ms));

// xterm's write() is async — data is queued and processed on the
// microtask queue. Pass an empty write with a callback to await drain.
function flush(terminal) {
  return new Promise((resolve) => terminal.write('', () => resolve()));
}

// Snapshot the visible terminal buffer into a plain string. Each row is
// translated to its rendered text (no color/style — assertions are
// regex-based and only care about characters), then joined by newline.
// Trailing blank rows are trimmed so frames are stable across recipes
// that target a smaller portion of the viewport.
function readFrame(terminal) {
  const buf = terminal.buffer.active;
  const lines = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buf.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }
  // Trim trailing empty lines.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// Poll the rendered frame until every pattern matches, the process dies, or the
// timeout elapses. Replaces fixed-delay frame checks, which were brittle on
// loaded / cold CI runners where the first paint can lag seconds behind a local
// run. Returns { ok, frame, missing }: on success the matching frame; otherwise
// the last frame seen plus the first pattern still missing (for the error text).
async function waitForFrame(terminal, patterns, timeoutMs, isExited) {
  const start = Date.now();
  for (;;) {
    await flush(terminal);
    const frame = readFrame(terminal);
    const missing = patterns.find((p) => !frame.match(p));
    if (!missing) return { ok: true, frame };
    // Read first (above), THEN bail: a dead process won't paint anything new, so
    // once we've checked its final frame there's no point waiting out the budget.
    if (isExited() || Date.now() - start >= timeoutMs) return { ok: false, frame, missing };
    await wait(FRAME_POLL_MS);
  }
}

export async function runRecipePty({
  command,
  args = [],
  env = process.env,
  cwd = process.cwd(),
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  bootDelayMs = DEFAULT_BOOT_MS,
  expectTimeoutMs = DEFAULT_EXPECT_TIMEOUT_MS,
  steps,
}) {
  if (!command) throw new Error('runRecipePty: `command` is required');
  if (!Array.isArray(steps)) throw new Error('runRecipePty: `steps` must be an array');

  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const proc = spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  let exited = false;
  let exitInfo = null;
  proc.onData((data) => { terminal.write(data); });
  proc.onExit((info) => { exited = true; exitInfo = info; });

  let stepIdx = 0;
  const teardown = async () => {
    try { if (!exited) proc.kill(); } catch {}
    try { terminal.dispose(); } catch {}
  };

  const fail = async (msg) => {
    await flush(terminal);
    const frame = readFrame(terminal);
    const step = steps[stepIdx];
    const label = step?.label ? ` [${step.label}]` : '';
    await teardown();
    throw new Error(
      `pty recipe failed at step ${stepIdx}${label}: ${msg}\n--- LAST FRAME ---\n${frame}\n--- END FRAME ---`,
    );
  };

  try {
    // Let the TUI render its first frame before any assertion runs.
    await wait(bootDelayMs);

    for (; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];

      if (step.tick != null) await wait(step.tick);

      if (step.type != null) {
        for (const ch of String(step.type)) {
          if (exited) await fail(`process exited (code=${exitInfo?.exitCode}) before all input was sent`);
          proc.write(ch);
          await wait();
        }
      }

      if (step.press != null) {
        if (exited) await fail(`process exited (code=${exitInfo?.exitCode}) before press could be sent`);
        proc.write(String(step.press));
        await wait();
      }

      if (step.expectFrame) {
        // Poll instead of checking once after a fixed wait — the frame may not
        // be painted yet on a slow runner. Per-step `timeout` overrides the
        // recipe/global default.
        const timeoutMs = step.timeout ?? expectTimeoutMs;
        const res = await waitForFrame(terminal, step.expectFrame, timeoutMs, () => exited);
        if (!res.ok) await fail(`expected frame to match ${res.missing} but it did not`);
      }

      if (step.expectNotFrame) {
        await flush(terminal);
        const frame = readFrame(terminal);
        for (const pattern of step.expectNotFrame) {
          if (frame.match(pattern)) await fail(`expected frame NOT to match ${pattern} but it did`);
        }
      }

      if (step.expectExit) {
        // Wait for the process to exit (with a timeout so a hung TUI
        // fails the recipe instead of hanging the test runner).
        const timeoutMs = typeof step.expectExit === 'number' ? step.expectExit : 4000;
        const start = Date.now();
        while (!exited && Date.now() - start < timeoutMs) await wait(20);
        if (!exited) await fail(`expected process to exit within ${timeoutMs}ms`);
      }
    }
  } catch (e) {
    await teardown();
    throw e;
  }

  await teardown();
  return { exitCode: exitInfo?.exitCode };
}
