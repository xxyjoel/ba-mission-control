// tui/modals/SubscriptionLogin.jsx — Settings → SUBSCRIPTIONS → ↵ connect.
//
// Runs `<provider.bin()> <provider.loginArgv>` in a real PTY
// (server/loginPty.mjs) and renders it the way ShellOverlay renders the
// shell, so the user sees the vendor's URL / device-code prompt and can answer
// it. mc never handles the credential. When the process exits, onExit fires
// and App returns to Settings, which re-probes.
//
// Reuses tui/zoom/ptyCells.js rowToRuns, tui/zoom/ptyKeys.js keyToBytes,
// tui/shell/shellKeys.js classifyShellKey (Ctrl+Q) and the leading throttle.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { basename } from 'node:path';
import { startLoginPty } from '../../server/loginPty.mjs';
import { rowToRuns } from '../zoom/ptyCells.js';
import { keyToBytes } from '../zoom/ptyKeys.js';
import { classifyShellKey } from '../shell/shellKeys.js';
import { throttleDecision } from '../lib/leadingThrottle.js';

const RENDER_INTERVAL_MS = 33;

export default function SubscriptionLogin({ provider, onExit, onCancel, theme, width, height, spawn }) {
  const { stdout } = useStdout();
  // Same chrome math as ShellOverlay: width 2 border + 4 padding; height
  // 2 border + 2 padding + header 1 + margin 1 + footer 1.
  const outerW = Math.max(24, Math.floor(width || stdout?.columns || 80));
  const outerH = Math.max(8, Math.floor(height || stdout?.rows || 24));
  const cols = Math.max(10, outerW - 6);
  const rows = Math.max(1, outerH - 7);

  const [tick, setTick] = useState(0);
  const [error, setError] = useState(null);
  const sessionRef = useRef(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const s = startLoginPty({ bin: provider.bin(), args: provider.loginArgv, cols, rows, ...(spawn ? { spawn } : {}) });
    if (s.error) { setError(s.error); return undefined; }
    sessionRef.current = s;
    let timer = null, last = 0;
    const paint = () => { last = Date.now(); setTick(n => (n + 1) | 0); };
    const schedule = () => {
      if (timer) return;
      const { paintNow, scheduleIn } = throttleDecision(Date.now(), last, RENDER_INTERVAL_MS);
      if (paintNow) { paint(); return; }
      timer = setTimeout(() => { timer = null; paint(); }, scheduleIn);
    };
    const subs = [];
    try { subs.push(s.term?.onWriteParsed(schedule)); } catch {}
    try { subs.push(s.term?.onCursorMove(schedule)); } catch {}
    s.onExit((e) => onExitRef.current?.({ providerId: provider.id, exitCode: e?.exitCode ?? null }));
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      for (const d of subs) { try { d?.dispose?.(); } catch {} }
      s.dispose();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { sessionRef.current?.resize(cols, rows); }, [cols, rows]);

  useInput((input, key) => {
    if (classifyShellKey(input, key) === 'EXIT') {
      sessionRef.current?.kill();
      onCancel?.();
      return;
    }
    const s = sessionRef.current;
    if (!s) return;
    const bytes = keyToBytes(input, key);
    if (bytes != null) { try { s.pty.write(bytes); } catch {} }
  });

  const cursorStyle = useMemo(() => ({
    backgroundColor: theme?.accent || 'cyan',
    color: theme?.bg || 'black',
  }), [theme?.accent, theme?.bg]);

  const view = useMemo(() => {
    const s = sessionRef.current;
    if (!s?.term || !s?.cell) return null;
    const buf = s.term.buffer.active;
    const startY = buf.viewportY;
    const cursorRow = Number.isInteger(buf.cursorY) ? (buf.baseY + buf.cursorY) - startY : -1;
    const out = [];
    for (let y = 0; y < rows; y++) {
      out.push(rowToRuns(buf.getLine(startY + y), s.cell, cols, y === cursorRow ? buf.cursorX : -1, cursorStyle));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cols, rows, cursorStyle]);

  const command = [basename(String(provider.bin())), ...provider.loginArgv].join(' ');

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor={theme?.accent} paddingX={2} paddingY={1} width={outerW}>
      <Box>
        <Text color={theme?.accent}>connect {provider.label}</Text>
        <Text color={theme?.faint}> · </Text>
        <Text color={theme?.dim} wrap="truncate">{command}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" width={cols} height={rows} overflow="hidden">
        {error ? (
          <Box flexDirection="column">
            <Text color={theme?.red || 'red'} wrap="truncate">⚠ {error}</Text>
            <Text color={theme?.dim}>Press Ctrl+Q to go back.</Text>
          </Box>
        ) : view ? view.map((runs, y) => (
          <Text key={y} wrap="truncate">
            {runs.length === 0 ? ' ' : runs.map((r, i) => (
              <Text key={i} color={r.props.color} backgroundColor={r.props.backgroundColor} bold={r.props.bold}
                italic={r.props.italic} underline={r.props.underline} dimColor={r.props.dimColor}
                inverse={r.props.inverse} strikethrough={r.props.strikethrough}>{r.text}</Text>
            ))}
          </Text>
        )) : (
          <Text color={theme?.dim}>(starting {command}…)</Text>
        )}
      </Box>
      <Box>
        <Text color={theme?.accent} bold>⌃Q</Text>
        <Text color={theme?.dim} wrap="truncate"> cancel  ·  other keys → {basename(String(provider.bin()))}  ·  back to Settings when it exits</Text>
      </Box>
    </Box>
  );
}
