// tui/StatusBar.jsx — vim-style status line at the bottom.
//
// Left chip = current mode (NORMAL / BROADCAST / COMMAND / FOCUSED). When
// the user opens the command bar with `/` (filter) or `:` (command) we
// switch to live-input mode and render the typed buffer with a blinking
// caret. An active filter is shown as a chip even when not typing.

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { isSandboxed } from './lib/configDir.js';
import { isDebugKeysActive, subscribeDebugKeys } from './lib/debugKeys.js';

// Computed once at import time — the env var is fixed for the process.
const SANDBOXED = isSandboxed();

// React hook — re-renders the status bar whenever the runtime flag
// flips so the REC chip appears/disappears immediately on :debug-keys.
function useDebugKeys() {
  const [on, setOn] = useState(isDebugKeysActive());
  useEffect(() => subscribeDebugKeys(setOn), []);
  return on;
}

const MODES = {
  normal:    { label: '─ NORMAL ─',    bg: 'accent', fg: 'bg' },
  broadcast: { label: '─ BROADCAST ─', bg: 'yellow', fg: 'bg' },
  command:   { label: '─ COMMAND ─',   bg: 'magenta', fg: 'bg' },
  focused:   { label: '─ FOCUSED ─',   bg: 'brBlue', fg: 'bg' },
  filter:    { label: '─ FILTER ─',    bg: 'cyan',    fg: 'bg' },
  cmdInput:  { label: '─ : ─',         bg: 'magenta', fg: 'bg' },
};

// Local blink so we don't need to thread a `now` prop just for the caret.
function useBlink(intervalMs = 500) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn(o => !o), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return on;
}

export default function StatusBar({ mode = 'normal', focused, cmdMode = 'normal', cmdBuffer = '', filterActive = '', theme }) {
  // When the user is typing in the command bar, override the mode chip so
  // the focus is unambiguous.
  const effectiveMode = cmdMode === 'filter'  ? 'filter'
                     : cmdMode === 'command' ? 'cmdInput'
                     : mode;
  const m = MODES[effectiveMode] || MODES.normal;
  const caret = useBlink();
  const debugKeys = useDebugKeys();

  return (
    <Box paddingX={1}>
      {SANDBOXED && (
        <Text backgroundColor={theme.red || 'red'} color={theme.bg || 'black'} bold>
          {' DEV · SANDBOXED '}
        </Text>
      )}
      {debugKeys && (
        <Text backgroundColor={theme.yellow || 'yellow'} color={theme.bg || 'black'} bold>
          {' ● REC keys '}
        </Text>
      )}
      <Text backgroundColor={theme[m.bg]} color={theme[m.fg]}> {m.label} </Text>
      <Text color={theme.dim}>  [</Text>
      <Text color={theme.fg}>{focused ? focused.slot : '-'}</Text>
      <Text color={theme.dim}>] {focused?.name || 'empty'}</Text>

      {/* Command-bar buffer takes over the middle when active */}
      {cmdMode !== 'normal' ? (
        <>
          <Text color={cmdMode === 'filter' ? theme.cyan : theme.magenta}>  {cmdMode === 'filter' ? '/' : ':'}</Text>
          <Text color={theme.fg}>{cmdBuffer}</Text>
          <Text color={theme.accent}>{caret ? '█' : ' '}</Text>
          <Text color={theme.dim}>  ↵ run · esc cancel</Text>
        </>
      ) : (
        <>
          {filterActive && (
            <>
              <Text color={theme.dim}>  filter </Text>
              <Text color={theme.cyan}>/{filterActive}</Text>
              <Text color={theme.faint}> (/ to clear)</Text>
            </>
          )}
          <Text color={theme.accent}>  : </Text>
          <Text color={theme.dim} wrap="truncate">esc settings · ? keymap · n new · b bcast · / filter · : cmd</Text>
        </>
      )}

      <Box flexGrow={1} />
      <Text color={theme.dim}>
        <Text color={theme.accent}>← ↑ ↓ →</Text> move  <Text color={theme.accent}>↵</Text> open  <Text color={theme.accent}>n</Text> new  <Text color={theme.accent}>b</Text> bcast  <Text color={theme.accent}>esc</Text> settings
      </Text>
    </Box>
  );
}
