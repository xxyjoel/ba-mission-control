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
import { dlog } from '../tui/lib/debugLog.js';

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

  // dlog: lifecycle metadata only — never PTY stdin bytes or buffer contents
  // (see overlay-terminal.md §2 — secrets in scope).
  dlog('shell', 'spawn', { pid: pty?.pid, shell, cwd });

  _session = { pty };
  return _session;
}

// _resetForTest — wipe the singleton so unit tests can call getShellSession()
// with a fresh stub without state leaking between test cases.
// NOT part of the public API; export name prefixed to make that clear.
export function _resetForTest() {
  _session = null;
}
