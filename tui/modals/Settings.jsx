// tui/modals/Settings.jsx — btop-style settings menu.
//
// Tabs across the top (GENERAL · LAYOUT · COLORS · ALERTS · SAFETY · NOTES),
// rows in the body, footer with key hints. Tab / 1-9 switch tabs; arrows nav
// rows; ←/→ change values; ↵/space toggle. Esc closes.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
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

export default function Settings({ settings, setSettings, onClose, theme, width = 92, rows }) {
  const { stdout } = useStdout();
  const [tabIdx, setTabIdx] = useState(0);
  const [rowIdx, setRowIdx] = useState(0);
  // 0408/I6: the body used to render every row of the active tab, so on a
  // short terminal (80×24) the modal outgrew the screen, Ink shrank the
  // column, and rows overlapped or vanished. Window the body the way
  // Help.jsx does: a FIXED height + overflow hidden, scrolled to follow the
  // selection. `rows` is a render seam for fixed-size tests; live renders
  // read the real terminal height.
  const termRows = rows ?? (stdout?.rows || 24);
  // Chrome outside the body: App wrapper padding (2) + FeedbackStrip (2) +
  // StatusBar (1) + this modal's border (2) + padding (2) + title (1) +
  // tabs row with margin (2) + body margin (1) + footer with margin (2) = 15.
  const capacity = Math.max(3, termRows - 15);
  const tab = SETTINGS_SCHEMA[tabIdx];
  const isNotes = tab.id === 'notes';
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => { setRowIdx(0); setScrollTop(0); }, [tabIdx]);

  // Item tabs: one row per item, plus one desc row under the selection —
  // so at most (capacity - 1) items fit. Keep the selection in the window.
  const maxItems = Math.max(1, capacity - 1);
  useEffect(() => {
    if (isNotes) return;
    setScrollTop(top => {
      if (rowIdx < top) return rowIdx;
      if (rowIdx >= top + maxItems) return rowIdx - maxItems + 1;
      return Math.min(top, Math.max(0, tab.items.length - maxItems));
    });
  }, [rowIdx, maxItems, isNotes, tab]);

  const cycle = (item, dir) => {
    const cur = settings[item.key];
    if (item.kind === 'toggle') {
      setSettings({ ...settings, [item.key]: !cur });
      return;
    }
    if (item.kind === 'cycle') {
      // options may be a function (live list — e.g. the model catalog grows
      // when the probe discovers a new claude model). Resolve per keypress.
      const opts = typeof item.options === 'function' ? item.options() : item.options;
      const i = opts.indexOf(cur);
      const next = opts[(i + dir + opts.length) % opts.length];
      setSettings({ ...settings, [item.key]: next });
      return;
    }
    if (item.kind === 'number') {
      let nv = cur + dir * item.step;
      // min/max are optional bounds. A null/undefined bound means "unbounded"
      // on that side — e.g. ctxThreshold has no upper cap (set arbitrarily high
      // for large-context models). Guarding on `!= null` keeps 0 as a valid bound.
      if (item.min != null && nv < item.min) nv = item.min;
      if (item.max != null && nv > item.max) nv = item.max;
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
      else setScrollTop(t => Math.min(Math.max(0, NOTES_BODY.length - capacity), t + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      if (!isNotes) setRowIdx(i => Math.max(0, i - 1));
      else setScrollTop(t => Math.max(0, t - 1));
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
      {/* Tabs — one row, never wrapped: at narrow widths Yoga used to squeeze
          the labels into garbage ("GENER AYOUT OLORS"). Overflowing tabs clip
          instead; number keys still reach them. */}
      <Box marginTop={1} flexWrap="nowrap" overflow="hidden">
        {SETTINGS_SCHEMA.map((t, i) => (
          <Box key={t.id} marginRight={2} flexShrink={0}>
            <Text color={i === tabIdx ? theme.accent : theme.dim}>
              [{i + 1}] {t.title}
            </Text>
          </Box>
        ))}
      </Box>
      {/* Body — FIXED height + overflow hidden + scroll window (Help.jsx
          pattern). A miscount clips; it never overlaps or drops rows. */}
      <Box marginTop={1} flexDirection="column" height={capacity} overflow="hidden" flexShrink={0}>
        {isNotes ? (
          NOTES_BODY.slice(scrollTop, scrollTop + capacity).map(([k, v], i) => (
            <Box key={i + scrollTop} flexWrap="nowrap">
              {k && <Text color={theme.accent} wrap="truncate">{k}  </Text>}
              <Text color={theme.dim} wrap="truncate">{v}</Text>
            </Box>
          ))
        ) : (
          tab.items.slice(scrollTop, scrollTop + maxItems).map((item, off) => {
            const i = scrollTop + off;
            const on = i === rowIdx;
            return (
              <Box key={item.key} flexDirection="column">
                <Box flexWrap="nowrap">
                  <Text color={on ? theme.accent : theme.faint}>{on ? '▶ ' : '  '}</Text>
                  <Text color={on ? theme.accent : theme.fg} wrap="truncate">{item.label}</Text>
                  <Box flexGrow={1} />
                  <Box flexShrink={0}>{valueText(item, settings[item.key], theme, settings)}</Box>
                </Box>
                {on && item.desc && (
                  <Box paddingLeft={4}>
                    <Text color={theme.dim} wrap="truncate">{item.desc}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim} wrap="truncate">
          <Text color={theme.accent}>↑↓</Text> select  <Text color={theme.accent}>←→</Text> change  <Text color={theme.accent}>tab</Text> section  <Text color={theme.accent}>↵</Text> toggle  <Text color={theme.accent}>1–{SETTINGS_SCHEMA.length}</Text> jump  ·  <Text color={theme.accent}>esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}
