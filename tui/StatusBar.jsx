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
import { isStoreReadOnly } from './lib/sessionStore.js';

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
// `enabled` gates the interval entirely: the caret is only rendered while the
// command bar is open, and an always-on 500ms interval forces 2 full Ink
// frames/sec at idle whose output is byte-identical and discarded — the
// largest single idle-CPU term in the 2026-08 energy reviews.
function useBlink(enabled, intervalMs = 500) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!enabled) { setOn(true); return; }
    const t = setInterval(() => setOn(o => !o), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return on;
}

export default function StatusBar({ mode = 'normal', focused, cmdMode = 'normal', cmdBuffer = '', filterActive = '', theme }) {
  const storeReadOnly = isStoreReadOnly();
  // When the user is typing in the command bar, override the mode chip so
  // the focus is unambiguous.
  const effectiveMode = cmdMode === 'filter'  ? 'filter'
                     : cmdMode === 'command' ? 'cmdInput'
                     : mode;
  const m = MODES[effectiveMode] || MODES.normal;
  const caret = useBlink(cmdMode !== 'normal');
  const debugKeys = useDebugKeys();

  return (
    // 0389: pinned to ONE row and clipped. This bar is the last thing on
    // screen, so any child that wraps grows it and pushes the whole Ink frame
    // past the terminal's height — the "UI jumped upward" report. Typing crept
    // up on that threshold; a dictated phrase arrives all at once and crosses
    // it immediately. height + overflow makes it structural rather than
    // relying on every child remembering to truncate.
    <Box paddingX={1} height={1} overflow="hidden">
      {/* 0389: the warning chips and the mode/slot label do not shrink. Pinning
          the bar to one row means SOMETHING has to give when the content
          exceeds the width, and Ink's default is to shrink every child a
          little — which truncated the sandbox banner to "DEV ·" and the slot
          label to "[]". The trailing hints (truncated, and hidden entirely
          while a command is being typed) are what should absorb it. */}
      {storeReadOnly && (
        <Box flexShrink={0}>
          <Text backgroundColor={theme.yellow || 'yellow'} color={theme.bg || 'black'} bold>
            {' NOT SAVING '}
          </Text>
          <Text> </Text>
        </Box>
      )}
      {SANDBOXED && (
        <Box flexShrink={0}>
          <Text backgroundColor={theme.red || 'red'} color={theme.bg || 'black'} bold>
            {' DEV · SANDBOXED '}
          </Text>
        </Box>
      )}
      {debugKeys && (
        <Box flexShrink={0}>
          <Text backgroundColor={theme.yellow || 'yellow'} color={theme.bg || 'black'} bold>
            {' ● REC keys '}
          </Text>
        </Box>
      )}
      <Box flexShrink={0}>
        <Text backgroundColor={theme[m.bg]} color={theme[m.fg]}> {m.label} </Text>
        <Text color={theme.dim}>  [</Text>
        <Text color={theme.fg}>{focused ? focused.slot : '-'}</Text>
        <Text color={theme.dim}>] {focused?.name || 'empty'}</Text>
      </Box>

      {/* Command-bar buffer takes over the middle when active */}
      {cmdMode !== 'normal' ? (
        <>
          <Text color={cmdMode === 'filter' ? theme.cyan : theme.magenta}>  {cmdMode === 'filter' ? '/' : ':'}</Text>
          {/* 0389: truncate-start, never wrap. The status bar is ONE row and it
              is the last thing on screen, so a buffer long enough to wrap grew
              the bar to two or three rows and pushed the whole frame past the
              terminal's height — the "UI jumped upward while I dictated"
              report. Dictation reaches this bar as a whole phrase in one write,
              so it hits the wrap threshold immediately where typing crept up on
              it. truncate-start keeps the END of the buffer visible, next to
              the caret, matching TextField's caret row. */}
          <Text color={theme.fg} wrap="truncate-start">{cmdBuffer}</Text>
          <Text color={theme.accent}>{caret ? '█' : ' '}</Text>
          <Text color={theme.dim} wrap="truncate">  ↵ run · esc cancel</Text>
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
      {/* 0389: the nav hints are dead weight while the user is typing a
          command — and they were taking the width the buffer needs, so a
          dictated phrase showed as a few characters between two ellipses.
          Hidden while the bar is active; the bar's own "↵ run · esc cancel"
          stays. */}
      {cmdMode === 'normal' && (
        <Text color={theme.dim} wrap="truncate">
          <Text color={theme.accent}>← ↑ ↓ →</Text> move  <Text color={theme.accent}>↵</Text> open  <Text color={theme.accent}>n</Text> new  <Text color={theme.accent}>b</Text> bcast  <Text color={theme.accent}>esc</Text> settings
        </Text>
      )}
    </Box>
  );
}
