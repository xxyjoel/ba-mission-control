#!/usr/bin/env node
// scripts/fix-node-pty.mjs — ensure node-pty's spawn-helper is executable.
//
// Why this exists: some npm versions extract the prebuilt spawn-helper without
// preserving its executable mode, which makes `pty.spawn(...)` fail with
// "posix_spawnp failed." The fix is a chmod +x.
//
// It runs BOTH as a `postinstall` script AND at runtime from tui/main.jsx boot,
// because **npx frequently skips postinstall** — so the runtime self-heal is
// what actually makes the PTY work on `npx @bluearch/mission-control` and global
// installs. node-pty is a runtime dep (Zoom + the `!` shell hand the terminal to
// a real PTY child), so a non-executable helper crashes those features.

import { chmodSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve node-pty's ACTUAL install dir regardless of hoisting (top-level
// node_modules vs nested under this package) — an earlier sibling-only path is
// exactly how hoisted installs slipped through. Fall back to the sibling path.
function ptyRoot() {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', 'node_modules', 'node-pty');
  }
}

// Enumerate EVERY spawn-helper node-pty ships — prebuild-install drops one per
// platform under prebuilds/<os>-<arch>/spawn-helper; a source build lands one at
// build/Release/spawn-helper. Don't hardcode the host triple.
function spawnHelpers(root) {
  const helpers = [join(root, 'build/Release/spawn-helper')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) helpers.push(join(prebuilds, dir, 'spawn-helper'));
  }
  return helpers;
}

// fixNodePty — best-effort chmod +x on every spawn-helper missing an exec bit.
// NEVER throws (returns a summary). Safe to call at boot and repeatedly; a
// read-only/global install path that can't be chmod'd is skipped, not fatal.
export function fixNodePty({ log = false } = {}) {
  const root = ptyRoot();
  const fixed = [];
  if (!existsSync(root)) return { root, present: false, fixed };
  for (const path of spawnHelpers(root)) {
    try {
      if (!existsSync(path)) continue;
      if ((statSync(path).mode & 0o111) === 0) { // no execute bit at all
        chmodSync(path, 0o755);
        fixed.push(path);
        if (log) console.log(`fix-node-pty: chmod +x ${path}`);
      }
    } catch (err) {
      if (log) console.log(`fix-node-pty: could not chmod ${path} (${err.code || err.message}) — skipping`);
    }
  }
  return { root, present: true, fixed };
}

// Run directly (postinstall / manual): log what it does.
if (import.meta.url === `file://${process.argv[1]}`) fixNodePty({ log: true });
