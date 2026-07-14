// tui/Header.jsx — top status strip (tmux/btop status line equivalent).
//
// Live fleet counters + over-threshold indicator + session timer + clock.
// Each segment is separated by a faint │, matching the design.

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

export default function Header({ agents, threshold, nowStr, sessionStr, theme, auth, version = 'v0.2.0' }) {
  const live = agents.filter(a => a.status !== 'empty');
  const working = live.filter(a => a.status === 'working').length;
  const waiting = live.filter(a => a.status === 'waiting').length;
  const paused  = live.filter(a => a.status === 'paused').length;
  const idle    = live.filter(a => a.status === 'idle').length;
  const errors  = live.filter(a => a.status === 'error').length;
  const over    = live.filter(a => a.context >= threshold).length;
  // Sessions that hit a transient api_error in the last 5 min — claude is
  // auto-retrying these (ECONNRESET/502 transport noise), so surface them as
  // "retrying", not "failed", and only when present.
  const RECENT_API_MS = 5 * 60 * 1000;
  const nowMs = Date.now();
  const apiRetrying = live.filter(a => a.lastApiErrorTs && (nowMs - a.lastApiErrorTs) < RECENT_API_MS).length;
  const status  = errors ? 'DEGRADED' : waiting ? 'AWAITING' : 'NOMINAL';
  const statusColor = errors ? theme.red : waiting ? theme.yellow : theme.green;

  return (
    <Box flexDirection="row" paddingX={1} flexWrap="nowrap" overflow="hidden">
      <Seg theme={theme}>
        <Text color={theme.accent}>▶ </Text>
        <Text color={theme.accent}>claude-mission-control </Text>
        <Text color={theme.dim}>{version}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.green}>█ </Text>
        <Text color={theme.fg}>{live.length} sessions</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>work </Text>
        <Text color={theme.accent}>{working}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>wait </Text>
        <Text color={theme.yellow}>{waiting}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>paused </Text>
        <Text color={theme.fg}>{paused}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>idle </Text>
        <Text color={theme.fg}>{idle}</Text>
      </Seg>
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
      <Seg theme={theme}>
        <Text color={theme.dim}>over {fmtK(threshold)} </Text>
        <Text color={over ? theme.yellow : theme.fg}>{over}/{live.length}</Text>
      </Seg>
      <Seg theme={theme}>
        <Text color={theme.dim}>status </Text>
        <Text color={statusColor}>{status}</Text>
      </Seg>
      <Box flexGrow={1} />
      {auth && (
        <Seg theme={theme}>
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
      )}
      <Seg theme={theme}>
        <Text color={theme.dim}>session </Text>
        <Text color={theme.accent}>{sessionStr}</Text>
      </Seg>
      <Seg theme={theme} last>
        <Text color={theme.dim}>UTC </Text>
        <Text color={theme.fg}>{nowStr}</Text>
      </Seg>
    </Box>
  );
}
