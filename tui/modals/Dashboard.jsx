// tui/modals/Dashboard.jsx — single-screen fleet overview.
//
// Replaces "scan 10 cards visually" with a sortable table when triage
// matters more than per-slot detail. Built for the question "which of
// my 10 agents needs me right now?" — sort by status to surface
// waiting/error first, by cost to surface the spenders, by ctx % to
// surface the about-to-compact ones.
//
// Trigger: `D` from the main grid, or `:dash` from the command bar.
// Keys inside the dashboard:
//   ↑ ↓    move highlight (focuses the slot — closing dashboard preserves it)
//   S      cycle the sort column (slot → status → ctx → tpm → cost → age)
//   R      toggle sort direction
//   ↵      zoom the highlighted slot
//   K      kill the highlighted slot (still arm-then-confirm at App level)
//   D / esc close
//
// The dashboard is a READ overlay — it doesn't fork the snapshot. The
// table refreshes via the same fleet subscription that powers everything
// else, so a long-running session's age / cost ticks live in front of
// the user without leaving the view.

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { MODELS, modelColor } from '../lib/models.js';
import { fmtK, fmtMoney, fmtDuration, trunc } from '../lib/format.js';

// Ordered list of sortable columns — `S` cycles through these.
const SORT_KEYS = ['slot', 'status', 'ctx', 'tpm', 'cost', 'age'];

// Status sort priority: things that need user attention bubble first,
// then live work, then idle states. Used when sortKey === 'status'.
const STATUS_PRIORITY = {
  error: 0,
  waiting: 1,
  working: 2,
  paused: 3,
  idle: 4,
  empty: 5,
};

// Compact status pill used in the table — same vocabulary as Card but
// single-token width so columns align across rows.
const STATUS_LABEL = {
  working: '●WORK',
  waiting: '◉WAIT',
  idle:    '○IDLE',
  paused:  '⏸PAUS',
  error:   '✕ERR ',
  empty:   ' EMP ',
};

function statusColor(s, theme) {
  if (s === 'error')   return theme.red;
  if (s === 'waiting') return theme.yellow;
  if (s === 'working') return theme.accent;
  if (s === 'paused')  return theme.faint;
  return theme.dim;
}

// Compact model badge — fixed-width so the column doesn't jitter.
function modelBadge(id) {
  if (id?.startsWith('opus'))   return 'OPS';
  if (id?.startsWith('sonnet')) return 'SON';
  if (id?.startsWith('haiku'))  return 'HAI';
  return '—  ';
}

export default function Dashboard({
  agents,
  threshold,
  theme,
  weekCost = 0,
  dayCost = 0,
  budget = 0,
  onClose,
  onZoom,
  onFocus,
  initialSlot = 1,
  width = 100,
}) {
  const [sortKey, setSortKey] = useState('slot');
  const [reverse, setReverse] = useState(false);
  const [hi, setHi] = useState(initialSlot);

  const live = useMemo(() => agents.filter(a => a.status !== 'empty'), [agents]);

  const sorted = useMemo(() => {
    const cmp = (a, b) => {
      switch (sortKey) {
        case 'status': return (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
        case 'ctx': {
          const ma = MODELS[a.model], mb = MODELS[b.model];
          const pa = ma ? (a.context || 0) / ma.maxCtx : 0;
          const pb = mb ? (b.context || 0) / mb.maxCtx : 0;
          return pb - pa; // ctx desc — fuller first
        }
        case 'tpm': {
          const ra = (a.spark || []).slice(-3).reduce((s, x) => s + x, 0) / 3;
          const rb = (b.spark || []).slice(-3).reduce((s, x) => s + x, 0) / 3;
          return rb - ra; // rate desc
        }
        case 'cost': return (b.costSession || 0) - (a.costSession || 0); // cost desc
        case 'age': {
          // Oldest first (longest running). Slots that never entered
          // working state get a 0 timestamp → fall to the bottom.
          const ta = a.workingStartTs || Number.MAX_SAFE_INTEGER;
          const tb = b.workingStartTs || Number.MAX_SAFE_INTEGER;
          return ta - tb;
        }
        default: return a.slot - b.slot;
      }
    };
    const out = [...live].sort(cmp);
    return reverse ? out.reverse() : out;
  }, [live, sortKey, reverse]);

  // Keep the highlight valid as the list re-sorts. If the previously-
  // highlighted slot is still in the list we keep it; otherwise we
  // anchor to the top row.
  const hiInList = sorted.find(a => a.slot === hi) ? hi : (sorted[0]?.slot || initialSlot);

  useInput((input, key) => {
    if (key.escape || input === 'd' || input === 'D') { onClose?.(); return; }
    if (input === 's' || input === 'S') {
      setSortKey(k => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length]);
      return;
    }
    if (input === 'r' || input === 'R') { setReverse(v => !v); return; }
    if (key.upArrow || key.downArrow) {
      const i = sorted.findIndex(a => a.slot === hiInList);
      const next = key.upArrow ? Math.max(0, i - 1) : Math.min(sorted.length - 1, i + 1);
      const nextSlot = sorted[next]?.slot;
      if (nextSlot) { setHi(nextSlot); onFocus?.(nextSlot); }
      return;
    }
    if (key.return) {
      const t = sorted.find(a => a.slot === hiInList);
      if (t) onZoom?.(t.id);
      return;
    }
  });

  // Column header — show sort arrow next to the active key.
  const colHeader = (label, key, w) => (
    <Text color={sortKey === key ? theme.accent : theme.dim} bold={sortKey === key}>
      {label.padEnd(w)}
    </Text>
  );

  const now = Date.now();

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box>
        <Text color={theme.accent}>━━ FLEET DASHBOARD </Text>
        <Text color={theme.dim}>· {sorted.length} live</Text>
        <Box flexGrow={1} />
        <Text color={theme.faint}>sort: </Text>
        <Text color={theme.accent}>{sortKey}</Text>
        <Text color={theme.faint}> {reverse ? '↑' : '↓'}</Text>
        <Text color={theme.dim}>  ·  </Text>
        <Text color={theme.faint}>day </Text>
        <Text color={budget > 0 && dayCost >= budget ? theme.red : theme.fg}>{fmtMoney(dayCost)}</Text>
        {budget > 0 && (
          <>
            <Text color={theme.faint}> / </Text>
            <Text color={theme.dim}>{fmtMoney(budget)}</Text>
          </>
        )}
        <Text color={theme.dim}>  ·  </Text>
        <Text color={theme.faint}>week </Text>
        <Text color={theme.fg}>{fmtMoney(weekCost)}</Text>
      </Box>

      <Box marginTop={1}>
        {colHeader('SLOT', 'slot', 6)}
        <Text color={theme.dim}>{'NAME'.padEnd(18)}</Text>
        <Text color={theme.dim}>{'MODEL'.padEnd(6)}</Text>
        {colHeader('STATUS', 'status', 8)}
        {colHeader('CTX%', 'ctx', 7)}
        {colHeader('TOK/M', 'tpm', 8)}
        {colHeader('COST', 'cost', 9)}
        {colHeader('AGE', 'age', 8)}
        <Text color={theme.dim}>ACTIVITY</Text>
      </Box>

      {sorted.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.faint}>  fleet empty — launch a session with </Text>
          <Text color={theme.accent}>n</Text>
        </Box>
      ) : sorted.map(a => {
        const sel = a.slot === hiInList;
        const m = MODELS[a.model];
        const ctxPct = m ? Math.round(((a.context || 0) / m.maxCtx) * 100) : 0;
        const sp = a.spark || [];
        const tpm = sp.length ? Math.round(sp.slice(-3).reduce((s, x) => s + x, 0) / 3 * 8000) : 0;
        const ageMs = a.workingStartTs ? now - a.workingStartTs : 0;
        const ageStr = a.workingStartTs ? fmtDuration(ageMs) : '—';
        return (
          <Box key={a.id}>
            <Text color={sel ? theme.accent : theme.faint}>{sel ? '▶ ' : '  '}</Text>
            <Text color={sel ? theme.accent : theme.dim}>{`[${a.slot}]`.padEnd(4)}</Text>
            <Text color={sel ? theme.fg : theme.dim} bold={sel}>{trunc(a.name || '—', 17).padEnd(18)}</Text>
            <Text color={modelColor(a.model, theme)}>{modelBadge(a.model).padEnd(6)}</Text>
            <Text color={statusColor(a.status, theme)}>{(STATUS_LABEL[a.status] || a.status).padEnd(8)}</Text>
            <Text color={ctxPct >= 90 ? theme.red : ctxPct >= 80 ? theme.yellow : theme.fg}>{`${ctxPct}%`.padEnd(7)}</Text>
            <Text color={theme.fg}>{fmtK(tpm).padEnd(8)}</Text>
            <Text color={theme.fg}>{fmtMoney(a.costSession || 0).padEnd(9)}</Text>
            <Text color={theme.faint}>{ageStr.padEnd(8)}</Text>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text color={theme.faint} wrap="truncate">{a.activity || ''}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          <Text color={theme.accent}>↑↓</Text> select  ·  <Text color={theme.accent}>↵</Text> zoom  ·  <Text color={theme.accent}>S</Text> sort  ·  <Text color={theme.accent}>R</Text> reverse  ·  <Text color={theme.accent}>D</Text>/<Text color={theme.accent}>esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}
