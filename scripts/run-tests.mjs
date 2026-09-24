#!/usr/bin/env node
// scripts/run-tests.mjs — glob + run every tests/**/*.test.* in its own node
// process (one-per-file isolation, same as the old find|xargs one-liner), with
// ONE added job: in headless CI it excludes the REAL-TERMINAL test suites.
//
// Why exclude in CI: two kinds of test need a real TTY/PTY that the GitHub
// ubuntu-latest runner doesn't provide —
//   • tests/recipes/*.recipes.test.* drive a real pseudo-terminal via node-pty;
//     pty.spawn yields NO output on the runner (empty frames, even a trivial echo
//     fixture).
//   • *.realparser.test.* feed raw control bytes to ink's REAL keypress parser,
//     which mis-classifies them in a non-TTY env (e.g. Ctrl+Q → undefined, not EXIT).
// Both pass locally and on every push (the pre-push hook runs `npm test` with CI
// unset), so developer coverage is preserved; only the headless runner skips
// them. Restoring real-terminal coverage in CI is tracked by task 0193.
//
// Escape hatch: set MC_RUN_PTY=1 to force them to run even under CI.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.test\.(mjs|jsx|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// A test that needs a real terminal: a node-pty PTY recipe, or an ink
// raw-keypress-parser test. Both are environment-fragile on a headless runner.
const needsRealTerminal = (f) => {
  const segs = f.split(/[\\/]/);
  return segs.includes('recipes') || /\.realparser\.test\./.test(segs.at(-1));
};

// Characterization pins for the 0420 PtyCore extraction. They mock Date.now
// for the whole test body; on some CI runners (macOS · node 20, 2026-09-24)
// the process then never drains despite --test-force-exit and hits the
// 5-minute per-file wall. Local + other matrix cells pass in <1s — keep them
// on developer `npm test`, skip only under CI.
const isCharacterize = (f) => /\.characterize\.test\./.test(f.split(/[\\/]/).at(-1) || '');

const skipRealTerminal = !!process.env.CI && process.env.MC_RUN_PTY !== '1';
const skipCharacterize = !!process.env.CI && process.env.MC_RUN_CHARACTERIZE !== '1';
let files = walk('tests').sort();
if (skipRealTerminal || skipCharacterize) {
  const dropped = files.filter((f) =>
    (skipRealTerminal && needsRealTerminal(f)) || (skipCharacterize && isCharacterize(f)));
  files = files.filter((f) =>
    !(skipRealTerminal && needsRealTerminal(f)) && !(skipCharacterize && isCharacterize(f)));
  if (dropped.length) {
    console.log(
      `run-tests: CI detected — excluded ${dropped.length} file(s) ` +
      `(real-terminal and/or characterize; set MC_RUN_PTY=1 / MC_RUN_CHARACTERIZE=1 to include).`,
    );
  }
}

let failed = 0;
// Per-FILE wall clock. `--test-timeout` bounds an individual test, not the
// process around it: a file that wedges before any test registers, or one whose
// process never exits after its tests pass, is not covered by it. spawnSync
// with no timeout then waits for that forever, and because this loop is
// sequential the whole suite stops with it.
//
// That is not hypothetical. The v1.1.16 release hung on macOS/node20 at
// 2026-09-20T22:37:13Z, printed nothing for the next six hours, and was killed
// by GitHub's job limit — "Terminate orphan process: pid (87158) (node)". The
// run is charged as cancelled, not failed, so it reads as infrastructure
// trouble rather than a test defect and names no file.
//
// 5 minutes is far above any file here (the whole suite runs in ~3 min) and far
// below the 6-hour job cap. A file that exceeds it is reported by NAME and the
// suite carries on, so one wedged file costs one failure instead of the release.
const FILE_TIMEOUT_MS = 5 * 60 * 1000;
const timedOut = [];

for (const f of files) {
  const r = spawnSync(
    'node',
    ['--import', 'tsx', '--test', '--test-timeout=30000', '--test-force-exit', f],
    {
      stdio: 'inherit',
      env: { ...process.env, MC_NO_TRANSCRIPT: '1' },
      timeout: FILE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  // spawnSync reports a timeout as error.code ETIMEDOUT, and leaves status null
  // because the child was signalled rather than exiting on its own.
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) {
    timedOut.push(f);
    console.error(
      `run-tests: TIMEOUT after ${FILE_TIMEOUT_MS / 1000}s — ${f} ` +
      `(killed with ${r.signal || 'SIGKILL'}; it wedged rather than failing)`,
    );
    failed++;
    continue;
  }
  if (r.status !== 0) failed++;
}

if (timedOut.length) {
  console.error(`run-tests: ${timedOut.length} file(s) timed out: ${timedOut.join(', ')}`);
}

if (failed) {
  console.error(`run-tests: ${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`run-tests: all ${files.length} test file(s) passed`);
