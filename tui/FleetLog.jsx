// tui/FleetLog.jsx — bottom pane: aggregated activity stream across all agents.
//
// Equivalent to `tail -f` over the fleet — most recent at the bottom. We derive
// it from each agent's tail array (server agents push there on every tool
// call / assistant turn / error). Lines are tagged with timestamp, slot, name,
// and a glyph keyed to event kind.

import React from 'react';
import { Box, Text } from 'ink';
import { fmtClock, trunc, humanize, padCol } from './lib/format.js';

// SECURITY: EVERY kind routes through humanize() before render. It strips
// terminal escape / OSC / C0 control sequences — asst/user/bcast text comes
// straight from the untrusted `claude` stream, so raw escapes (e.g. OSC-52
// clipboard writes, screen clears) would otherwise reach the host terminal
// from this passive fleet view, no zoom required. humanize() also collapses
// raw file paths / UUIDs / JSON payloads so the scan surfaces signal, not noise.

function glyphForKind(k) {
  if (k === 'tool')  return '▸';
  if (k === 'asst')  return '●';
  if (k === 'user')  return '›';
  if (k === 'err')   return '✕';
  if (k === 'bcast') return '⌘';
  return '∙';
}
function colorForKind(k, theme) {
  if (k === 'tool')  return theme.accent;
  if (k === 'asst')  return theme.white;
  if (k === 'user')  return theme.yellow;
  if (k === 'err')   return theme.red;
  if (k === 'bcast') return theme.magenta;
  return theme.dim;
}

// Kinds that survive the 'narrative' mode filter — what a human reads to
// follow what claude is actually saying back. Tools/sys/think/user/note are
// dropped; errors and broadcasts stay because they're load-bearing signal.
const NARRATIVE_KINDS = new Set(['asst', 'err', 'bcast']);

// Merge all agents' tails into one chronological list. Each entry retains the
// originating agentId/slot/name so the row can render its prefix. In
// 'narrative' mode, non-narrative kinds are filtered AND empty-text asst
// entries (tool-only turns) are dropped so we don't render blank rows.
export function deriveFleetLog(agents, maxLines = 12, mode = 'all') {
  const out = [];
  let seq = 0;
  for (const a of agents) {
    if (a.status === 'empty' || !a.tail) continue;
    for (const l of a.tail) {
      if (mode === 'narrative') {
        if (!NARRATIVE_KINDS.has(l.kind)) continue;
        if (l.kind === 'asst' && !(l.preview || l.text || '').trim()) continue;
      }
      out.push({ ...l, agentId: a.id, slot: a.slot, name: a.name, _seq: seq++ });
    }
  }
  // 0028: stable order — primary by timestamp, secondary by insertion sequence
  // (agent order then tail position). Equal-ts entries must never reshuffle
  // frame-to-frame, which would read as flicker. (V8's sort is already stable,
  // but the explicit tiebreak makes it engine-independent and self-documenting.)
  out.sort((x, y) => (x.ts || 0) - (y.ts || 0) || x._seq - y._seq);
  return out.slice(-Math.max(4, maxLines));
}

// 0022: per-row text budget from the available terminal width minus the fixed
// prefix columns (clock 9 + slot 5 + name 21 + glyph 2 + slack ≈ 40), instead
// of a hardcoded 90. Falls back to 90 when no width is supplied (legacy
// callers). Exported so the width-aware behavior is unit-testable.
export function fleetLogTextBudget(width = 0) {
  return width > 0 ? Math.max(20, width - 40) : 90;
}

export default function FleetLog({ log, focusedId, theme, maxLines = 12, mode = 'all', width = 0, requestedLines = 0 }) {
  // Render EXACTLY the budget the caller allocated. This was
  // Math.max(4, maxLines), which rendered four rows even when the layout had
  // computed room for fewer (or none) — so on a short terminal the log pushed
  // the whole frame past the last screen row, Ink could no longer erase its
  // previous frame, and the view tore and scrolled. The caller owns the budget
  // (computeGridLayout.dynamicFleetLogLines); this component must not override
  // it upward.
  const rows = maxLines > 0 ? log.slice(-maxLines) : [];
  const textBudget = fleetLogTextBudget(width);

  return (
    // 0388: no flexGrow/minHeight — the log takes exactly its rows so the
    // Settings line count is authoritative; App.jsx's spacer absorbs slack.
    <Box flexDirection="column" paddingX={1}>
      {/* Header pinned to ONE row (0408/R4): FLEETLOG_HEAD_H budgets exactly 1,
          but under 90 cols the clamp note + narrative tag wrapped it to two and
          pushed the whole fleet frame past the last screen row. The label is
          flexShrink={0}; the informational tags truncate; height=1 +
          overflow=hidden clips anything that still tries to wrap. The clamp
          note is the short `· 8/12` form — the count pair is the signal. */}
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={theme.accent}>▸ FLEET LOG</Text>
        </Box>
        <Text color={theme.dim} wrap="truncate"> · {rows.length} events</Text>
        {/* Say so when the terminal cannot honour the Settings line count.
            The clamp was silent, which read as "I set 30 lines and get 8" —
            the number in Settings is a ceiling, and the terminal's height is
            what actually decides. */}
        {requestedLines > maxLines && (
          <Text color={theme.faint} wrap="truncate"> · {maxLines}/{requestedLines}</Text>
        )}
        {mode === 'narrative' && <Text color={theme.yellow} wrap="truncate"> · narrative</Text>}
        <Box flexGrow={1} />
        <Text color={theme.faint} wrap="truncate">[ tail -f mc://fleet ]</Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((l, i) => {
          const focused = l.agentId === focusedId;
          const slotCol = focused ? theme.accent : l.agentId ? theme.dim : theme.faint;
          const nameCol = focused ? theme.accent : theme.dim;
          const slotTxt = '[' + String(l.slot ?? '?').padStart(2, ' ') + ']';
          // 0024/0026: grapheme-safe pad (never split a multi-byte name) and a
          // '—' fallback to match Card.jsx (not the literal 'unknown').
          const nameTxt = padCol(l.name || '—', 20);
          return (
            // height=1 + overflow=hidden: a log row is a ONE-row slot by
            // contract — even if some future field slips past humanize()'s
            // newline collapse, the row clips instead of growing the frame.
            <Box key={i} height={1} overflow="hidden">
              <Text color={theme.faint}>{fmtClock(l.ts || Date.now())} </Text>
              <Text color={slotCol}>{slotTxt} </Text>
              <Text color={nameCol}>{nameTxt} </Text>
              <Text color={colorForKind(l.kind, theme)}>{glyphForKind(l.kind)} </Text>
              {/* 0030: show the tool prefix for tool AND err rows; an err's
                  prefix is red to match its body, not dim. 0408/S3: the tool
                  NAME comes off the untrusted stream too (an MCP server picks
                  it) — humanize + trunc before it can reach the terminal or
                  wrap this one-row slot. */}
              {l.tool && (l.kind === 'tool' || l.kind === 'err') &&
                <Text color={l.kind === 'err' ? theme.red : theme.dim}>{trunc(humanize(l.tool), 28)} </Text>}
              <Text color={l.kind === 'err' ? theme.red : l.kind === 'sys' ? theme.dim : theme.fg} wrap="truncate">
                {trunc(humanize(l.preview || l.text || ''), textBudget)}
              </Text>
            </Box>
          );
        })}
        {rows.length === 0 && (
          <Text color={theme.faint}>(no events yet — launch a session with N)</Text>
        )}
      </Box>
    </Box>
  );
}
