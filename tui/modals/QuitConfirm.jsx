// tui/modals/QuitConfirm.jsx — quit mc with an explicit save / no-save choice.
//
// Opened when the user presses `q`. The modal owns its own keys:
//   s/S/Enter/y/Y/q/Q → save & quit   (onQuit('save'))  — keep conversations + totals
//   d/D               → quit, no save (onQuit('clear')) — reopen fresh
//   n/N/Esc           → cancel        (onCancel())
// The menu names ONE save key, `q`, so q then q is the command (owner
// 2026-10-22, task 0477: showing both q and s confused). s, y and Enter still
// save, unlisted, so old habits never lose work. Discard is [d] only. Every
// other key is ignored (no auto-dismiss).
//
// Save is the DEFAULT: every exit preserves resumable conversations + token/cost
// totals UNLESS the user explicitly picks [d]. Closing the terminal (cmd+W →
// SIGHUP), Ctrl-C, and this modal's save keys all keep the sessions; only [d]
// quit-no-save downgrades to a "clear". Enter maps to SAVE so an instinctive
// Enter never loses work. onQuit sets the persist mode in the session store
// BEFORE Ink tears down; the final write in main.jsx then records the right
// thing (default 'save' if no key set it).

import React from 'react';
import { Box, Text, useInput, useApp } from 'ink';

export default function QuitConfirm({ onCancel, onQuit, theme, agentCount = 0 }) {
  const { exit } = useApp();
  const quit = (mode) => {
    try { onQuit?.(mode); } finally { exit(); }
  };
  useInput((input, key) => {
    // 0456: a second `q` saves too — qq must never lose work.
    if (input === 's' || input === 'S' || input === 'y' || input === 'Y'
      || input === 'q' || input === 'Q' || key.return) {
      quit('save');
      return;
    }
    // Discard is the explicit [d] only (0456).
    if (input === 'd' || input === 'D') {
      quit('clear');
      return;
    }
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
      width={56}
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
          <Text color={theme.accent}>[q]</Text>
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
          <Text color={theme.dim}>          esc</Text>
        </Box>
      </Box>
    </Box>
  );
}
