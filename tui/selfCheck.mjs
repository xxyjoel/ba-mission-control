// tui/selfCheck.mjs — headless boot self-check for `MC_SMOKE=1 mc`.
//
// This is the ground-truth assertion that a PUBLISHED tarball actually works on
// a fresh machine, run by scripts/verify-pack.mjs after installing the packed
// tarball into a clean temp dir. It must be HEADLESS-SAFE — no TTY, no Ink
// render (App.jsx's useInput needs raw mode, which a CI runner lacks; that is
// exactly why the recipe/*.recipes tests are CI-excluded). Instead it proves the
// three things that break a fresh `npx @bluearch/mission-control`:
//
//   1. The whole tui/ + server/ import graph RESOLVES from the packed files —
//      importing App.jsx transitively pulls every card/modal/lib module, so a
//      file missing from package.json `files:` surfaces here as MODULE_NOT_FOUND
//      (ground truth for manifest completeness; a static check can't see dynamic
//      requires, this does).
//   2. node-pty's spawn-helper actually spawns — the historically recurring
//      `posix_spawnp failed` (the entire reason fix-node-pty.mjs exists). We run
//      a real pty.spawn('echo', ['hi']) and read 'hi' back.
//   3. fixNodePty()'s runtime self-heal works when postinstall was skipped (npx).
//
// Success contract: prints `MC_SMOKE_OK <version>` to stdout and exits 0.
// Any failure prints `MC_SMOKE_FAIL <reason>` to stderr and exits 1.
//
// Env seams (used by the verify-pack negative control):
//   MC_SMOKE_NO_HEAL=1 — skip fixNodePty(). With a broken spawn-helper exec bit
//     this MUST make the pty step fail; the harness asserts that red, proving the
//     verifier isn't hollow.

import { fixNodePty } from '../scripts/fix-node-pty.mjs';
import { versionLine } from './lib/version.js';

function fail(reason) {
  process.stderr.write(`MC_SMOKE_FAIL ${reason}\n`);
  process.exit(1);
}

// A real PTY round-trip: spawn `echo hi`, resolve with the captured output.
// Rejects on the spawn-helper exec-bit failure (posix_spawnp) or a timeout.
function ptyRoundTrip() {
  return new Promise(async (resolve, reject) => {
    let pty;
    try {
      pty = await import('node-pty');
    } catch (e) {
      return reject(new Error(`node-pty import: ${e.message}`));
    }
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('pty timeout (no exit within 8s)'));
    }, 8000);
    try {
      const child = pty.spawn('echo', ['hi'], { name: 'xterm-color', cols: 80, rows: 24 });
      child.onData((d) => { out += d; });
      child.onExit(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(out);
      });
    } catch (e) {
      done = true;
      clearTimeout(timer);
      // posix_spawnp failed lands here — the exact fresh-install crash.
      reject(new Error(`pty.spawn: ${e.message}`));
    }
  });
}

export async function selfCheck() {
  // 1. Self-heal the spawn-helper exec bit unless the negative control disabled it.
  if (process.env.MC_SMOKE_NO_HEAL !== '1') {
    try { fixNodePty(); } catch (e) { fail(`fixNodePty threw: ${e.message}`); }
  }

  // 2. Force-resolve the entire runtime import graph from the packed files.
  //    Importing App.jsx evaluates every card/modal/lib module it pulls in but
  //    does NOT render (render() is what needs a TTY), so this is headless-safe
  //    while still catching any file missing from the `files:` allowlist.
  try {
    await import('./App.jsx');
  } catch (e) {
    fail(`import graph: ${e.code || ''} ${e.message}`.trim());
  }
  // server/ data layer resolves + constructs.
  try {
    const { Fleet } = await import('../server/fleet.mjs');
    const fleet = new Fleet({ slots: 1 });
    fleet.snapshot();
  } catch (e) {
    fail(`fleet: ${e.message}`);
  }

  // 3. The crown jewel — a real PTY spawn on the freshly-installed tarball.
  try {
    const out = await ptyRoundTrip();
    if (!/hi/.test(out)) fail(`pty ran but no output (got ${JSON.stringify(out)})`);
  } catch (e) {
    fail(e.message);
  }

  process.stdout.write(`MC_SMOKE_OK ${versionLine()}\n`);
  process.exit(0);
}
