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
//
// 0436: every spawned test file also gets its OWN throwaway HOME, MC_CONFIG_DIR,
// XDG_STATE_HOME and XDG_CONFIG_HOME, deleted when the file exits. Before this a
// plain `npm test` wrote sessions.json / mc.lock into the real
// ~/.config/claude-mc, thousands of T-mc-* folders into ~/.claude/projects (paths
// built from homedir(), which MC_CONFIG_DIR does not redirect) and heap logs into
// ~/.local/state. MC_REAL_HOME carries the real home so
// tests/runner.hermetic.test.mjs can prove nothing points back at it.
// MC_TEST_KEEP=1 keeps the temp dirs for inspection. TMPDIR is left alone.
//
// Usage:
//   node scripts/run-tests.mjs                     every tests/**/*.test.*
//   node scripts/run-tests.mjs tests/a.test.mjs …  only the named files
//   node scripts/run-tests.mjs --watch [files…]    one node --test --watch run

import { readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

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

// 0436: a temp base holding HOME and every state root a test could write to.
// os.userInfo() reads the passwd entry, not $HOME, so MC_REAL_HOME is right even
// when the runner itself was started under a fake HOME.
const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return process.env.HOME || ''; } })();
function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'mc-test-'));
  const env = {
    ...process.env,
    MC_NO_TRANSCRIPT: '1',
    HOME: base,
    MC_CONFIG_DIR: join(base, 'config'),
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CONFIG_HOME: join(base, 'xdg-config'),
    MC_REAL_HOME: REAL_HOME,
    // No test may start the real claude. A file that reaches a spawn by
    // accident (agent.costCap via Agent.send → start) gets a binary that exits
    // at once, instead of a real claude that outlives the file and writes into
    // the deleted sandbox.
    CLAUDE_BIN: '/usr/bin/false',
  };
  mkdirSync(env.MC_CONFIG_DIR, { recursive: true });
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  return { base, env };
}
function dropSandbox(base) {
  if (process.env.MC_TEST_KEEP === '1') { console.log(`run-tests: kept ${base}`); return; }
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const named = argv.filter((a) => !a.startsWith('--'));

const skipRealTerminal = !named.length && !!process.env.CI && process.env.MC_RUN_PTY !== '1';
const skipCharacterize = !named.length && !!process.env.CI && process.env.MC_RUN_CHARACTERIZE !== '1';
let files = named.length ? named : walk('tests').sort();
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

// 0436: watch mode — one sandbox for the whole run, one node --test --watch over
// the file list (node still isolates each file in its own process). The sandbox
// is removed when the watcher exits or the user hits Ctrl+C.
if (watch) {
  const { base, env } = makeSandbox();
  const child = spawn(
    'node',
    // No --test-force-exit: node rejects it together with --watch (the old
    // find|xargs test:watch script passed both and exited 9 at once).
    ['--import', 'tsx', '--test', '--test-timeout=30000', '--watch', ...files],
    { stdio: 'inherit', env },
  );
  const stop = (sig) => { try { child.kill(sig); } catch {} };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
  child.on('exit', (code, signal) => {
    dropSandbox(base);
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  runEach();
}

// One sandboxed `node --test` process per file, sequential.
function runEach() {
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
    const { base, env } = makeSandbox();
    let r;
    try {
      r = spawnSync(
        'node',
        ['--import', 'tsx', '--test', '--test-timeout=30000', '--test-force-exit', f],
        {
          stdio: 'inherit',
          env,
          timeout: FILE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
    } finally {
      dropSandbox(base);
    }
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
}
