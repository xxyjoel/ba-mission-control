// tui/Header.jsx — top status strip (tmux/btop status line equivalent).
//
// Live fleet counters + over-threshold indicator + session timer + clock.
// Each segment is separated by a faint │, matching the design.
//
// Narrow-terminal priority: brand → session timer → UTC clock → ops counts.
// Session/UTC used to sit at the trailing edge and got clipped first when the
// window shrank; they are identity for "how long have I been here / what time
// is it" so they stay early and flexShrink={0}.

import React from 'react';
import { Box, Text } from 'ink';
import { fmtK } from './lib/format.js';

function Seg({ children, theme, last }) {
  // flexShrink={0}: keep each segment at its content width. Without this
  // Yoga squeezes cells when the row's natural width exceeds the terminal,
  // and the inner <Text> (default wrap) then breaks onto a second line —
  // the mangled "claude-mission-cont / ol", "statu / NOMINAL" fragments.
  return (
    <>
      <Box flexShrink={0}>{children}</Box>
      {!last && <Box flexShrink={0}><Text color={theme.faint}>{' │ '}</Text></Box>}
    </>
  );
}

// 0408/I8: no hard-coded version default — it lied ('v0.2.0' on a 1.1.x
// build). App passes version={versionLine()}; with nothing passed we show
// nothing rather than a stale number.
export default function Header({
  agents, threshold, nowStr, sessionStr, theme, auth, version = '',
  // Kept for API compatibility; subscription identity lives on Aggregate rows
  // (◆ claude / ◆ cursor). Multi-sub header says "all sessions" instead of
  // repeating CC/CUR chips here.
  subscriptions = null,
}) {
  const live = agents.filter(a => a.status !== 'empty');
  const working = live.filter(a => a.status === 'working').length;
  const waiting = live.filter(a => a.status === 'waiting').length;
  const paused  = live.filter(a => a.status === 'paused').length;
  const idle    = live.filter(a => a.status === 'idle').length;
  const errors  = live.filter(a => a.status === 'error').length;
  const over    = live.filter(a => (a.context || 0) >= threshold).length;
  // Sessions that hit a transient api_error in the last 5 min — claude is
  // auto-retrying these (ECONNRESET/502 transport noise), so surface them as
  // "retrying", not "failed", and only when present.
  const RECENT_API_MS = 5 * 60 * 1000;
  const nowMs = Date.now();
  const apiRetrying = live.filter(a => a.lastApiErrorTs && (nowMs - a.lastApiErrorTs) < RECENT_API_MS).length;
  const status  = errors ? 'DEGRADED' : waiting ? 'AWAITING' : 'NOMINAL';
  const statusColor = errors ? theme.red : waiting ? theme.yellow : theme.green;
  const multiSubs = Array.isArray(subscriptions) && subscriptions.length >= 2;

  return (
    <Box flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
      <Seg theme={theme}>
        <Text color={theme.accent}>▶ </Text>
        <Text color={theme.accent}>bluearch-mc </Text>
        <Text color={theme.dim}>{version ? `[${version}]` : ''}</Text>
      </Seg>
      {/* Session + UTC early so they survive a narrow resize. */}
      <Seg theme={theme}>
        <Text color={theme.dim}>session </Text>
        <Text color={theme.accent}>{sessionStr}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>UTC </Text>
        <Text color={theme.fg}>{nowStr}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.green}>█ </Text>
        <Text color={theme.fg}>{multiSubs ? 'all sessions' : `${live.length} sessions`}</Text>
        {multiSubs ? <Text color={theme.dim}> · {live.length}</Text> : null}
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>work </Text>
        <Text color={theme.accent}>{working}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>wait </Text>
        <Text color={theme.yellow}>{waiting}</Text>
      </Seg>
      {paused > 0 && (
        <Seg theme={theme}>
          <Text color={theme.dim}>paused </Text>
          <Text color={theme.fg}>{paused}</Text>
        </Seg>
      )}
      {idle > 0 && (
        <Seg theme={theme}>
          <Text color={theme.dim}>idle </Text>
          <Text color={theme.fg}>{idle}</Text>
        </Seg>
      )}
      <Seg theme={theme}>
        <Text color={theme.dim}>err </Text>
        <Text color={theme.red}>{errors}</Text>
      </Seg>
      {apiRetrying > 0 && (
        <Seg theme={theme}>
          <Text color={theme.dim}>api </Text>
          <Text color={theme.yellow}>⚠{apiRetrying} retrying</Text>
        </Seg>
      )}
      {/* Hide when nothing is live — "ctx≥600k 0/0" is noise. */}
      {live.length > 0 && (
        <Seg theme={theme}>
          <Text color={theme.dim}>ctx≥{fmtK(threshold)} </Text>
          <Text color={over ? theme.yellow : theme.fg}>{over}/{live.length}</Text>
        </Seg>
      )}
      <Seg theme={theme} last={multiSubs || !auth}>
        <Text color={theme.dim}>status </Text>
        <Text color={statusColor}>{status}</Text>
      </Seg>
      <Box flexGrow={1} />
      {!multiSubs && auth ? (
        <Seg theme={theme} last>
          <Text color={auth.ok ? theme.green : theme.red}>{auth.ok ? '◆ ' : '✕ '}</Text>
          <Text color={auth.ok ? theme.fg : theme.red}>
            {auth.ok
              ? (auth.email || auth.method || 'authed')
              : 'not signed in'}
          </Text>
          {auth.ok && auth.subscription && (
            <Text color={theme.dim}> · {auth.subscription}</Text>
          )}
        </Seg>
      ) : null}
    </Box>
  );
}
