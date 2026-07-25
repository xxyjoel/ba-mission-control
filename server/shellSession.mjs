// server/shellSession.mjs — keep-warm singleton PTY for the overlay shell.
//
// The overlay shell must outlive the React component that renders it
// (ShellOverlay mounts and unmounts on each toggle). Keeping the PTY at
// module level mirrors the PtyAgent-owns-term / PtyPane-attaches-view split:
// the singleton owns spawn/kill; the modal only attaches/detaches.
//
// Lifecycle owned by this task:
//   - lazy spawn on first getShellSession() call (0309)
//   - term buffer wiring (0310)
//   - cd-on-focus (0311)
//   - kill on app shutdown (0312)

import { homedir } from 'node:os';
import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { dlog } from '../tui/lib/debugLog.js';

// Heuristic: a PTY output chunk ending in a common shell prompt suffix
// ($, %, #, >) followed by optional whitespace signals the shell is at a
// fresh prompt. Custom PS1 values that don't match (e.g. multi-line prompts
// or ANSI-colored suffixes) will leave atFreshPrompt=false — caller may retry.
// TODO(fresh-prompt): prompt regex is heuristic; custom PS1 / ANSI sequences
// can cause false negatives. OSC 7 live-cwd integration (deferred) would
// provide a reliable signal.
const PROMPT_RE = /[$%#>]\s*$/;

// xterm-headless ships as { Terminal } sometimes nested under .default
// depending on the module resolution path — same idiom as ptyAgent.mjs:46.
const { Terminal } = xterm.default || xterm;

// Persistent emulator scrollback rows. Mirrors ptyAgent.mjs TERM_SCROLLBACK.
const TERM_SCROLLBACK = 5000;

// Module-level singleton. Null until the first getShellSession() call.
let _session = null;

// getShellSession({ spawn? }) — lazily spawn $SHELL (fallback /bin/bash) in a
// pseudo-terminal and return { pty }. Every subsequent call returns the same
// cached object — the PTY is kept warm across overlay open/close cycles.
//
// The optional `spawn` parameter is an injection seam for tests; production
// code always calls the real node-pty spawn.
//
// Security: $SHELL is passed as argv[0] with an empty args array — never
// interpolated into a command string. cwd and env are structured options only.
// See overlay-terminal.md §4 for the full injection surface analysis.
export function getShellSession({ spawn = ptySpawn } = {}) {
  if (_session) return _session;

  const shell = process.env.SHELL || '/bin/bash';
  const cwd   = homedir();

  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  // Construct the persistent xterm-headless emulator so the term buffer
  // accumulates output while the overlay is closed (survives detach).
  // Guarded when Terminal ctor is absent (unit-test stub path, mirrors
  // PtyAgent.start() at ptyAgent.mjs:340).
  let term = null;
  let cell = null;
  if (Terminal && typeof Terminal === 'function') {
    try {
      term = new Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
        scrollback: TERM_SCROLLBACK,
      });
      cell = term.buffer.active.getNullCell();
    } catch (e) {
      // Term construction failed; continue without buffer (safe degradation).
      term = null;
      cell = null;
    }
  }

  // Pipe PTY output into the persistent term at the singleton level — not
  // in the overlay component — so the buffer accumulates while detached.
  // Security (overlay-terminal.md §2): never log PTY bytes or buffer contents.
  // IDisposable stored on _session so killShellSession() can unsubscribe cleanly
  // (mirrors ptyAgent._termDataSub; resolves TODO(kill) from 0309).
  const _termDataSub = pty.onData((chunk) => {
    if (term) {
      try { term.write(chunk); } catch {}
    }
    // Update prompt detection from the PTY output stream. A chunk ending in
    // a shell prompt suffix signals the shell is waiting for input.
    if (_session) _session.atFreshPrompt = PROMPT_RE.test(chunk);
  });

  // dlog: lifecycle metadata only — never PTY stdin bytes or buffer contents
  // (see overlay-terminal.md §2 — secrets in scope).
  dlog('shell', 'spawn', { pid: pty?.pid, shell, cwd, cols: 80, rows: 24, scrollback: TERM_SCROLLBACK });

  _session = { pty, term, cell, atFreshPrompt: false, _termDataSub };
  return _session;
}

// cdToCwd(dir) — write a `cd '<quoted-dir>'\n` sequence to the PTY stdin,
// but ONLY when the shell is at a fresh prompt (atFreshPrompt === true).
// Returns true when the cd was emitted, false when suppressed.
//
// Security (overlay-terminal.md §4): dir is POSIX-escaped via single-quote
// wrapping so semicolons, $(), |, &&, ", and newlines in user-controlled
// paths cannot break out of the cd argument. Embedded single quotes are
// escaped with the standard '\'  technique.
//   e.g. /a b   → cd '/a b'\n
//        /x'y   → cd '/x'\''y'\n
//
// No-op when:
//   - No session has been spawned yet (!_session)
//   - The shell is mid-command (!_session.atFreshPrompt)
//   - Caller may retry or skip (see 0316 for the call-site logic).
export function cdToCwd(dir) {
  if (!_session || !_session.atFreshPrompt) return false;

  // POSIX single-quote escape: wrap in single quotes, replace embedded ' with '\''
  const escaped = "'" + String(dir).replace(/'/g, "'\\''") + "'";
  const cmd = `cd ${escaped}\n`;

  _session.pty.write(cmd);
  // Mark not-at-prompt immediately — the cd command is now running.
  _session.atFreshPrompt = false;

  // dlog: lifecycle metadata only — dir is a known path (not keystroke stream),
  // consistent with spawn dlog which logs cwd. See overlay-terminal.md §2.
  dlog('shell', 'cd', { pid: _session.pty?.pid, dir, emitted: true });

  return true;
}

// killShellSession() — tear down the singleton PTY and term, then null the
// module-level ref so a subsequent getShellSession() spawns a fresh shell.
//
// Called on app shutdown (0318). No-ops safely when no session exists.
// Mirrors ptyAgent.kill() at ptyAgent.mjs:631-659.
//
// Security (overlay-terminal.md §2): dlog logs lifecycle metadata only
// (pid, exit signal) — never PTY stdin bytes or buffer contents.
export function killShellSession() {
  if (!_session) return;

  const { pty, term, _termDataSub } = _session;
  const pid = pty?.pid;

  // Unsubscribe the onData IDisposable before killing the pty so the dying
  // pty's output doesn't mutate a future session's atFreshPrompt.
  if (_termDataSub) {
    try { _termDataSub.dispose?.(); } catch {}
  }
  if (term) {
    try { term.dispose(); } catch {}
  }
  if (pty) {
    try { pty.kill('SIGTERM'); } catch {}
  }

  dlog('shell', 'kill', { pid });
  _session = null;
}

// resizeShellSession(cols, rows) — forward new terminal dimensions to both the
// PTY process and the xterm-headless buffer.
//
// Called by the ShellOverlay component when stdout dimensions change (0317).
// No-ops safely when no session exists (modal may call resize before spawn).
// Mirrors ptyAgent.resize() at ptyAgent.mjs:734-743.
export function resizeShellSession(cols, rows) {
  if (!_session) return;

  const { pty, term } = _session;
  if (pty) {
    try { pty.resize(cols, rows); } catch {}
  }
  if (term) {
    try { term.resize(cols, rows); } catch {}
  }
}

// _resetForTest — wipe the singleton so unit tests can call getShellSession()
// with a fresh stub without state leaking between test cases.
// NOT part of the public API; export name prefixed to make that clear.
export function _resetForTest() {
  _session = null;
}
