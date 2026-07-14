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

export async function dirtyCount(cwd) {
  const out = await runGit(cwd, ['status', '--porcelain']);
  if (out == null) return 0;
  if (!out) return 0;
  return out.split('\n').filter(Boolean).length;
}

// { ahead, behind } against configured upstream; falls back to origin/<branch>.
// Returns zeros when no upstream exists.
export async function aheadBehind(cwd, branch) {
  let out = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (out == null && branch) {
    out = await runGit(cwd, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
  }
  if (out == null) return { ahead: 0, behind: 0 };
  const m = out.split(/\s+/).map((n) => parseInt(n, 10));
  if (m.length !== 2 || m.some(Number.isNaN)) return { ahead: 0, behind: 0 };
  return { behind: m[0], ahead: m[1] };
}

export async function fullStatus(cwd) {
  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, branch: null, dirty: 0, ahead: 0, behind: 0 };
  }
  const branch = await currentBranch(cwd);
  const [dirty, ab] = await Promise.all([
    dirtyCount(cwd),
    aheadBehind(cwd, branch),
  ]);
  return { isRepo: true, branch, dirty, ahead: ab.ahead, behind: ab.behind };
}
