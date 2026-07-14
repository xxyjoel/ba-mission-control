// tui/lib/version.js — resolve the running mc's version + git short SHA
// for boot-time logging and the :version verb. Computed once at import
// time; cheap and never changes during a process lifetime.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitShortSha() {
  // execFileSync with explicit args — never shell-interp the repoRoot.
  // Two failure modes we tolerate: not a git checkout, git missing on PATH.
  try {
    if (!existsSync(join(repoRoot, '.git'))) return null;
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString().trim();
    return sha || null;
  } catch {
    return null;
  }
}

function readGitDirty() {
  try {
    if (!existsSync(join(repoRoot, '.git'))) return false;
    const out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export const VERSION = readPkgVersion();
export const GIT_SHA = readGitShortSha();
export const GIT_DIRTY = readGitDirty();

// Pretty one-liner used for boot banner + :version verb.
//   "0.2.0-alpha.1 · g37daf1e · dirty"
//   "0.2.0-alpha.1 · g37daf1e"
//   "0.2.0-alpha.1" (when not a git checkout)
export function versionLine() {
  const parts = [VERSION];
  if (GIT_SHA) parts.push(`g${GIT_SHA}`);
  if (GIT_DIRTY) parts.push('dirty');
  return parts.join(' · ');
}
