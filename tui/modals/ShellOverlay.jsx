// tui/modals/ShellOverlay.jsx — overlay shell terminal viewport.
//
// Attaches a VIEW to the keep-warm singleton (server/shellSession.mjs).
// Never owns the PTY — unmounting only detaches the render subscriptions.
// Chrome: bordered box matching Zoom; header `shell · <shell> · <cwd>`;
// footer `⌃Q close · all other keys → shell`.
//
// Reuses:
//   - tui/zoom/ptyCells.js rowToRuns (cell → Ink <Text> runs)
//   - server/shellSession.mjs getShellSession() (attach to singleton)
//   - tui/shell/shellKeys.js classifyShellKey (Ctrl+Q close only)
//
// Security: dlog logs lifecycle metadata only — never PTY stdin or buffer
// contents (overlay-terminal.md §2, secrets in scope).
// TODO(shell-keys): 0324 adds PTY key forwarding (keyToBytes → pty.write).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { getShellSession } from '../../server/shellSession.mjs';
import { rowToRuns } from '../zoom/ptyCells.js';
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

  // Attach view on mount; dispose render subs on unmount. Never kill the PTY.
  useEffect(() => {
    const session = getShellSession();
    const { pty, term, cell } = session;
    termRef.current = term;
    cellRef.current = cell;

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
      dlog('shell', 'overlay-detach', { pid: pty?.pid });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close chord: Ctrl+Q only. Swallow all other keys.
  // TODO(shell-keys): 0324 adds keyToBytes → pty.write for forwarded keys.
  useInput((input, key) => {
    if (classifyShellKey(input, key) === 'EXIT') onClose?.();
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
  const spawnCwd  = homedir(); // singleton spawns at $HOME; OSC-7 live-cwd is a followup

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
