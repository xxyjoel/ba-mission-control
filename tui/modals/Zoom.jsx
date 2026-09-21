// tui/modals/Zoom.jsx — focused-session view backed by a real claude PTY.
//
// Layout (top-to-bottom):
//   1. Header row: slot · name · model · branch · perm · status
//   2. Compact stats line: ctx · tokens · cost · usage windows (always visible)
//   3. Open tasks panel: agent.todos from claude's TodoWrite plan (always
//      visible when any todos exist — matches the task tracker the user
//      sees while interacting with claude directly).
//   4. Expanded stats panel: CONTEXT bar + USAGE columns (Ctrl+S, off by default)
//   5. Tools summary line: per-tool counts from this session (Ctrl+T, off by default)
//   6. PTY pane: a real interactive `claude --resume <sid>` child renders here.
//      All typing, scrolling, markdown, syntax highlighting, slash UI, etc.
//      come from claude itself — Mission Control no longer re-renders the
//      stream-json events for the zoomed agent.
//   7. Footer hint: ⌃Q exit · ⌃J newline · ⌃Y scroll · ⌃K tools · ⌃U stats
//
// Why this exists: the prior Zoom modal parsed claude's stream-json
// events and laid them out in Ink. That pipeline had perpetual
// rendering bugs (flicker, wrap glitches, scroll jitter, raw markdown,
// delayed echo) because Ink isn't the renderer claude was built for.
// Rather than chase parity with claude's own rendering, we hand the
// body region to claude itself via node-pty + xterm-headless. See
// .claude/plans/we-are-still-having-parsed-parrot.md.

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { MODELS, modelColor, modelByCli } from '../lib/models.js';
import { barCells, fmtK, fmtMoney, fmtDuration, humanize, trunc, UNKNOWN } from '../lib/format.js';
import { zoomInnerWidth } from '../lib/zoomGeometry.js';
import { readProjectHealth, healthColor, healthScoreText } from '../lib/projectHealth.js';
import PtyPane from '../zoom/PtyPane.jsx';
import { classifyZoomKey } from '../zoom/zoomKeys.js';
import { dlog } from '../lib/debugLog.js';

const STATUS_GLYPH = { working: '●', waiting: '◉', idle: '○', paused: '⏸', error: '✕' };

function pctColor(pct, theme) {
  if (pct >= 85) return theme.red;
  if (pct >= 60) return theme.yellow;
  return theme.accent;
}

// Tally tool usage from the agent's tail for the Ctrl+T summary strip.
// The stream-json agent is SIGSTOP'd while zoom is active, but its
// tail captured everything up to the moment of zoom — that's what we
// summarise here. Returns an array of { name, count } sorted by count.
function summariseTools(tail) {
  const counts = new Map();
  for (const e of tail || []) {
    if (e.kind !== 'tool' || !e.tool) continue;
    counts.set(e.tool, (counts.get(e.tool) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// Drop the `mcp__<server>__` prefix from MCP tool names for the strip — the
// tool half carries the signal, and 8 fully-qualified MCP names wrapped the
// one-row strip into five (0408/R6).
function shortToolName(name) {
  return String(name || '').replace(/^mcp__.+?__/, '');
}

export default function Zoom({
  agent, derived, threshold, onClose, onCyclePerm,
  theme, width = 104, height, usage, fmtReset, weekCost = 0,
  hideUpdateBanner = true,
}) {
  // Ctrl+T → tools summary strip (off by default; off is the default
  // because claude renders its own tool calls inline in the PTY body).
  const [showTools, setShowTools] = useState(false);
  // Ctrl+S → expanded stats panel (off by default; the compact stats
  // line above the PTY pane covers the everyday questions).
  const [statsExpanded, setStatsExpanded] = useState(false);
  // Claude's own "update available" banner, lifted out of the PTY body by
  // PtyPane and shown as a discrete chip on the right of the header instead.
  const [claudeUpdate, setClaudeUpdate] = useState(null);

  const { stdout } = useStdout();

  // Top-level exit fallback. Esc is forwarded to claude by PtyPane (so the
  // user can cancel/back out of claude's own UI), so the zoom exit is Ctrl+Q.
  // This handler is only a backup for when PtyPane isn't focused yet (mid-mount)
  // — it uses the SAME registry as PtyPane so the two can't drift.
  useInput((input, key) => {
    const action = classifyZoomKey(input, key);
    // Trace the fallback handler too: if a Ctrl+Q repro shows this line but the
    // pane's own trace is missing, the pane lost focus; if EXIT classifies here
    // and the modal still doesn't close, the bug is in onClose/render, not input.
    if (action === 'EXIT' || key.ctrl || key.escape) {
      dlog('zoomkey', 'zoom-fallback', { from: 'zoom', action, ctrl: !!key.ctrl, escape: !!key.escape });
    }
    if (action === 'EXIT') onClose?.();
  });

  if (!agent) return null;

  // Effective model = the model claude is CURRENTLY on. A mid-session `/model`
  // switch only updates agent.resolvedModel (the cli id), never agent.model
  // (the launch model) — so prefer the resolved catalog entry and fall back
  // to the launch model. This is what makes the header label, color, and
  // maxCtx track a /model switch instead of showing the stale launch model.
  const resolved = modelByCli(agent.resolvedModel);
  const model = resolved || MODELS[agent.model];
  const modelId = resolved ? resolved.id : agent.model;
  // True only when claude reports a cli model the catalog doesn't know — a
  // genuine drift/unknown model, not an intentional in-catalog /model switch.
  const unknownResolved = agent.resolvedModel && !resolved
    && (!MODELS[agent.model] || agent.resolvedModel !== MODELS[agent.model].cliModel);
  // 0409: an unknown model has no maxCtx, so there is no ctx DENOMINATOR. The
  // old `: 0` rendered the compact stats line as `ctx 142k/0  0%` — a real
  // token count over a fabricated limit, reported as 0% used. Gate every ctx
  // ratio on ctxKnown and print the unknown marker instead.
  const ctxKnown = !!(model && Number.isFinite(model.maxCtx) && model.maxCtx > 0);
  const ctxPct = ctxKnown ? (agent.context || 0) / model.maxCtx : 0;
  const ctxPctText = ctxKnown ? `${(ctxPct * 100).toFixed(0)}%` : `${UNKNOWN}%`;
  const ctxMaxText = ctxKnown ? fmtK(model.maxCtx) : UNKNOWN;
  const overT = (agent.context || 0) >= threshold;
  const nearT = (agent.context || 0) >= threshold * 0.85;

  // 0417: read the DERIVED status, the same value the card shows. `agent` is
  // the live PtyAgent when zoom is opened from the grid, and its `.status` is
  // only the connector's opinion — the hook feed, the approval scrape and the
  // freshness gates are applied in toJSON() and never written back. Falling
  // back to `agent.status` keeps the legacy Agent and the tests working, both
  // of which pass a plain snapshot object as `agent`.
  const status      = derived?.status ?? agent.status;
  const sCol = status === 'working' ? theme.accent
             : status === 'waiting' ? theme.yellow
             : status === 'error'   ? theme.red : theme.dim;
  const statusWord  = status === 'waiting' ? 'NEEDS INPUT' : (status || '').toUpperCase();
  const statusGlyph = STATUS_GLYPH[status] || '·';
  // Session Health for this project (cached read; null until first scored turn).
  const health = readProjectHealth(agent.cwd);

  // Inner width inside the bordered modal — from the SAME helper that sizes
  // the fleet's PTY (0408/R3), so the modal chrome and the PTY body can never
  // disagree about the content width again.
  const innerW = zoomInnerWidth(width || 100);

  // CONTEXT bar width — fits its half-width stats column even on a narrow
  // modal, so the bar can't wrap the panel's fixed-height rows.
  // 0409: threshFrac was `: 0.75` with no known maxCtx — a threshold marker
  // placed three-quarters along a bar with no scale. Omitted now, and the bar
  // itself is suppressed (cells === null) rather than drawn empty, which would
  // read as "0% of the context used".
  const barW = Math.max(10, Math.min(40, Math.floor(innerW / 2) - 4));
  const cells = ctxKnown
    ? barCells({ value: ctxPct, width: barW, threshFrac: threshold / model.maxCtx })
    : null;

  const tools = useMemo(() => summariseTools(agent.tail), [agent.tail]);
  const todos = agent.todos || [];

  // ── Vertical budget (0408/R1+R2) ──────────────────────────────
  // The Zoom modal does NOT own the whole terminal screen — App.jsx wraps it
  // in paddingY=2 plus a FeedbackStrip and StatusBar below. The caller passes
  // the real room in as `height`; we fall back to stdout.rows-4 if it wasn't
  // provided. The contract: NEVER render more rows than `height`. Ink cannot
  // erase a frame taller than the terminal, so one extra row tears the UI.
  //
  // Always-on chrome (matches the JSX below top-to-bottom):
  //   2 border + 2 padY + 1 header + (1 marginTop + 1 compact-stats)
  //   + 1 PTY-body marginTop + 1 footer = 9 rows. Header, compact stats, the
  //   tools strip and the footer are pinned height={1} overflow="hidden" so a
  //   wrap can never grow them past their budgeted row.
  //
  // Optional panels are budgeted from what they ACTUALLY render (the old
  // fixedRows said "stats = 7" while the panel drew 10 plus an unbudgeted
  // ACTIVE AGENTS block — every Ctrl+U overflowed the modal). When the room
  // left for the PTY body would drop below MIN_BODY_ROWS a panel is SHED
  // instead of overflowing, todos first, then tools, then stats; the todo
  // list also shrinks item-by-item to fit its leftover budget.
  const CHROME_ROWS = 9;
  const MIN_BODY_ROWS = 6;
  // 0409: the fallback used to be `(stdout?.rows || 50) - 4` — it fabricated a
  // 50-row terminal whenever the real height was unreadable (non-TTY, rows 0),
  // and Ink cannot erase a frame taller than the screen, so a 50-row assumption
  // on a 24-row terminal tears the whole UI. App.jsx always passes `height`, so
  // this only fires on a non-TTY; degrade to the SMALLEST frame that still
  // renders (chrome + PtyPane's minimum) rather than the roomiest guess. Under-
  // filling a big terminal is recoverable; overflowing a small one is not.
  const realRows = Number.isFinite(stdout?.rows) && stdout.rows > 0 ? stdout.rows - 4 : null;
  const availableRows = height || realRows || (CHROME_ROWS + MIN_BODY_ROWS);
  let panelRoom = Math.max(0, availableRows - CHROME_ROWS - MIN_BODY_ROWS);

  // Stats panel (shed LAST): 1 marginTop + 9 USAGE rows (title + 8 stat rows)
  // + the ACTIVE AGENTS block when sub-agents run (1 marginTop + 1 title + n).
  const nSub = Array.isArray(agent.activeSubagents) ? agent.activeSubagents.length : 0;
  const statsRows = 1 + 9 + (nSub > 0 ? 2 + nSub : 0);
  const renderStats = statsExpanded && statsRows <= panelRoom;
  if (renderStats) panelRoom -= statsRows;

  // Tools strip: 1 marginTop + 1 clipped row.
  const renderTools = showTools && 2 <= panelRoom;
  if (renderTools) panelRoom -= 2;

  // Todos (shed FIRST — they get whatever room is left): 1 marginTop +
  // 1 header + shown items + a "+N more" row when the list is cut. Cap at 8
  // as before, then shrink to the leftover budget.
  const MAX_TODOS_CAP = 8;
  const todoRowsFor = (n) => (n > 0 ? 2 + n + (todos.length > n ? 1 : 0) : 0);
  let todosShown = Math.min(todos.length, MAX_TODOS_CAP);
  while (todosShown > 0 && todoRowsFor(todosShown) > panelRoom) todosShown--;
  const todoPanelRows = todoRowsFor(todosShown);

  const fixedRows = CHROME_ROWS
    + (renderStats ? statsRows : 0)
    + (renderTools ? 2 : 0)
    + todoPanelRows;
  // ≥ MIN_BODY_ROWS by construction whenever availableRows ≥ 15; below that
  // every panel is already shed and the floor is PtyPane's own minimum (5).
  const bodyRows = Math.max(5, availableRows - fixedRows);
  const bodyCols = innerW;

  // ── Header width budget (0408/R6) ─────────────────────────────
  // A 67-char branch or a long name wrapped the header to two rows — an
  // unbudgeted frame row. Pre-truncate both to the room actually left after
  // the fixed chips, the way Card.jsx budgets its title/meta rows. name,
  // branch and resolvedModel come from untrusted session state → humanize().
  const permText = agent.permissionMode ? `perm: ${agent.permissionMode}` : '';
  const updateText = claudeUpdate
    ? `⬆ update${claudeUpdate.version ? ` ${claudeUpdate.version}` : ''}` : '';
  const resolvedText = unknownResolved
    ? trunc(humanize(String(agent.resolvedModel)), 24) : '';
  const gitChipsW = ((agent.dirty || 0) > 0 ? ` +${agent.dirty}`.length : ' ●clean'.length)
    + (agent.ahead > 0 ? ` ↑${agent.ahead}`.length : 0)
    + (agent.behind > 0 ? ` ↓${agent.behind}`.length : 0);
  const rightW = (updateText ? updateText.length + 4 : 0)
    + (permText ? permText.length + 4 : 0)
    + `${statusGlyph} ${statusWord}`.length;
  const nameStr = trunc(humanize(agent.name || '—'), 24);
  const leftFixedW = `[${agent.slot}] `.length + nameStr.length + 2
    + (model ? `[${model.label}]  `.length : 0)
    + (resolvedText ? `⚠ resolved ${resolvedText}  `.length : 0)
    + 2; // '⎇ '
  const branchStr = trunc(humanize(agent.branch || '—'),
    Math.max(3, innerW - leftFixedW - gitChipsW - rightW - 1));

  // Session cost is a ~estimate when the model's pricing row is inherited,
  // not verified (0408/M4) — mark it so it can't pass for a billed figure.
  const costPrefix = model && model.estimatedPricing ? '~' : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      {/* ── Header: slot · name · model · branch · perm · status ──
          Pinned to ONE row (0408/R6): name/branch/resolvedModel are
          pre-truncated to the measured leftover room, the fixed chips sit in
          flexShrink={0} boxes, and height=1 + overflow=hidden clips anything
          that still tries to wrap. */}
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={theme.accent}>[{agent.slot}] </Text>
          <Text color={theme.accent}>{nameStr}  </Text>
          {model && (
            <Text color={modelColor(modelId, theme)}>[{model.label}]  </Text>
          )}
          {/* Only warn when claude's resolved cli model is unknown to the catalog
              (genuine drift). An in-catalog /model switch updates the [label]
              above instead of showing a warning. resolvedText is humanized +
              truncated — the raw id comes from the untrusted stream (0181). */}
          {resolvedText && (
            <>
              <Text color={theme.yellow}>⚠ resolved </Text>
              <Text color={theme.fg}>{resolvedText}  </Text>
            </>
          )}
          <Text color={theme.dim}>⎇ </Text>
          <Text color={theme.fg}>{branchStr}</Text>
          {(agent.dirty || 0) > 0
            ? <Text color={theme.yellow}> +{agent.dirty}</Text>
            : <Text color={theme.green}> ●clean</Text>}
          {agent.ahead  > 0 && <Text color={theme.accent}> ↑{agent.ahead}</Text>}
          {agent.behind > 0 && <Text color={theme.yellow}> ↓{agent.behind}</Text>}
        </Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          {updateText !== '' && (
            <>
              {/* claude's own update notice, lifted out of the PTY body —
                  rendered faint so it reads as ambient chrome (0408/U1). */}
              <Text color={theme.faint}>{updateText}</Text>
              <Text color={theme.faint}>  · </Text>
            </>
          )}
          {agent.permissionMode && (
            <>
              <Text color={agent.permissionMode === 'bypassPermissions' ? theme.red : agent.permissionMode === 'plan' ? theme.cyan : theme.dim}>
                {permText}
              </Text>
              <Text color={theme.faint}>  · </Text>
            </>
          )}
          <Text color={sCol}>{statusGlyph} {statusWord}</Text>
        </Box>
      </Box>

      {/* ── Compact stats line (always visible; pinned to its one budgeted
          row — a narrow modal clips the tail chips instead of wrapping) ── */}
      <Box marginTop={1} height={1} overflow="hidden">
        <Text color={theme.dim}>ctx </Text>
        <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{fmtK(agent.context || 0)}</Text>
        <Text color={theme.dim}>/{ctxMaxText}  </Text>
        <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{ctxPctText}</Text>
        <Text color={theme.faint}>  ·  </Text>
        <Text color={theme.dim}>in </Text>
        <Text color={theme.fg}>{fmtK(agent.tokensIn || 0)}↓</Text>
        <Text color={theme.dim}>  out </Text>
        <Text color={theme.fg}>{fmtK(agent.tokensOut || 0)}↑</Text>
        <Text color={theme.dim}>  cache </Text>
        <Text color={theme.faint}>{fmtK(agent.tokensCacheRead || 0)}</Text>
        <Text color={theme.faint}>  ·  </Text>
        <Text color={theme.fg}>{costPrefix}{fmtMoney(agent.costSession || 0)}</Text>
        <Text color={theme.dim}> (wk </Text>
        <Text color={theme.fg}>{fmtMoney(weekCost || 0)}</Text>
        <Text color={theme.dim}>)</Text>
        {usage && (
          <>
            <Text color={theme.faint}>  ·  </Text>
            <Text color={theme.dim}>5h </Text>
            <Text color={pctColor(usage.fiveHour.usedPct, theme)}>{usage.fiveHour.usedPct.toFixed(0)}%</Text>
            <Text color={theme.dim}>  7d </Text>
            <Text color={pctColor(usage.sevenDay.usedPct, theme)}>{usage.sevenDay.usedPct.toFixed(0)}%</Text>
          </>
        )}
        {health && (
          <>
            <Text color={theme.faint}>  ·  </Text>
            <Text color={theme.dim}>health </Text>
            <Text color={healthColor(health, theme)}>●{health.score.toFixed(0)}{health.arrow}</Text>
            {/* verdictWord is the first token of the verdict string read from
                <cwd>/.project-health/history.jsonl — untrusted, and an escape
                payload carries no whitespace so it survives the tokenizer.
                Sanitize before it reaches the terminal (0181 convention; Card
                dropped this field entirely in 0256, Zoom keeps it humanize()'d). */}
            <Text color={theme.dim}> {humanize(health.verdictWord)}</Text>
          </>
        )}
      </Box>

      {/* ── Open tasks panel (from claude's TodoWrite plan) ──
          Mirrors the task tracker the user sees when talking to claude
          directly. Always visible when any todos exist.
          NOTE: while zoom is active the stream-json sibling is SIGSTOP'd,
          so this list is a snapshot from zoom-entry until the PTY child
          (also a `claude --resume`) exits and the sibling catches up. */}
      {todosShown > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Box height={1} overflow="hidden">
            <Text color={theme.accent}>▸ OPEN TASKS</Text>
            <Text color={theme.faint}>  · </Text>
            <Text color={theme.dim}>
              {todos.filter(t => t.status === 'completed').length}/{todos.length} done
            </Text>
            {todos.some(t => t.status === 'in_progress') && (
              <>
                <Text color={theme.faint}>  · </Text>
                <Text color={theme.accent}>
                  {todos.filter(t => t.status === 'in_progress').length} in progress
                </Text>
              </>
            )}
          </Box>
          {todos.slice(0, todosShown).map((t, i) => {
            const isDone = t.status === 'completed';
            const isActive = t.status === 'in_progress';
            const glyph = isDone ? '✓' : isActive ? '▸' : '○';
            const glyphColor = isDone ? theme.green : isActive ? theme.accent : theme.faint;
            const textColor = isDone ? theme.dim : isActive ? theme.fg : theme.dim;
            // humanize(): todo text comes from claude's TodoWrite input —
            // untrusted, and an embedded newline would grow this one-row slot
            // (0408/R5); escapes must not reach the terminal (0181).
            const display = humanize(isActive && t.activeForm ? t.activeForm : t.content);
            return (
              <Box key={i}>
                <Text color={glyphColor}>{glyph} </Text>
                <Text color={textColor} strikethrough={isDone} bold={isActive} wrap="truncate">
                  {display}
                </Text>
              </Box>
            );
          })}
          {todos.length > todosShown && (
            <Text color={theme.faint}>  …+{todos.length - todosShown} more</Text>
          )}
        </Box>
      )}

      {/* ── Ctrl+K: per-tool usage summary (mc chrome, not claude's).
          Pinned to ONE row (0408/R6): tool names come from the untrusted
          stream — humanized, mcp__server__ prefix dropped, truncated — and
          the strip clips instead of wrapping. ── */}
      {renderTools && (
        <Box marginTop={1} height={1} overflow="hidden">
          <Box flexShrink={0}><Text color={theme.accent}>tools · </Text></Box>
          {tools.length === 0 ? (
            <Text color={theme.faint}>(no tools used yet)</Text>
          ) : tools.slice(0, 8).map((t, i) => (
            <React.Fragment key={t.name}>
              {i > 0 && <Text color={theme.faint}> · </Text>}
              <Text color={theme.fg}>{trunc(humanize(shortToolName(t.name)), 24)}</Text>
              <Text color={theme.dim}>×{t.count}</Text>
            </React.Fragment>
          ))}
          {tools.length > 8 && (
            <Text color={theme.faint}>  +{tools.length - 8} more</Text>
          )}
        </Box>
      )}

      {/* ── Ctrl+U: expanded stats panel (CONTEXT + USAGE columns).
          Height is pinned to the exact row count the vertical budget charged
          for it (statsRows minus its marginTop), so an internal wrap on a
          narrow modal clips instead of growing the frame (0408/R1). ── */}
      {renderStats && (
        <Box marginTop={1} height={statsRows - 1} overflow="hidden">
          <Box flexDirection="column" width="50%">
            <Text color={theme.accent}>CONTEXT</Text>
            <Box>
              <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{fmtK(agent.context || 0)}</Text>
              <Text color={theme.dim}> / {ctxKnown ? fmtK(model.maxCtx) : UNKNOWN}  </Text>
              <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>· {ctxPctText}</Text>
            </Box>
            <Box>
              {/* 0409 left this unguarded: the unknown-value pass set `cells`
                  to null when the model's context limit is unknown, so opening
                  the stats panel on an unknown model threw
                  "Cannot read properties of null (reading 'map')" and blanked
                  the whole zoom view. A bar we cannot draw is simply absent. */}
              {(cells || []).map((c, i) => (
                <Text key={i} color={
                  c.kind === 'thresh'  ? theme.yellow :
                  c.kind === 'full'    ? (overT ? theme.red : nearT ? theme.yellow : theme.accent) :
                  c.kind === 'partial' ? theme.brBlue : theme.faint
                }>{c.char}</Text>
              ))}
            </Box>
            <Text color={theme.dim}>threshold marker · │ at {fmtK(threshold)}</Text>
          </Box>
          <Box flexDirection="column" width="50%" paddingLeft={2}>
            <Text color={theme.accent}>USAGE · SESSION</Text>
            <Box>
              <Text color={theme.dim}>tokens in  </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{fmtK(agent.tokensIn || 0)}↓</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>tokens out </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{fmtK(agent.tokensOut || 0)}↑</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>cache read </Text>
              <Box flexGrow={1} />
              <Text color={theme.faint}>{fmtK(agent.tokensCacheRead || 0)}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>cost · session </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{costPrefix}{fmtMoney(agent.costSession || 0)}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>cost · week    </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{fmtMoney(weekCost || 0)}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>turns          </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{agent.turnCount || 0}</Text>
              <Text color={theme.dim}> · {agent.messageCount || 0} msg</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>in {status || 'idle'}     </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{agent.stateSince ? fmtDuration(Date.now() - agent.stateSince) : '00:00:00'}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>session age    </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{agent.spawnedAt ? fmtDuration(Date.now() - agent.spawnedAt) : '00:00:00'}</Text>
            </Box>
            {Array.isArray(agent.activeSubagents) && agent.activeSubagents.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.accent}>ACTIVE AGENTS ({agent.activeSubagents.length})</Text>
                {agent.activeSubagents.map((s, i) => (
                  <Box key={i}>
                    <Text color={theme.fg}>⋔ {humanize(String(s.label || s.type || 'agent')).slice(0, 24)}</Text>
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{fmtDuration(s.elapsedMs || 0)}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* ── PTY body: real interactive claude --resume <sid> renders here ── */}
      <Box marginTop={1}>
        <PtyPane
          agent={agent}
          width={bodyCols}
          height={bodyRows}
          focus={true}
          onClose={onClose}
          onToggleTools={() => setShowTools(s => !s)}
          onToggleStats={() => setStatsExpanded(s => !s)}
          onCyclePerm={onCyclePerm}
          theme={theme}
          hideUpdateBanner={hideUpdateBanner}
          onClaudeUpdate={setClaudeUpdate}
        />
      </Box>

      {/* ── Footer hint row ──
          Keys mirror tui/zoom/zoomKeys.js (the single source of truth):
          ⌃Q exit · ⌃J newline · ⌃Y scroll · ⌃K tools · ⌃U stats. Everything
          else — including Esc (interrupt claude) and ⇧⇥ (claude's own perm
          cycler) — is forwarded to the embedded claude session.
          height=1 + overflow=hidden: on a narrow modal the row clips instead
          of wrapping into a second, unbudgeted frame row (0408/R1). */}
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={theme.accent} bold>⌃Q</Text>
          <Text color={theme.dim}> exit  ·  </Text>
          <Text color={theme.accent}>⌃J</Text>
          <Text color={theme.dim}> newline  ·  </Text>
          <Text color={theme.accent}>⌃Y</Text>
          <Text color={theme.dim}> scroll  ·  </Text>
          <Text color={theme.accent}>⌃K</Text>
          <Text color={theme.dim}> tools{showTools ? ' (on)' : ''}  ·  </Text>
          <Text color={theme.accent}>⌃U</Text>
          <Text color={theme.dim}> stats{statsExpanded ? ' (on)' : ''}</Text>
        </Box>
        <Box flexGrow={1} />
        <Text color={theme.faint} wrap="truncate">Esc · ⇧⇥ → claude</Text>
      </Box>
    </Box>
  );
}
