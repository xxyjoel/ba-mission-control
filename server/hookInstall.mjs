// server/hookInstall.mjs — stable on-disk home for the status-hook emitter.
//
// Claude sessions bake the ABSOLUTE emitter path into their hook settings at
// launch. If that path later disappears — the npx cache evicts, a home-dir
// install is deleted, the package moves — every hook event in every still-
// running session starts failing with MODULE_NOT_FOUND (observed live
// 2026-08-28 after removing a stray ~/node_modules install; task 0391).
//
// Fix: at boot, copy the emitter pair (emit-status.mjs + its one import,
// statusFile.mjs) into a directory mc owns and that never moves:
//   ~/.local/state/claude-mc/hook-runtime/
// and point hook settings there. Re-copied every boot so the stable copy
// always matches the running version; writes go via temp-file + rename so a
// hook firing mid-copy can never execute a half-written script.

import { copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));

export const STABLE_DIR = join(homedir(), '.local', 'state', 'claude-mc', 'hook-runtime');

function installOne(src, dest) {
  const tmp = dest + '.tmp';
  copyFileSync(src, tmp);
  renameSync(tmp, dest); // atomic on the same filesystem
}

let cached = null;

/**
 * stableEmitterPath() — ensure the stable copies exist and return the
 * absolute path hook settings should reference. Memoized per process.
 * On any failure (read-only home, exotic fs) falls back to the in-install
 * path — same behavior as before this module existed.
 */
export function stableEmitterPath() {
  if (cached) return cached;
  const srcEmitter = join(_dir, 'hooks', 'emit-status.mjs');
  try {
    mkdirSync(join(STABLE_DIR, 'hooks'), { recursive: true });
    // statusFile.mjs first — the emitter imports '../statusFile.mjs', so the
    // dependency must never be the missing half.
    installOne(join(_dir, 'statusFile.mjs'), join(STABLE_DIR, 'statusFile.mjs'));
    installOne(srcEmitter, join(STABLE_DIR, 'hooks', 'emit-status.mjs'));
    cached = join(STABLE_DIR, 'hooks', 'emit-status.mjs');
  } catch {
    cached = srcEmitter;
  }
  return cached;
}
