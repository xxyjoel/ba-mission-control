// tui/modals/QuitConfirm.jsx — quit mc with an explicit save / no-save choice.
//
// Opened when the user presses `q`. The modal owns its own keys:
//   s/S/Enter → save & quit   (onQuit('save'))  — keep the conversations + totals
//   d/D       → quit, no save  (onQuit('clear')) — sessions end; reopen fresh
//   n/N/Esc   → cancel         (onCancel())
// Every other key is ignored (no auto-dismiss, no race with App's `q` handler).
//
// Save is opt-in: a proper save is the ONLY exit that preserves resumable
// conversations and token/cost totals. Any other exit (incl. just closing the
// terminal) is a "clear" — `:resume-all` reopens only the recently-open repos as
// fresh sessions. Enter maps to SAVE so an instinctive Enter never loses work.
// onQuit sets the persist mode in the session store BEFORE Ink tears down; the
// final write in main.jsx then records the right thing.

import React from 'react';
import { Box, Text, useInput, useApp } from 'ink';

export default function QuitConfirm({ onCancel, onQuit, theme, agentCount = 0 }) {
  const { exit } = useApp();
  const quit = (mode) => {
    try { onQuit?.(mode); } finally { exit(); }
  };
  useInput((input, key) => {
    if (input === 's' || input === 'S' || key.return) { quit('save'); return; }
    if (input === 'd' || input === 'D') { quit('clear'); return; }
    if (input === 'n' || input === 'N' || key.escape) { onCancel(); return; }
    // Any other key is ignored — user must commit explicitly. No timer.
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.yellow || theme.accent}
      paddingX={3}
      paddingY={1}
      width={52}
    >
      <Box>
        <Text color={theme.yellow || theme.accent} bold>Quit mc?</Text>
      </Box>
      {agentCount > 0 && (
        <Box marginTop={1}>
          <Text color={theme.dim}>
            {agentCount} live session{agentCount === 1 ? '' : 's'} will be terminated.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.dim}>Resume saved sessions with </Text>
        <Text color={theme.accent}>:resume-all</Text>
        <Text color={theme.dim}>.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.accent}>[s]</Text>
          <Text color={theme.fg}> save & quit</Text>
          <Text color={theme.dim}>     keep conversations</Text>
        </Box>
        <Box>
          <Text color={theme.accent}>[d]</Text>
          <Text color={theme.fg}> quit, no save</Text>
          <Text color={theme.dim}>   reopen fresh</Text>
        </Box>
        <Box>
          <Text color={theme.accent}>[n]</Text>
          <Text color={theme.fg}> cancel</Text>
          <Text color={theme.dim}>          esc · enter=save</Text>
        </Box>
      </Box>
    </Box>
  );
}
