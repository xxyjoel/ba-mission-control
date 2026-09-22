// tui/modals/Settings.jsx — btop-style settings menu.
//
// Tabs across the top (GENERAL · LAYOUT · … · SUBSCRIPTIONS · NOTES), rows in
// the body, footer with key hints. Tab / 1-9 switch tabs; arrows nav rows;
// ←/→ change values; ↵/space toggle or run an action row. Esc closes.
//
// SUBSCRIPTIONS rows read each provider's auth state through `ctx.status(id)`.
// The probes run once per mount, the first time that tab is shown — never at
// boot and never per render.

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { SETTINGS_SCHEMA } from '../lib/settings.js';
import { listProviders } from '../../server/providers/index.mjs';

const LOGOUT_TIMEOUT_MS = 15000;

// argv form only: bin() is user-controlled (CURSOR_AGENT_BIN / CLAUDE_BIN).
function defaultLogout(provider) {
  return new Promise((resolve, reject) => {
    execFile(provider.bin(), provider.logoutArgv, { timeout: LOGOUT_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

async function probeProvider(p) {
  const bin = basename(String(p.bin?.() || p.id));
  let installed;
  try { installed = await p.probeInstalled(); } catch { installed = null; }
  if (!installed?.ok) return { state: 'not-installed', bin };
  let auth;
  try { auth = await p.probeAuth(); } catch (e) { auth = { ok: false, error: e?.message || String(e) }; }
  if (auth?.ok) return { state: 'connected', email: auth.email || null, plan: auth.plan || null, bin };
  return { state: 'disconnected', bin, error: auth?.error || null };
}

function valueText(item, value, theme, settings, ctx) {
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
        {item.format ? item.format(value) : String(value)}
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
    return <Text color={theme.dim}>{item.compute ? item.compute(settings, ctx) : String(value)}</Text>;
  }
  if (item.kind === 'action') {
    const hint = item.hint ? item.hint(settings, ctx) : '';
    return (
      <Text color={theme.dim}>
        {item.compute ? item.compute(settings, ctx) : ''}
        {hint ? <Text color={theme.accent}>  {hint}</Text> : null}
      </Text>
    );
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

export default function Settings({
  settings, setSettings, onClose, theme, width = 92, rows,
  // SUBSCRIPTIONS seams. `providers` defaults to the real registry; tests pass
  // fakes with canned probe results. onConnect(id) is App's cue to open the
  // login PTY; onProbed(id, status) lets App cache what the tab learned.
  providers = listProviders(), onConnect, onDisconnected, onProbed,
  runLogout = defaultLogout, initialTab,
}) {
  const { stdout } = useStdout();
  const [tabIdx, setTabIdx] = useState(() => Math.max(0, SETTINGS_SCHEMA.findIndex(t => t.id === initialTab)));
  const [rowIdx, setRowIdx] = useState(0);
  const [subStatus, setSubStatus] = useState({});
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null); // provider id awaiting a y/n disconnect
  const probedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
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
  useEffect(() => { setNotice(null); }, [tabIdx, rowIdx]);

  // The claude probe is a synchronous execFileSync; deferring it one macrotask
  // lets the 'checking…' frame paint first.
  const probe = (p) => {
    setSubStatus(s => ({ ...s, [p.id]: { state: 'checking', bin: basename(String(p.bin?.() || p.id)) } }));
    setTimeout(async () => {
      const st = await probeProvider(p);
      if (!mountedRef.current) return;
      setSubStatus(s => ({ ...s, [p.id]: st }));
      onProbed?.(p.id, st);
    }, 0);
  };

  useEffect(() => {
    if (tab.id !== 'subscriptions' || probedRef.current) return;
    probedRef.current = true;
    for (const p of providers) probe(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  const ctx = {
    status: (id) => subStatus[id],
    connect: (id) => onConnect?.(id),
    disconnect: (id) => setConfirm(id),
    notice: setNotice,
  };

  const disconnect = async (id) => {
    setConfirm(null);
    const p = providers.find(x => x.id === id);
    if (!p) return;
    setNotice(`disconnecting ${p.label}…`);
    try {
      await runLogout(p);
    } catch (e) {
      if (mountedRef.current) setNotice(`✕ ${p.label} logout failed: ${String(e?.message || e).split('\n')[0]}`);
      probe(p);
      return;
    }
    if (!mountedRef.current) return;
    setNotice(null);
    onDisconnected?.(id);
    probe(p);
  };

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
      const refusal = item.guard ? item.guard(!cur, ctx) : null;
      if (refusal) { setNotice(refusal); return; }
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
    if (confirm) {
      if (input === 'y' || input === 'Y') disconnect(confirm);
      else if (input === 'n' || input === 'N' || key.escape) setConfirm(null);
      return;
    }
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
      if (isNotes || rowIdx >= tab.items.length) return;
      const item = tab.items[rowIdx];
      if (item.kind === 'action') { item.run?.(ctx); return; }
      cycle(item, 1);
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
          instead; number keys still reach them.
          TODO(settings-tabstrip): at the default 92-col width the strip clips
          after [6], so FEEDBACK, SUBSCRIPTIONS and NOTES never show their label
          even when active — scroll the strip to keep the active tab in view. */}
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
                  <Box flexShrink={0}>{valueText(item, settings[item.key], theme, settings, ctx)}</Box>
                </Box>
                {on && confirm && (
                  <Box paddingLeft={4}>
                    <Text color={theme.yellow} wrap="truncate">disconnect {providers.find(p => p.id === confirm)?.label || confirm}? y/n</Text>
                  </Box>
                )}
                {on && !confirm && (notice || item.desc) && (
                  <Box paddingLeft={4}>
                    <Text color={notice ? theme.yellow : theme.dim} wrap="truncate">{notice || item.desc}</Text>
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
