// server/git.mjs — read-only git introspection for an agent's cwd.
//
// Every helper spawns `git` (no shell) and returns null on failure (not in a
// repo, git missing, etc.) so callers can degrade gracefully. We never write.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Run `git <args>` in cwd, capture stdout. No shell — args are passed
// argv-style, immune to injection. Resolves to trimmed stdout, or null on
// non-zero exit / timeout / spawn error.
function runGit(cwd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let proc;
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const done = (val) => { if (resolved) return; resolved = true; resolve(val); };
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} done(null); }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.on('error', () => { clearTimeout(timer); done(null); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      done(code === 0 ? stdout.trim() : null);
    });
  });
}

export async function isGitRepo(cwd) {
  if (!cwd || !existsSync(cwd)) return false;
  const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out === 'true';
}

export async function currentBranch(cwd) {
  return await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// 0452: null when git fails — a failed read is unknown, never a clean 0. An
// empty porcelain listing with exit 0 is a genuinely clean tree and stays 0.
export async function dirtyCount(cwd) {
  const out = await runGit(cwd, ['status', '--porcelain']);
  if (out == null) return null;
  if (!out) return 0;
  return out.split('\n').filter(Boolean).length;
}

// { ahead, behind } against configured upstream; falls back to origin/<branch>.
// 0452: returns { ahead: null, behind: null } when no upstream exists or git
// fails — "no comparison possible" is not the same as "in step" (0/0).
export async function aheadBehind(cwd, branch) {
  let out = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (out == null && branch) {
    out = await runGit(cwd, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
  }
  if (out == null) return { ahead: null, behind: null };
  const m = out.split(/\s+/).map((n) => parseInt(n, 10));
  if (m.length !== 2 || m.some(Number.isNaN)) return { ahead: null, behind: null };
  return { behind: m[0], ahead: m[1] };
}

// 0452 contract for the Card: dirty/ahead/behind null = unknown (render '?'
// for dirty), isRepo false = not a repo (render no git chips).
export async function fullStatus(cwd) {
  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, branch: null, dirty: null, ahead: null, behind: null };
  }
  const branch = await currentBranch(cwd);
  const [dirty, ab] = await Promise.all([
    dirtyCount(cwd),
    aheadBehind(cwd, branch),
  ]);
  return { isRepo: true, branch, dirty, ahead: ab.ahead, behind: ab.behind };
}
