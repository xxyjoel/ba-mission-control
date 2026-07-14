// server/repos.mjs — discover git repositories the user has worked in recently.
//
// Walks a fixed list of "code root" directories up to MAX_DEPTH levels deep,
// stopping descent into a directory the moment it contains .git (so we don't
// enumerate submodules / vendored repos). Sorts by mtime — proxy for "last
// touched" — and returns the top N for the New Session modal.
//
// Override the parent list with REPO_PARENTS=path1:path2 to suit your layout.

import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const HOME = homedir();
const MAX_DEPTH = 3;

const DEFAULT_PARENTS = [
  join(HOME, 'repos'),
  join(HOME, 'work'),
  join(HOME, 'git'),
  join(HOME, 'projects'),
  join(HOME, 'src'),
  join(HOME, 'code'),
  join(HOME, 'dev'),
];

// Expand a leading `~` to the user's home dir. The picker stores absolute
// paths, but settings written by hand (or the REPO_PARENTS env var) may use
// `~`, so normalize here before we stat anything.
function expandTilde(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

// Resolve the list of parent dirs to walk, in precedence order:
//   1. `override` — the user's configured locations (settings.repoParents),
//      passed in by the caller. When non-empty these REPLACE everything.
//   2. REPO_PARENTS env var (colon-separated) — power-user / CI override.
//   3. Built-in DEFAULT_PARENTS.
function parents(override) {
  if (Array.isArray(override) && override.length) return override.map(expandTilde);
  const env = process.env.REPO_PARENTS;
  if (env) return env.split(':').filter(Boolean).map(expandTilde);
  return DEFAULT_PARENTS;
}

function tildify(p) {
  if (p.startsWith(HOME)) return '~' + p.slice(HOME.length);
  return p;
}

function relativeAge(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w === 1) return 'last week';
  if (w < 4) return `${w} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

async function defaultBranch(repoPath) {
  try {
    const head = await readFile(join(repoPath, '.git', 'HEAD'), 'utf8');
    const m = head.match(/ref:\s+refs\/heads\/(.+)/);
    if (m) return m[1].trim();
  } catch {}
  return 'main';
}

async function readRemote(repoPath) {
  try {
    const cfg = await readFile(join(repoPath, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
    if (!m) return '(local)';
    let url = m[1].trim();
    url = url.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
    return url;
  } catch {
    return '(local)';
  }
}

// Walk `dir` up to maxDepth, collecting any directory that contains .git.
// Skips hidden dirs (.git, .Trash, .cache) and node_modules.
async function walkForRepos(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  if (!existsSync(dir)) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

  // If this dir is itself a repo, record it and DON'T descend (avoid nested
  // submodules / vendored repos).
  if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
    let st;
    try { st = await stat(dir); out.push({ repoPath: dir, mtime: st.mtimeMs }); } catch {}
    return;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') continue;
    await walkForRepos(join(dir, name), depth + 1, maxDepth, out);
  }
}

export async function listRecentRepos({ limit = 30, parents: parentsOverride } = {}) {
  const candidates = [];
  for (const parent of parents(parentsOverride)) {
    await walkForRepos(parent, 0, MAX_DEPTH, candidates);
  }
  // De-dupe (a repo could be reached via two parents)
  const seen = new Set();
  const unique = candidates.filter((c) => {
    if (seen.has(c.repoPath)) return false;
    seen.add(c.repoPath); return true;
  });
  unique.sort((a, b) => b.mtime - a.mtime);
  const top = unique.slice(0, limit);
  const out = [];
  for (const c of top) {
    const [branch, remote] = await Promise.all([
      defaultBranch(c.repoPath),
      readRemote(c.repoPath),
    ]);
    out.push({
      name: basename(c.repoPath),
      parent: tildify(dirname(c.repoPath)),
      path: tildify(c.repoPath),
      absPath: c.repoPath,
      last: relativeAge(c.mtime),
      defaultBranch: branch,
      remote,
    });
  }
  return out;
}
