// tui/Aggregate.jsx — tokens-in/out, cost session/week + budget bar, fleet tpm.
//
// Single line of tagged values. Cost-week shows a 24-cell eighths-block bar
// against a fixed $250 cap (matches the design — should be a setting later).

import React from 'react';
import { Box, Text } from 'ink';
import { fmtK, fmtMoney, barCells, sparkLine } from './lib/format.js';

const WEEK_CAP = 250;
const BAR_W    = 24;
const SPARK_W  = 22;

function Cell({ children, theme, last }) {
  // flexShrink={0}: same fix as Header's Seg — keep each cell at content
  // width so Yoga can't squeeze it and force the inner <Text> to wrap.
  return (
    <>
      <Box flexShrink={0}>{children}</Box>
      {!last && <Box flexShrink={0}><Text color={theme.faint}>{' │ '}</Text></Box>}
    </>
  );
}

// Color a percentage-used value: green when low, yellow at 60+, red at 85+.
function pctColor(pct, theme) {
  if (pct >= 85) return theme.red;
  if (pct >= 60) return theme.yellow;
  return theme.accent;
}

export default function Aggregate({ agents, fleetTpm, aggSpark, theme, usage, fmtReset }) {
  const live = agents.filter(a => a.status !== 'empty');
  const tIn  = live.reduce((s, a) => s + (a.tokensIn  || 0), 0);
  const tOut = live.reduce((s, a) => s + (a.tokensOut || 0), 0);
  const cSes = live.reduce((s, a) => s + (a.costSession || 0), 0);
  const cWk  = live.reduce((s, a) => s + (a.costWeek    || 0), 0);
  const pct  = Math.min(1, cWk / WEEK_CAP);
  const cells = barCells({ value: pct, width: BAR_W });
  const sparks = sparkLine(aggSpark, SPARK_W);
  const weekHot = pct > 0.8;

  return (
    <Box flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
      <Cell theme={theme}>
        <Text color={theme.dim}>tok·in </Text>
        <Text color={theme.accent}>{fmtK(tIn)}↓</Text>
      </Cell>
      <Cell theme={theme}>
        <Text color={theme.dim}>tok·out </Text>
        <Text color={theme.brBlue}>{fmtK(tOut)}↑</Text>
      </Cell>
      <Cell theme={theme}>
        <Text color={theme.dim}>cost·session </Text>
        <Text color={theme.fg}>{fmtMoney(cSes)}</Text>
      </Cell>
      <Cell theme={theme}>
        <Text color={theme.dim}>cost·week </Text>
        <Text color={weekHot ? theme.yellow : theme.fg}>{fmtMoney(cWk)}</Text>
        <Text color={theme.dim}>/${WEEK_CAP} </Text>
        <Text color={theme.faint}>[</Text>
        {cells.map((c, i) => (
          <Text key={i} color={c.kind === 'full' ? theme.accent : c.kind === 'partial' ? theme.brBlue : theme.faint}>{c.char}</Text>
        ))}
        <Text color={theme.faint}>]</Text>
      </Cell>
      {/* Plan-side usage (the real /usage numbers — read from
          ~/.claude/abtop-rate-limits.json). Skipped when claude hasn't
          written the file yet. */}
      {usage && (
        <Cell theme={theme}>
          <Text color={theme.dim}>plan </Text>
          <Text color={pctColor(usage.fiveHour.usedPct, theme)}>5h {usage.fiveHour.usedPct.toFixed(0)}%</Text>
          <Text color={theme.faint}>↻{fmtReset(usage.fiveHour.resetsAt) || '?'} </Text>
          <Text color={theme.faint}> · </Text>
          <Text color={pctColor(usage.sevenDay.usedPct, theme)}>7d {usage.sevenDay.usedPct.toFixed(0)}%</Text>
          <Text color={theme.faint}>↻{fmtReset(usage.sevenDay.resetsAt) || '?'}</Text>
        </Cell>
      )}
      <Cell theme={theme} last>
        <Text color={theme.dim}>fleet </Text>
        <Text color={theme.accent}>{fmtK(fleetTpm)} t/min  </Text>
        <Text color={theme.accent}>{sparks}</Text>
      </Cell>
    </Box>
  );
}
