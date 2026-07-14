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

const skipRealTerminal = !!process.env.CI && process.env.MC_RUN_PTY !== '1';
let files = walk('tests').sort();
if (skipRealTerminal) {
  const dropped = files.filter(needsRealTerminal);
  files = files.filter((f) => !needsRealTerminal(f));
  console.log(
    `run-tests: CI detected — excluded ${dropped.length} real-terminal test file(s) ` +
    `(need a TTY/PTY the headless runner lacks; tracked by task 0193). ` +
    `Set MC_RUN_PTY=1 to include them.`,
  );
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(
    'node',
    ['--import', 'tsx', '--test', '--test-timeout=30000', '--test-force-exit', f],
    { stdio: 'inherit', env: { ...process.env, MC_NO_TRANSCRIPT: '1' } },
  );
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`run-tests: ${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`run-tests: all ${files.length} test file(s) passed`);
