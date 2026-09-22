// server/loginPty.mjs — one short-lived PTY for a vendor CLI's own login
// (`cursor-agent login`, `claude auth login`), rendered by
// tui/modals/SubscriptionLogin.jsx so the user sees the URL / device prompt.
//
// Same shape as server/shellSession.mjs (node-pty + a persistent
// xterm-headless buffer the modal attaches to), minus the keep-warm
// singleton: a login lives exactly as long as its modal.
//
// SECURITY: `bin` is user-controlled (CLAUDE_BIN / CURSOR_AGENT_BIN). It is
// only ever argv[0] of spawn with an argv array — never a shell string. mc
// never reads or stores what the login prints; dlog records metadata only.

import { homedir } from 'node:os';
import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { dlog } from '../tui/lib/debugLog.js';

const { Terminal } = xterm.default || xterm;
const SCROLLBACK = 1000;

// startLoginPty → { pty, term, cell, onExit(cb), resize(c, r), kill(), dispose(), error }
// Never throws: a spawn failure returns { error } so the modal can say so and
// stay closable.
export function startLoginPty({ bin, args, cols = 80, rows = 24, spawn = ptySpawn, env = process.env }) {
  let pty;
  try {
    pty = spawn(bin, [...args], {
      name: 'xterm-256color',
      cols, rows,
      cwd: homedir(),
      env: { ...env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    dlog('login', 'spawn-failed', { msg: e?.message });
    return { error: `${bin} failed to start: ${e?.message || e}` };
  }

  let term = null, cell = null;
  if (typeof Terminal === 'function') {
    try {
      term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: SCROLLBACK });
      cell = term.buffer.active.getNullCell();
    } catch { term = null; cell = null; }
  }

  let exited = false, killed = false;
  const listeners = [];
  const dataSub = pty.onData((chunk) => { if (term) { try { term.write(chunk); } catch {} } });
  let exitSub = null;
  try {
    exitSub = pty.onExit((e) => {
      exited = true;
      dlog('login', 'exited', { pid: pty.pid, exitCode: e?.exitCode });
      for (const cb of listeners) { try { cb(e || {}); } catch {} }
    });
  } catch { /* stub ptys without onExit */ }
  dlog('login', 'spawn', { pid: pty.pid, cols, rows });

  const session = {
    pty, term, cell, error: null,
    onExit(cb) { listeners.push(cb); },
    resize(c, r) {
      if (exited) return;
      try { pty.resize(c, r); } catch {}
      try { term?.resize(c, r); } catch {}
    },
    // Only a live process is signalled: node-pty keeps `pid` after exit, and
    // that pid may belong to someone else by now (shellSession S5/0408).
    kill() {
      if (exited || killed) return;
      killed = true;
      try { pty.kill('SIGTERM'); } catch {}
    },
    dispose() {
      session.kill();
      listeners.length = 0;
      try { dataSub?.dispose?.(); } catch {}
      try { exitSub?.dispose?.(); } catch {}
      try { term?.dispose(); } catch {}
    },
  };
  return session;
}
