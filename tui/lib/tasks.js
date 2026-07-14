// tui/lib/tasks.js — fetch the GitHub Issues for a session's cwd via
// the gh CLI. This is the "system of record for per-session tasks"
// surface (audit #617-618 from the 2026-06-09 feedback batch).
//
// Why gh CLI: the user already authenticates with `gh auth login`;
// mc doesn't need its own token. We never shell-interpolate user
// input — execFile is argv-only.
//
// Failure modes we tolerate:
//   - gh not installed → return a structured error the caller toasts
//   - cwd isn't a github repo → same
//   - gh times out / network is dead → same
//   - the response isn't valid JSON → same
// In every case we return an object with { ok: false, message } so
// the UI can surface a single line to the user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const FETCH_TIMEOUT_MS = 4000;

// Fetch up to `limit` open issues for the gh-detectable repo at `cwd`.
// Returns:
//   { ok: true, issues: [{ number, title, state, labels: [], url }] }
//   { ok: false, message: '<one-line user-facing reason>' }
//
// We deliberately do NOT throw — the caller is a hotkey handler and
// throwing would crash the TUI.
export async function listIssuesForCwd(cwd, { limit = 10 } = {}) {
  if (!cwd) return { ok: false, message: 'no cwd for focused session' };
  try {
    const { stdout } = await execFileP(
      'gh',
      [
        'issue', 'list',
        '--limit', String(limit),
        '--state', 'open',
        '--json', 'number,title,state,labels,url',
      ],
      { cwd, timeout: FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch { return { ok: false, message: 'gh returned non-JSON' }; }
    if (!Array.isArray(parsed)) {
      return { ok: false, message: 'gh response not an array' };
    }
    return {
      ok: true,
      issues: parsed.map(it => ({
        number: it.number,
        title: it.title,
        state: it.state,
        labels: (it.labels || []).map(l => l.name || l),
        url: it.url,
      })),
    };
  } catch (e) {
    // The gh CLI prints helpful messages on stderr; pluck the first
    // line so the user gets a real reason ("not a github repo" /
    // "gh: command not found").
    const stderr = (e.stderr || '').toString().trim().split('\n')[0];
    const msg = stderr || e.message || 'gh failed';
    return { ok: false, message: msg };
  }
}
