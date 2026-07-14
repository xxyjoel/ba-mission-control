// tui/modals/Broadcast.jsx — send one prompt to N agents at once.
//
// Layout:
//   ┏━ BROADCAST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
//   ┃ targets: 5/8                    [a] toggle all  ┃
//   ┃ [1] auth   [2] payments   [3] design  …          ┃
//   ┃ command: <input> █                              ┃
//   ┃ ↵ send · esc cancel                             ┃
//   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// Per-agent target chips: TAB cycles which one is focused; SPACE toggles its
// inclusion. `a` toggles all. ↵ commits with the typed text (when
// `broadcastConfirm` is on, requires a confirmed state; v1 just sends on ↵).

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextField from '../lib/TextField.jsx';

export default function Broadcast({ agents, onSend, onClose, theme, width = 84 }) {
  const live = agents.filter(a => a.status !== 'empty');
  const [text, setText] = useState('');
  const [targets, setTargets] = useState(() => new Set(live.map(a => a.id)));
  const [chipIdx, setChipIdx] = useState(-1);          // -1 = focus in text field
  const inText = chipIdx === -1;

  const toggle = (id) => setTargets(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.tab) {
      setChipIdx(i => {
        if (i === -1) return 0;
        if (i + 1 >= live.length) return -1;
        return i + 1;
      });
      return;
    }
    // Only chip-region keys when not in text field
    if (!inText) {
      if (input === ' ' || key.return) {
        const a = live[chipIdx]; if (a) toggle(a.id);
        return;
      }
      if (key.leftArrow)  setChipIdx(i => Math.max(0, i - 1));
      if (key.rightArrow) setChipIdx(i => Math.min(live.length - 1, i + 1));
      if (input === 'a' || input === 'A') {
        const allOn = targets.size === live.length;
        setTargets(allOn ? new Set() : new Set(live.map(a => a.id)));
        return;
      }
    }
  });

  const send = () => {
    const t = text.trim();
    if (!t || targets.size === 0) return;
    onSend(t, [...targets]);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text color={theme.accent}>━━ BROADCAST ━━</Text>
      <Box marginTop={1}>
        <Text color={theme.fg}>targets: </Text>
        <Text color={theme.accent}>{targets.size}</Text>
        <Text color={theme.dim}>/{live.length}</Text>
        <Box flexGrow={1} />
        <Text color={theme.dim}>[a] toggle all  ·  [tab] field</Text>
      </Box>
      <Box flexWrap="wrap" marginY={1}>
        {live.map((a, i) => {
          const on = targets.has(a.id);
          const focused = chipIdx === i;
          return (
            <Box key={a.id} marginRight={2}>
              <Text
                backgroundColor={focused ? theme.faint : undefined}
                color={on ? theme.accent : theme.dim}
              >
                [{a.slot}] {a.name || '—'}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        <Text color={theme.dim}>command: </Text>
      </Box>
      <Box>
        <Text color={theme.accent}>▸ </Text>
        <TextField
          value={text}
          onChange={setText}
          onSubmit={send}
          onCancel={onClose}
          focus={inText}
          color={theme.fg}
          caretColor={theme.accent}
          placeholder='"commit and push; include progress notes" — or — "update CLAUDE.md to require import sorting"'
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          <Text color={theme.accent}>↵</Text> send to {targets.size}  ·  <Text color={theme.accent}>tab</Text> chips  ·  <Text color={theme.accent}>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
