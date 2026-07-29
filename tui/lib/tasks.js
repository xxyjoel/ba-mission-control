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

const FETCH_TIMEOUT_MS = 4000;
// Hard backstop past execFile's own `timeout`. execFile's timeout sends a signal
// to `gh`, but if gh has spawned a grandchild that inherits the stdout pipe, the
// pipe stays open and the exec callback NEVER fires — the promise hangs forever
// (observed: a CI test blocked ~9 min on a single `gh issue list`). This deadline
// guarantees the function RESOLVES and hard-kills the child regardless, so neither
// the TUI hotkey caller nor the test can hang.
const HARD_TIMEOUT_MS = FETCH_TIMEOUT_MS + 1500;

// Fetch up to `limit` open issues for the gh-detectable repo at `cwd`.
// Returns:
//   { ok: true, issues: [{ number, title, state, labels: [], url }] }
//   { ok: false, message: '<one-line user-facing reason>' }
//
// We deliberately do NOT throw — the caller is a hotkey handler and
// throwing would crash the TUI.
// `bin` / `hardTimeoutMs` are test seams (defaults are the real gh + backstop);
// the app never overrides them.
export function listIssuesForCwd(cwd, { limit = 10, bin = 'gh', hardTimeoutMs = HARD_TIMEOUT_MS } = {}) {
  if (!cwd) return Promise.resolve({ ok: false, message: 'no cwd for focused session' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(result);
    };

    const child = execFile(
      bin,
      [
        'issue', 'list',
        '--limit', String(limit),
        '--state', 'open',
        '--json', 'number,title,state,labels,url',
      ],
      { cwd, timeout: FETCH_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (e, stdout) => {
        if (e) {
          // gh prints helpful messages on stderr; pluck the first line so the user
          // gets a real reason ("not a github repo" / "gh: command not found").
          const line = (e.stderr || '').toString().trim().split('\n')[0];
          return finish({ ok: false, message: line || e.message || 'gh failed' });
        }
        let parsed;
        try { parsed = JSON.parse(stdout); }
        catch { return finish({ ok: false, message: 'gh returned non-JSON' }); }
        if (!Array.isArray(parsed)) {
          return finish({ ok: false, message: 'gh response not an array' });
        }
        finish({
          ok: true,
          issues: parsed.map(it => ({
            number: it.number,
            title: it.title,
            state: it.state,
            labels: (it.labels || []).map(l => l.name || l),
            url: it.url,
          })),
        });
      },
    );

    // Guaranteed-return backstop (see HARD_TIMEOUT_MS): if the exec callback never
    // fires (grandchild holds the pipe open), force-kill the process tree and
    // resolve anyway so the caller/test never hangs.
    const hardTimer = setTimeout(() => {
      // Destroy our pipe ends first so a grandchild holding them can't keep this
      // process's event loop alive, THEN kill gh, THEN resolve.
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, message: 'gh timed out' });
    }, hardTimeoutMs);

    // execFile emits 'error' (e.g. ENOENT when gh isn't installed) separately.
    child.on('error', (e) => finish({ ok: false, message: e.message || 'gh failed' }));
  });
}
