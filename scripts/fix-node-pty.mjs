#!/usr/bin/env node
// scripts/fix-node-pty.mjs — restore the executable bit on node-pty's
// spawn-helper after `npm install`.
//
// Why this exists: some npm versions extract the prebuilt spawn-helper
// without preserving its executable mode, which makes `pty.spawn(...)`
// fail with "posix_spawnp failed." The fix is a `chmod 0o755`. We do it
// here in a postinstall script so every fresh install / clone Just Works.
//
// node-pty is a runtime dep — the Zoom modal hands the terminal to a
// real `claude` PTY child. If the package isn't installed yet we exit
// silently — nothing to fix.

import { chmodSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const ptyRoot = join(repoRoot, 'node_modules/node-pty');

// Enumerate EVERY spawn-helper node-pty ships, across all platforms/arches —
// don't hardcode the host triple. prebuild-install drops one per platform under
// prebuilds/<os>-<arch>/spawn-helper (darwin-arm64, linux-x64, …); a source
// build lands one at build/Release/spawn-helper. An earlier darwin-only list is
// exactly why CI (linux-x64) stayed broken: the Linux helper kept npm's stripped
// mode, so pty.spawn produced NO output and every PTY recipe test failed.
function spawnHelpers() {
  const helpers = [join(ptyRoot, 'build/Release/spawn-helper')];
  const prebuilds = join(ptyRoot, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) helpers.push(join(prebuilds, dir, 'spawn-helper'));
  }
  return helpers;
}

// node-pty is a runtime dep (Zoom hands the terminal to a real claude PTY).
// If it isn't installed yet there's nothing to fix — exit silently.
if (existsSync(ptyRoot)) {
  for (const path of spawnHelpers()) {
    if (!existsSync(path)) continue;
    // 0o111 = any execute bit. npm sometimes extracts the helper without it,
    // which makes pty.spawn fail with "posix_spawnp failed" / silent no-output.
    if ((statSync(path).mode & 0o111) === 0) {
      // Best-effort: a read-only/global install path shouldn't crash postinstall.
      try {
        chmodSync(path, 0o755);
        console.log(`fix-node-pty: chmod +x ${path}`);
      } catch (err) {
        console.log(`fix-node-pty: could not chmod ${path} (${err.code || err.message}) — skipping`);
      }
    }
  }
}
