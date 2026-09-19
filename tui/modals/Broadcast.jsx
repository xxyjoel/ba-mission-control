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
// inclusion. `a` toggles all. ↵ commits with the typed text. 0408/I5: when
// `confirm` is on (settings.broadcastConfirm, on by default), the first ↵
// arms a "send to N sessions? ↵ again to confirm" line and only the second ↵
// sends; esc cancels (closes the modal, nothing sent). Editing the text or
// the target set disarms, so the confirmed N can never go stale.

import React, { useState, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextField from '../lib/TextField.jsx';

export default function Broadcast({ agents, onSend, onClose, theme, width = 84, confirm = true, rows }) {
  const { stdout } = useStdout();
  // 0408/I6: cap the input field so a multi-line paste cannot grow the modal
  // past the terminal. Chrome around the field ≈ 18 rows (App wrapper +
  // strip + status bar + this modal's border/header/chips/footer).
  const termRows = rows ?? (stdout?.rows || 24);
  const inputMaxRows = Math.max(1, Math.min(8, termRows - 18));
  const live = agents.filter(a => a.status !== 'empty');
  const [text, _setText] = useState('');
  const [targets, setTargets] = useState(() => new Set(live.map(a => a.id)));
  const [chipIdx, setChipIdx] = useState(-1);          // -1 = focus in text field
  const inText = chipIdx === -1;

  // Two-step send arming. Ref + state pair: the ref keeps the read inside the
  // same-tick submit handler synchronous (a state read would be stale when
  // Enter follows Enter quickly), the state drives the confirm line's render.
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const disarm = () => { armedRef.current = false; setArmed(false); };
  const setText = (v) => { disarm(); _setText(v); };

  const toggle = (id) => {
    disarm();
    setTargets(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

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
        disarm();
        const allOn = targets.size === live.length;
        setTargets(allOn ? new Set() : new Set(live.map(a => a.id)));
        return;
      }
    }
  });

  const send = () => {
    const t = text.trim();
    if (!t || targets.size === 0) return;
    // 0408/I5: with confirm on, the first ↵ only arms; the second sends.
    if (confirm && !armedRef.current) {
      armedRef.current = true;
      setArmed(true);
      return;
    }
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
          maxRows={inputMaxRows}
          placeholder='"commit and push; include progress notes" — or — "update CLAUDE.md to require import sorting"'
        />
      </Box>
      <Box marginTop={1}>
        {armed ? (
          <Text color={theme.yellow} wrap="truncate">
            send to {targets.size} session{targets.size === 1 ? '' : 's'}? <Text color={theme.accent}>↵</Text> again to confirm  ·  <Text color={theme.accent}>esc</Text> cancel
          </Text>
        ) : (
          <Text color={theme.dim}>
            <Text color={theme.accent}>↵</Text> send to {targets.size}{confirm ? ' (asks to confirm)' : ''}  ·  <Text color={theme.accent}>tab</Text> chips  ·  <Text color={theme.accent}>esc</Text> cancel
          </Text>
        )}
      </Box>
    </Box>
  );
}
