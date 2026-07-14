// tui/modals/Settings.jsx — btop-style settings menu.
//
// Tabs across the top (GENERAL · LAYOUT · COLORS · ALERTS · SAFETY · NOTES),
// rows in the body, footer with key hints. Tab / 1-9 switch tabs; arrows nav
// rows; ←/→ change values; ↵/space toggle. Esc closes.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SETTINGS_SCHEMA } from '../lib/settings.js';

function valueText(item, value, theme, settings) {
  if (item.kind === 'toggle') {
    return (
      <Text color={value ? theme.accent : theme.dim}>
        [{value ? '●' : ' '}] {value ? 'on' : 'off'}
      </Text>
    );
  }
  if (item.kind === 'cycle') {
    return (
      <Text color={theme.fg}>
        <Text color={theme.dim}>◀ </Text>
        {String(value)}
        <Text color={theme.dim}> ▶</Text>
      </Text>
    );
  }
  if (item.kind === 'number') {
    return (
      <Text color={theme.fg}>
        <Text color={theme.dim}>◀ </Text>
        {String(value)}{item.unit || ''}
        <Text color={theme.dim}> ▶</Text>
      </Text>
    );
  }
  if (item.kind === 'computed') {
    // Read-only derived display — e.g. "webhook configured: ◆ yes (hidden)".
    return <Text color={theme.dim}>{item.compute ? item.compute(settings) : String(value)}</Text>;
  }
  return <Text>{String(value)}</Text>;
}

const NOTES_BODY = [
  ['', 'Same product, native terminal.'],
  ['', 'Built on the claude CLI (one subprocess per slot, stream-json wire)'],
  ['', 'rendered with ink (React for terminals).'],
  ['',  ''],
  ['Session management · save/restore', ''],
  ['',           'mc autosaves every live session to ~/.config/claude-mc/sessions.json.'],
  ['',           'After a restart, choose ONE of these three verbs:'],
  ['',           ''],
  [':resume-all',         'restart the sessions that were open at last close'],
  [':resume <slot ...>',  'restore specific slots — e.g. `:resume 1 3 5`'],
  [':history [n]',        'VIEW-ONLY browse of last N sessions (NOT restorable; reference only)'],
  [':sessions / :ls',     'list saved sessions for the current bySlot map'],
  [':forget <slot>',      'drop one slot from saved state'],
  ['q  then  y',          'quit mc (sessions auto-save before exit)'],
  ['',           ''],
  ['',           'Auto-resume on launch: toggle `Auto-resume sessions on startup` (GENERAL).'],
  ['',           'History length: tune `Session history limit` (GENERAL · default 20).'],
  ['',  ''],
  ['Session states · card colour key', ''],
  ['',                  'Six canonical states: idle · working · waiting · paused · error · empty.'],
  ['working',           'live tool calls — cyan border'],
  ['waiting · needs input', 'awaiting approval — yellow border (code: status==="waiting")'],
  ['idle',              'attached, no current activity — dim'],
  ['paused',            'held by you (SIGSTOP) — dim'],
  ['error',             'crashed or API failure — red'],
  ['empty',             'free slot — faint dashed'],
  ['',                  ''],
  ['Derived indicators (NOT states)', ''],
  ['STUCK Nm',          'red chip when working/waiting + silent ≥5min — see agent.stuckMin'],
  ['ctx high',          'past warn band — yellow'],
  ['ctx full',          'over threshold (/compact needed) — red'],
  ['focused',           'keyboard target — bright cyan'],
  ['',  ''],
  ['Why a TUI', ''],
  ['',  'Cell grid is law. Borders are characters. Bars are █▉▊▋▌▎▏.'],
  ['',  'Sparklines are ▁▂▃▄▅▆▇█. No glow. No mouse. Always-on, SSH-friendly.'],
];

export default function Settings({ settings, setSettings, onClose, theme, width = 92 }) {
  const [tabIdx, setTabIdx] = useState(0);
  const [rowIdx, setRowIdx] = useState(0);
  const tab = SETTINGS_SCHEMA[tabIdx];
  const isNotes = tab.id === 'notes';

  useEffect(() => setRowIdx(0), [tabIdx]);

  const cycle = (item, dir) => {
    const cur = settings[item.key];
    if (item.kind === 'toggle') {
      setSettings({ ...settings, [item.key]: !cur });
      return;
    }
    if (item.kind === 'cycle') {
      const i = item.options.indexOf(cur);
      const next = item.options[(i + dir + item.options.length) % item.options.length];
      setSettings({ ...settings, [item.key]: next });
      return;
    }
    if (item.kind === 'number') {
      let nv = cur + dir * item.step;
      if (nv < item.min) nv = item.min;
      if (nv > item.max) nv = item.max;
      setSettings({ ...settings, [item.key]: nv });
    }
  };

  useInput((input, key) => {
    if (key.escape || input === ',') { onClose(); return; }
    if (key.tab) {
      const dir = key.shift ? -1 : 1;
      setTabIdx(i => (i + dir + SETTINGS_SCHEMA.length) % SETTINGS_SCHEMA.length);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const i = parseInt(input, 10) - 1;
      if (i < SETTINGS_SCHEMA.length) setTabIdx(i);
      return;
    }
    if (key.leftArrow || input === 'h') {
      if (isNotes) {
        setTabIdx(i => (i - 1 + SETTINGS_SCHEMA.length) % SETTINGS_SCHEMA.length);
        return;
      }
      if (rowIdx < tab.items.length) cycle(tab.items[rowIdx], -1);
      return;
    }
    if (key.rightArrow || input === 'l') {
      if (isNotes) {
        setTabIdx(i => (i + 1) % SETTINGS_SCHEMA.length);
        return;
      }
      if (rowIdx < tab.items.length) cycle(tab.items[rowIdx], 1);
      return;
    }
    if (key.downArrow || input === 'j') {
      if (!isNotes) setRowIdx(i => Math.min(tab.items.length - 1, i + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      if (!isNotes) setRowIdx(i => Math.max(0, i - 1));
      return;
    }
    if (key.return || input === ' ') {
      if (!isNotes && rowIdx < tab.items.length) cycle(tab.items[rowIdx], 1);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text color={theme.accent}>⚙ SETTINGS</Text>
      {/* Tabs */}
      <Box marginTop={1}>
        {SETTINGS_SCHEMA.map((t, i) => (
          <Box key={t.id} marginRight={2}>
            <Text color={i === tabIdx ? theme.accent : theme.dim}>
              [{i + 1}] {t.title}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {isNotes ? (
          NOTES_BODY.map(([k, v], i) => (
            <Box key={i}>
              {k && <Text color={theme.accent}>{k}  </Text>}
              <Text color={theme.dim}>{v}</Text>
            </Box>
          ))
        ) : (
          tab.items.map((item, i) => {
            const on = i === rowIdx;
            return (
              <Box key={item.key} flexDirection="column">
                <Box>
                  <Text color={on ? theme.accent : theme.faint}>{on ? '▶ ' : '  '}</Text>
                  <Text color={on ? theme.accent : theme.fg}>{item.label}</Text>
                  <Box flexGrow={1} />
                  {valueText(item, settings[item.key], theme, settings)}
                </Box>
                {on && item.desc && (
                  <Box paddingLeft={4}>
                    <Text color={theme.dim}>{item.desc}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          <Text color={theme.accent}>↑↓</Text> select  <Text color={theme.accent}>←→</Text> change  <Text color={theme.accent}>tab</Text> section  <Text color={theme.accent}>↵</Text> toggle  <Text color={theme.accent}>1–{SETTINGS_SCHEMA.length}</Text> jump  ·  <Text color={theme.accent}>esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}
