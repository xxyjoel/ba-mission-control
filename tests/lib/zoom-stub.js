// tests/lib/zoom-stub.js — mock agent + stub PTY factory for PtyPane tests.
//
// Renders PtyPane against a fake PtyAgent whose `attachZoomView()` returns
// a stub PTY that records every `.write(bytes)` into an array the test
// can assert on, plus a real xterm-headless Terminal so paste-wrap
// branches can be exercised by flipping `term.modes.bracketedPasteMode`.
//
// This is the missing primitive for the zoom-text-input recipe suite —
// without it each test would re-build the same mock plumbing.

import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg.default || xtermPkg;

// makeStubAgent — returns { agent, pty, term, getWrites, getResizes,
// disposeCalls, sessionWasAttached }.
//
//   agent          — passed as the `agent` prop to <PtyPane>
//   pty            — the stub PTY (also reachable via getWrites)
//   term           — the xterm-headless Terminal owned by the stub
//   getWrites()    — array of every pty.write() argument so far
//   getResizes()   — array of [cols, rows] from pty.resize()
//   termResizes    — array of [cols, rows] from term.resize()
//   markUserSubmittedCalls — counter for that agent method
//
// To exercise bracketed-paste paths, set
// `term.modes.bracketedPasteMode = true` before pressing keys.
export function makeStubAgent({ cols = 80, rows = 24 } = {}) {
  const writes = [];
  const resizes = [];
  const termResizes = [];
  const disposeCalls = [];
  const handlers = { data: [], exit: [] };
  let attached = 0;

  const pty = {
    pid: 9999,
    write(bytes) { writes.push(bytes); },
    onData(fn) { handlers.data.push(fn); return { dispose() {} }; },
    onExit(fn) { handlers.exit.push(fn); return { dispose() {} }; },
    resize(c, r) { resizes.push([c, r]); },
    kill() {},
  };

  const term = new Terminal({
    cols, rows, allowProposedApi: true, scrollback: 200,
  });
  const origTermResize = term.resize.bind(term);
  term.resize = (c, r) => { termResizes.push([c, r]); return origTermResize(c, r); };
  const cell = term.buffer.active.getNullCell();

  let markUserSubmittedCalls = 0;

  const agent = {
    id: 'stub-agent-1',
    slot: 1,
    name: 'stub',
    model: 'sonnet-4.6',
    permissionMode: 'acceptEdits',
    tail: [],
    todos: [],
    markUserSubmitted() { markUserSubmittedCalls++; },
    attachZoomView({ cols: c, rows: r } = {}) {
      attached++;
      if (c && r) { try { term.resize(c, r); } catch {} }
      return {
        pty,
        term,
        cell,
        sessionId: 'stub-session',
        dispose: () => { disposeCalls.push(Date.now()); },
      };
    },
  };

  return {
    agent,
    pty,
    term,
    cell,
    getWrites: () => writes.slice(),
    getResizes: () => resizes.slice(),
    getTermResizes: () => termResizes.slice(),
    getDisposeCalls: () => disposeCalls.slice(),
    getMarkUserSubmittedCalls: () => markUserSubmittedCalls,
    getAttachedCount: () => attached,
    fireData: (chunk) => { for (const fn of handlers.data) fn(chunk); },
    fireExit: ({ exitCode = 0, signal = null } = {}) => {
      for (const fn of handlers.exit) fn({ exitCode, signal });
    },
  };
}
