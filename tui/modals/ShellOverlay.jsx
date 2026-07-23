// tui/modals/ShellOverlay.jsx — overlay shell terminal viewport.
//
// Attaches a VIEW to the keep-warm singleton (server/shellSession.mjs).
// Never owns the PTY — unmounting only detaches the render subscriptions.
// Chrome: bordered box matching Zoom; header `shell · <shell> · <cwd>`;
// footer `⌃Q close · all other keys → shell`.
//
// Reuses:
//   - tui/zoom/ptyCells.js rowToRuns (cell → Ink <Text> runs)
//   - tui/zoom/ptyKeys.js keyToBytes (Ink key events → PTY byte sequences)
//   - server/shellSession.mjs getShellSession() (attach to singleton)
//   - tui/shell/shellKeys.js classifyShellKey (Ctrl+Q close only)
//
// Security: dlog logs lifecycle metadata only — never PTY stdin or buffer
// contents (overlay-terminal.md §2, secrets in scope).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { getShellSession, resizeShellSession } from '../../server/shellSession.mjs';
import { rowToRuns } from '../zoom/ptyCells.js';
import { keyToBytes } from '../zoom/ptyKeys.js';
import { classifyShellKey } from '../shell/shellKeys.js';
import { dlog } from '../lib/debugLog.js';

const RENDER_INTERVAL_MS = 16; // ~60fps burst coalesce, mirrors PtyPane

export default function ShellOverlay({ onClose, theme, width, height }) {
  const { stdout } = useStdout();

  // Dimensions: caller may pass explicit width/height (from App resize state);
  // fall back to stdout. Inner body excludes 2 border + 2 padY + header + footer.
  const cols = Math.max(20, Math.floor(width  || stdout?.columns || 80));
  const rows = Math.max(5,  Math.floor((height || stdout?.rows   || 24) - 6));

  const [tick, setTick] = useState(0);
  const writeSubRef  = useRef(null);
  const scrollSubRef = useRef(null);
  const cursorSubRef = useRef(null);
  const renderTimerRef = useRef(null);
  const termRef = useRef(null);
  const cellRef = useRef(null);
  const ptyRef  = useRef(null);

  // Attach view on mount; dispose render subs on unmount. Never kill the PTY.
  useEffect(() => {
    const session = getShellSession();
    const { pty, term, cell } = session;
    termRef.current = term;
    cellRef.current = cell;
    ptyRef.current  = pty;

    // dlog: lifecycle metadata only (overlay-terminal.md §2).
    dlog('shell', 'overlay-attach', { pid: pty?.pid });

    const scheduleRender = () => {
      if (renderTimerRef.current) return;
      renderTimerRef.current = setTimeout(() => {
        renderTimerRef.current = null;
        setTick(n => (n + 1) | 0);
      }, RENDER_INTERVAL_MS);
    };

    // Subscribe to term buffer changes — view only, no data pump.
    // The singleton already wires pty.onData → term.write (shellSession:89).
    try { writeSubRef.current  = term?.onWriteParsed(() => scheduleRender()); } catch {}
    try { scrollSubRef.current = term?.onScroll(()      => scheduleRender()); } catch {}
    try { cursorSubRef.current = term?.onCursorMove(()  => scheduleRender()); } catch {}

    scheduleRender(); // paint current buffer immediately on mount

    return () => {
      // Dispose ONLY render subscriptions. PTY and term stay alive (keep-warm).
      if (renderTimerRef.current) { clearTimeout(renderTimerRef.current); renderTimerRef.current = null; }
      try { writeSubRef.current?.dispose?.();  } catch {}
      try { scrollSubRef.current?.dispose?.(); } catch {}
      try { cursorSubRef.current?.dispose?.(); } catch {}
      writeSubRef.current = scrollSubRef.current = cursorSubRef.current = null;
      termRef.current = null;
      cellRef.current = null;
      ptyRef.current  = null;
      dlog('shell', 'overlay-detach', { pid: pty?.pid });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resize: forward new dims to PTY + emulator when viewport changes ──
  // Mirrors PtyPane resize effect (tui/zoom/PtyPane.jsx:281-288).
  // App already subscribes to process.stdout 'resize' and mirrors new
  // dimensions into state — that re-renders ShellOverlay with new
  // width/height props. We forward to resizeShellSession (which issues
  // both pty.resize and term.resize) then nudge a re-render so the
  // viewport reflects the new buffer dimensions.
  // Clamped cols/rows (same Math.max floors as PtyPane) are forwarded —
  // these are the inner-viewport dims that match what rowToRuns renders.
  useEffect(() => {
    resizeShellSession(cols, rows);
    setTick(n => (n + 1) | 0);
    // dlog: lifecycle metadata only (overlay-terminal.md §2).
    dlog('shell', 'overlay-resize', { cols, rows });
  }, [cols, rows]);

  // Close chord: Ctrl+Q (classifyShellKey === 'EXIT') closes the overlay.
  // All other keystrokes are forwarded verbatim to the PTY via keyToBytes.
  // Security: keystrokes are never logged (overlay-terminal.md §2).
  // Bracketed-paste guard mirrors PtyPane: wrap multi-char input in CSI 200~/201~
  // when the shell has enabled bracketed paste mode, to prevent auto-execution.
  useInput((input, key) => {
    if (classifyShellKey(input, key) === 'EXIT') { onClose?.(); return; }

    const pty = ptyRef.current;
    if (!pty) return;

    // Bracketed-paste guard (mirrors PtyPane.jsx:361-374).
    if (
      input && input.length > 1 &&
      !key.ctrl && !key.meta && !key.shift &&
      !key.return && !key.escape && !key.tab &&
      !key.backspace && !key.delete &&
      !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow &&
      !key.home && !key.end && !key.pageUp && !key.pageDown
    ) {
      const term = termRef.current;
      if (term?.modes?.bracketedPasteMode) {
        try { pty.write('\x1b[200~' + input + '\x1b[201~'); } catch {}
        return;
      }
    }

    const bytes = keyToBytes(input, key);
    if (bytes != null) {
      try { pty.write(bytes); } catch {}
    }
  });

  // Cursor style matches PtyPane (hard-painted accent block).
  const cursorStyle = useMemo(() => ({
    backgroundColor: theme?.accent || 'cyan',
    color: theme?.bg || 'black',
  }), [theme?.accent, theme?.bg]);

  const view = useMemo(() => {
    const term = termRef.current;
    const cell = cellRef.current;
    if (!term || !cell) return null;
    const buf = term.buffer.active;
    const cursorY = buf.cursorY;
    const cursorX = buf.cursorX;
    // TODO(shell-scroll): buf.viewportY is pinned to the live viewport; the
    // TERM_SCROLLBACK rows in the buffer are inaccessible to the user. Add a
    // scroll offset state + Ctrl+Y / Ctrl+E bindings to let the user page
    // through history without leaving the overlay (see overlay-terminal.md §key-risk).
    const startY  = buf.viewportY;
    const out = [];
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(startY + y);
      const cxForRow = (Number.isInteger(cursorY) && y === cursorY) ? cursorX : -1;
      out.push(rowToRuns(line, cell, cols, cxForRow, cursorStyle));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cols, rows, cursorStyle]);

  // Header: `shell · <shell-basename> · <spawn-cwd>`
  const shellName = basename(process.env.SHELL || '/bin/bash');
  // TODO(shell-osc7): spawnCwd is hardcoded to $HOME; live cwd tracking via OSC 7
  // escape sequences would let the header reflect the shell's current directory
  // after cd commands. Deferred — requires parsing PTY output for ESC]7;... sequences.
  const spawnCwd  = homedir();

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme?.accent}
      paddingX={2}
      paddingY={1}
      width={width || cols + 6}
    >
      {/* Header */}
      <Box>
        <Text color={theme?.accent}>shell</Text>
        <Text color={theme?.faint}> · </Text>
        <Text color={theme?.fg}>{shellName}</Text>
        <Text color={theme?.faint}> · </Text>
        <Text color={theme?.dim}>{spawnCwd}</Text>
      </Box>

      {/* Terminal viewport */}
      <Box marginTop={1} flexDirection="column" width={cols} height={rows} overflow="hidden">
        {view ? view.map((runs, y) => (
          <Text key={y} wrap="truncate">
            {runs.length === 0 ? ' ' : runs.map((r, i) => (
              <Text
                key={i}
                color={r.props.color}
                backgroundColor={r.props.backgroundColor}
                bold={r.props.bold}
                italic={r.props.italic}
                underline={r.props.underline}
                dimColor={r.props.dimColor}
                inverse={r.props.inverse}
                strikethrough={r.props.strikethrough}
              >{r.text}</Text>
            ))}
          </Text>
        )) : (
          <Text color={theme?.dim}>(launching shell…)</Text>
        )}
      </Box>

      {/* Footer hint row */}
      <Box>
        <Text color={theme?.accent} bold>⌃Q</Text>
        <Text color={theme?.dim}> close  ·  all other keys → shell</Text>
      </Box>
    </Box>
  );
}
