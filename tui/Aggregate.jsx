// tui/Aggregate.jsx — tokens-in/out, cost session/week + budget bar, fleet tpm.
//
// Claude-only: one blended line (0420 seamless — unchanged metrics).
// Multi-subscription: one segment per provider with that provider's own
// meters. Never sum Claude + Cursor into a single tok/cost/plan figure —
// their baselines do not match (rolling 5h/7d vs billing-cycle, and Cursor
// may be unmetered until usage sync is on).

import React from 'react';
import { Box, Text } from 'ink';
import { fmtK, fmtMoney, fmtMoneyMeasured, fmtKMeasured, barCells, sparkLine } from './lib/format.js';
import { staleBackgroundSessions } from '../server/claudeSessions.mjs';

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

// Sum only measured values. null/undefined skipped — never coerced to 0 —
// so a Cursor-unknown card cannot fake a cheap fleet total.
function sumMeasured(agents, key) {
  let sum = null;
  for (const a of agents) {
    const v = a[key];
    if (v == null || !Number.isFinite(v)) continue;
    sum = (sum ?? 0) + v;
  }
  return sum;
}

function providerOf(a) {
  return a?.provider || 'claude';
}

function ClaudePlanCells({ usage, fmtReset, theme }) {
  if (!usage) return null;
  const five = usage.fiveHour?.usedPct;
  const seven = usage.sevenDay?.usedPct;
  const hasFive = five != null && Number.isFinite(five);
  const hasSeven = seven != null && Number.isFinite(seven);
  if (!hasFive && !hasSeven) return <Text color={theme.faint}>plan —</Text>;
  return (
    <>
      <Text color={theme.dim}>plan </Text>
      {hasFive && (
        <>
          <Text color={pctColor(five, theme)}>5h {five.toFixed(0)}%</Text>
          <Text color={theme.faint}>{` ↻${fmtReset(usage.fiveHour.resetsAt) || '?'}`}</Text>
        </>
      )}
      {hasFive && hasSeven && <Text color={theme.faint}>{' · '}</Text>}
      {hasSeven && (
        <>
          <Text color={pctColor(seven, theme)}>7d {seven.toFixed(0)}%</Text>
          <Text color={theme.faint}>{` ↻${fmtReset(usage.sevenDay.resetsAt) || '?'}`}</Text>
        </>
      )}
    </>
  );
}

function WeekBar({ weekCost, theme }) {
  const cWk = weekCost || 0;
  const pct = Math.min(1, cWk / WEEK_CAP);
  const cells = barCells({ value: pct, width: BAR_W });
  const weekHot = pct > 0.8;
  return (
    <>
      <Text color={theme.dim}>cost·week </Text>
      <Text color={weekHot ? theme.yellow : theme.fg}>{fmtMoney(cWk)}</Text>
      <Text color={theme.dim}>/${WEEK_CAP} </Text>
      <Text color={theme.faint}>[</Text>
      {cells.map((c, i) => (
        <Text key={i} color={c.kind === 'full' ? theme.accent : c.kind === 'partial' ? theme.brBlue : theme.faint}>{c.char}</Text>
      ))}
      <Text color={theme.faint}>]</Text>
    </>
  );
}

function BgCell({ background, theme }) {
  const stale = background ? (staleBackgroundSessions({ background, attached: [] }, { days: 1 }) || []) : [];
  const bgStale = stale.length;
  const bgOldestDays = bgStale > 0
    ? Math.floor(Math.max(...stale.map((e) => (Date.now() - e.startedAt) / 86400000)))
    : 0;
  return (
    <Cell theme={theme}>
      <Text color={theme.dim}>bg </Text>
      {background === null
        ? <Text color={theme.faint}>?</Text>
        : <>
            <Text color={bgStale > 0 ? theme.yellow : theme.fg}>{background.length}</Text>
            {bgStale > 0 && <Text color={theme.yellow}> · {bgOldestDays}d idle</Text>}
          </>}
    </Cell>
  );
}

// Classic single-line Aggregate (Claude-only / one connected subscription).
function AggregateClassic({ agents, fleetTpm, aggSpark, theme, usage, fmtReset, weekCost = 0, background }) {
  const live = agents.filter(a => a.status !== 'empty');
  const tIn  = live.reduce((s, a) => s + (a.tokensIn  || 0), 0);
  const tOut = live.reduce((s, a) => s + (a.tokensOut || 0), 0);
  const cSes = live.reduce((s, a) => s + (a.costSession || 0), 0);
  const sparks = sparkLine(aggSpark, SPARK_W);

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
      {background !== undefined && <BgCell background={background} theme={theme} />}
      <Cell theme={theme}>
        <Text color={theme.dim}>cost·session </Text>
        <Text color={theme.fg}>{fmtMoney(cSes)}</Text>
      </Cell>
      <Cell theme={theme}>
        <WeekBar weekCost={weekCost} theme={theme} />
      </Cell>
      {usage && (
        <Cell theme={theme}>
          <ClaudePlanCells usage={usage} fmtReset={fmtReset} theme={theme} />
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

function ClaudeSegment({ agents, theme, usage, fmtReset, weekCost, background, last, connected = true, detail = null }) {
  const live = agents.filter(a => a.status !== 'empty');
  const tIn = sumMeasured(live, 'tokensIn');
  const tOut = sumMeasured(live, 'tokensOut');
  const cSes = sumMeasured(live, 'costSession');
  return (
    <Cell theme={theme} last={last}>
      <Text color={connected ? theme.green : theme.red}>{connected ? '◆ ' : '✕ '}</Text>
      <Text color={theme.accent}>claude</Text>
      {detail ? <Text color={theme.dim}>{` · ${detail}`}</Text> : null}
      <Text color={theme.faint}>{' · '}</Text>
      {usage
        ? <ClaudePlanCells usage={usage} fmtReset={fmtReset} theme={theme} />
        : <Text color={theme.faint}>plan —</Text>}
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.fg}>{fmtMoneyMeasured(cSes)}</Text>
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.accent}>{fmtKMeasured(tIn)}↓</Text>
      <Text color={theme.faint}> </Text>
      <Text color={theme.brBlue}>{fmtKMeasured(tOut)}↑</Text>
      <Text color={theme.faint}>{' · '}</Text>
      <WeekBar weekCost={weekCost} theme={theme} />
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.dim}>{live.length} live</Text>
      {background !== undefined && (
        <>
          <Text color={theme.faint}>{' · '}</Text>
          <Text color={theme.dim}>bg </Text>
          {background === null
            ? <Text color={theme.faint}>?</Text>
            : <Text color={theme.fg}>{background.length}</Text>}
        </>
      )}
    </Cell>
  );
}

function CursorSegment({ agents, theme, usageSyncOn, last, connected = true, detail = null }) {
  const live = agents.filter(a => a.status !== 'empty');
  const tIn = sumMeasured(live, 'tokensIn');
  const tOut = sumMeasured(live, 'tokensOut');
  const cSes = sumMeasured(live, 'costSession');
  // Honest gaps: billing-cycle plan % needs GetCurrentPeriodUsage (Phase 6
  // follow-up). Until then — never invent Claude's 5h/7d for Cursor.
  const planLabel = !connected
    ? (detail || 'not signed in')
    : (usageSyncOn ? 'plan —' : 'sync off');
  return (
    <Cell theme={theme} last={last}>
      <Text color={connected ? theme.green : theme.red}>{connected ? '◆ ' : '✕ '}</Text>
      <Text color={theme.accent}>cursor</Text>
      {connected && detail ? <Text color={theme.dim}>{` · ${detail}`}</Text> : null}
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.faint}>{planLabel}</Text>
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.fg}>{fmtMoneyMeasured(cSes)}</Text>
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.accent}>{fmtKMeasured(tIn)}↓</Text>
      <Text color={theme.faint}> </Text>
      <Text color={theme.brBlue}>{fmtKMeasured(tOut)}↑</Text>
      <Text color={theme.faint}>{' · '}</Text>
      <Text color={theme.dim}>{live.length} live</Text>
    </Cell>
  );
}

function AggregateMulti({
  agents, theme, usage, fmtReset, weekCost = 0, background,
  providers, cursorUsageSync = false,
}) {
  const byId = new Map();
  for (const p of providers) byId.set(p.id, p);
  const ids = providers.map(p => p.id);
  // One row per subscription — side-by-side segments overflow a typical
  // 80–120 col terminal and Ink's overflow:hidden would clip Cursor entirely.
  return (
    <Box flexDirection="column">
      {ids.map((id) => {
        const slice = agents.filter(a => providerOf(a) === id);
        if (id === 'claude') {
          return (
            <Box key={id} flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
              <ClaudeSegment
                agents={slice}
                theme={theme}
                usage={usage}
                fmtReset={fmtReset}
                weekCost={weekCost}
                background={background}
                connected={byId.get(id)?.ok !== false}
                detail={byId.get(id)?.detail || null}
                last
              />
            </Box>
          );
        }
        if (id === 'cursor') {
          return (
            <Box key={id} flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
              <CursorSegment
                agents={slice}
                theme={theme}
                usageSyncOn={!!cursorUsageSync}
                connected={byId.get(id)?.ok !== false}
                detail={byId.get(id)?.detail || null}
                last
              />
            </Box>
          );
        }
        const live = slice.filter(a => a.status !== 'empty');
        const label = byId.get(id)?.short || byId.get(id)?.label || id;
        const connected = byId.get(id)?.ok !== false;
        return (
          <Box key={id} flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
            <Cell theme={theme} last>
              <Text color={connected ? theme.green : theme.red}>{connected ? '◆ ' : '✕ '}</Text>
              <Text color={theme.accent}>{String(label).toLowerCase()} </Text>
              <Text color={theme.faint}>—</Text>
              <Text color={theme.faint}>{' · '}</Text>
              <Text color={theme.dim}>{live.length} live</Text>
            </Cell>
          </Box>
        );
      })}
    </Box>
  );
}

export default function Aggregate({
  agents, fleetTpm, aggSpark, theme, usage, fmtReset, weekCost = 0, background,
  // 0420: when 2+ subscriptions are connected, render per-provider segments.
  providers = null,
  cursorUsageSync = false,
}) {
  const multi = Array.isArray(providers) && providers.length >= 2;
  if (multi) {
    return (
      <AggregateMulti
        agents={agents}
        theme={theme}
        usage={usage}
        fmtReset={fmtReset}
        weekCost={weekCost}
        background={background}
        providers={providers}
        cursorUsageSync={cursorUsageSync}
      />
    );
  }
  return (
    <AggregateClassic
      agents={agents}
      fleetTpm={fleetTpm}
      aggSpark={aggSpark}
      theme={theme}
      usage={usage}
      fmtReset={fmtReset}
      weekCost={weekCost}
      background={background}
    />
  );
}
