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
//   getWrites()    — array of every byte string written so far, through
//                    agent.writeInput() (PtyPane's path since 0446) or a
//                    direct pty.write()
//   getWriteOpts() — 0446: the { submit, paste } opts of each writeInput call
//   getResizes()   — array of [cols, rows] from pty.resize()
//   termResizes    — array of [cols, rows] from term.resize()
//   markUserSubmittedCalls — counter for that agent method
//
// To exercise bracketed-paste paths, set
// `term.modes.bracketedPasteMode = true` before pressing keys.
export function makeStubAgent({ cols = 80, rows = 24 } = {}) {
  const writes = [];
  const writeOpts = [];
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
    // 0446: PtyPane writes through the agent's guarded input path, not the
    // pty handle. Mirrors PtyCore.writeInput with no cost cap set: every
    // write lands. Bytes go into the same `writes` array as pty.write so
    // getWrites() assertions hold either way.
    writeInput(bytes, opts = {}) {
      writes.push(bytes);
      writeOpts.push({ submit: !!opts.submit, paste: !!opts.paste });
      return true;
    },
    capMessage() { return null; },
    // Mirrors PtyAgent.attachZoomView after 0404: attaching does NOT resize.
    // The agent's PTY already runs at the fleet viewport's geometry, and every
    // resize makes claude reprint its whole frame — leaving the pre-resize copy
    // in the emulator's scrollback (the double-print bug).
    attachZoomView({ cols: _c, rows: _r } = {}) {
      attached++;
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
    getWriteOpts: () => writeOpts.map((o) => ({ ...o })),
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
