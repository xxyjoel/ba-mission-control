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
import { barCells, fmtK, fmtMoney, fmtDuration, humanize } from '../lib/format.js';
import { readProjectHealth, healthColor } from '../lib/projectHealth.js';
import PtyPane from '../zoom/PtyPane.jsx';
import { classifyZoomKey } from '../zoom/zoomKeys.js';

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

export default function Zoom({
  agent, threshold, onClose, onCyclePerm,
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
    if (classifyZoomKey(input, key) === 'EXIT') onClose?.();
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
  const ctxPct = model ? (agent.context || 0) / model.maxCtx : 0;
  const overT = (agent.context || 0) >= threshold;
  const nearT = (agent.context || 0) >= threshold * 0.85;

  const sCol = agent.status === 'working' ? theme.accent
             : agent.status === 'waiting' ? theme.yellow
             : agent.status === 'error'   ? theme.red : theme.dim;
  const statusWord  = agent.status === 'waiting' ? 'NEEDS INPUT' : (agent.status || '').toUpperCase();
  const statusGlyph = STATUS_GLYPH[agent.status] || '·';
  // Session Health for this project (cached read; null until first scored turn).
  const health = readProjectHealth(agent.cwd);

  const barW = 40;
  const cells = barCells({ value: ctxPct, width: barW, threshFrac: model ? threshold / model.maxCtx : 0.75 });

  // Inner width inside the bordered modal: width − 2 (border) − 4 (paddingX).
  const innerW = Math.max(20, (width || 100) - 6);

  const tools = useMemo(() => summariseTools(agent.tail), [agent.tail]);
  const todos = agent.todos || [];
  // Cap the rendered todo rows so a runaway plan doesn't crowd the PTY.
  // 8 covers the common case; the rest collapse into a "+N more" tag.
  const MAX_TODOS_SHOWN = 8;
  const todoRows = todos.length > 0
    ? 1 /* header */ + Math.min(todos.length, MAX_TODOS_SHOWN) + (todos.length > MAX_TODOS_SHOWN ? 1 : 0)
    : 0;

  // Compute the PTY pane body size. The Zoom modal does NOT own the
  // whole terminal screen — App.jsx wraps it in paddingY=2 plus a
  // FeedbackStrip and StatusBar below, so the actual vertical room
  // is termRows - 4. The caller passes that in as `height`; we fall
  // back to stdout.rows-4 if it wasn't provided.
  // Per-region breakdown (matches the JSX below top-to-bottom):
  //   2 border + 2 padY + 1 header + (1 marginTop + 1 compact-stats)
  //   + (1 marginTop + 1 PTY body marginTop is part of bodyRows)
  //   + 1 footer = 10 always-on rows.
  // Optional panels each add their own marginTop=1 wrapper, so
  // statsExpanded is +7 (not +6) and showTools is +2 (not +1).
  // todos panel adds 1 marginTop on top of todoRows (header + items + overflow).
  const availableRows = height || Math.max(10, (stdout?.rows || 50) - 4);
  const fixedRows =
    10 +
    (statsExpanded ? 7 : 0) +
    (showTools ? 2 : 0) +
    (todoRows > 0 ? todoRows + 1 : 0);
  const bodyRows = Math.max(6, availableRows - fixedRows);
  const bodyCols = innerW;

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      {/* ── Header: slot · name · model · branch · perm · status ── */}
      <Box>
        <Text color={theme.accent}>[{agent.slot}] </Text>
        <Text color={theme.accent}>{agent.name}  </Text>
        {model && (
          <Text color={modelColor(modelId, theme)}>[{model.label}]  </Text>
        )}
        {/* Only warn when claude's resolved cli model is unknown to the catalog
            (genuine drift). An in-catalog /model switch updates the [label]
            above instead of showing a warning. */}
        {unknownResolved && (
          <>
            <Text color={theme.yellow}>⚠ resolved </Text>
            <Text color={theme.fg}>{agent.resolvedModel}  </Text>
          </>
        )}
        <Text color={theme.dim}>⎇ </Text>
        <Text color={theme.fg}>{agent.branch}</Text>
        {(agent.dirty || 0) > 0
          ? <Text color={theme.yellow}> +{agent.dirty}</Text>
          : <Text color={theme.green}> ●clean</Text>}
        {agent.ahead  > 0 && <Text color={theme.accent}> ↑{agent.ahead}</Text>}
        {agent.behind > 0 && <Text color={theme.yellow}> ↓{agent.behind}</Text>}
        <Box flexGrow={1} />
        {claudeUpdate && (
          <>
            <Text color={theme.faint}>⬆ update{claudeUpdate.version ? ` ${claudeUpdate.version}` : ''}</Text>
            <Text color={theme.faint}>  · </Text>
          </>
        )}
        {agent.permissionMode && (
          <>
            <Text color={agent.permissionMode === 'bypassPermissions' ? theme.red : agent.permissionMode === 'plan' ? theme.cyan : theme.dim}>
              perm: {agent.permissionMode}
            </Text>
            <Text color={theme.faint}>  · </Text>
          </>
        )}
        <Text color={sCol}>{statusGlyph} {statusWord}</Text>
      </Box>

      {/* ── Compact stats line (always visible) ── */}
      <Box marginTop={1}>
        <Text color={theme.dim}>ctx </Text>
        <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{fmtK(agent.context || 0)}</Text>
        <Text color={theme.dim}>/{fmtK(model ? model.maxCtx : 0)}  </Text>
        <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{(ctxPct * 100).toFixed(0)}%</Text>
        <Text color={theme.faint}>  ·  </Text>
        <Text color={theme.dim}>in </Text>
        <Text color={theme.fg}>{fmtK(agent.tokensIn || 0)}↓</Text>
        <Text color={theme.dim}>  out </Text>
        <Text color={theme.fg}>{fmtK(agent.tokensOut || 0)}↑</Text>
        <Text color={theme.dim}>  cache </Text>
        <Text color={theme.faint}>{fmtK(agent.tokensCacheRead || 0)}</Text>
        <Text color={theme.faint}>  ·  </Text>
        <Text color={theme.fg}>{fmtMoney(agent.costSession || 0)}</Text>
        <Text color={theme.dim}> (wk </Text>
        <Text color={theme.fg}>{fmtMoney(agent.costWeek || 0)}</Text>
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
      {todos.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Box>
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
          {todos.slice(0, MAX_TODOS_SHOWN).map((t, i) => {
            const isDone = t.status === 'completed';
            const isActive = t.status === 'in_progress';
            const glyph = isDone ? '✓' : isActive ? '▸' : '○';
            const glyphColor = isDone ? theme.green : isActive ? theme.accent : theme.faint;
            const textColor = isDone ? theme.dim : isActive ? theme.fg : theme.dim;
            const display = isActive && t.activeForm ? t.activeForm : t.content;
            return (
              <Box key={i}>
                <Text color={glyphColor}>{glyph} </Text>
                <Text color={textColor} strikethrough={isDone} bold={isActive} wrap="truncate">
                  {display}
                </Text>
              </Box>
            );
          })}
          {todos.length > MAX_TODOS_SHOWN && (
            <Text color={theme.faint}>  …+{todos.length - MAX_TODOS_SHOWN} more</Text>
          )}
        </Box>
      )}

      {/* ── Ctrl+T: per-tool usage summary (mc chrome, not claude's). ── */}
      {showTools && (
        <Box marginTop={1}>
          <Text color={theme.accent}>tools · </Text>
          {tools.length === 0 ? (
            <Text color={theme.faint}>(no tools used yet)</Text>
          ) : tools.slice(0, 8).map((t, i) => (
            <React.Fragment key={t.name}>
              {i > 0 && <Text color={theme.faint}> · </Text>}
              <Text color={theme.fg}>{t.name}</Text>
              <Text color={theme.dim}>×{t.count}</Text>
            </React.Fragment>
          ))}
          {tools.length > 8 && (
            <Text color={theme.faint}>  +{tools.length - 8} more</Text>
          )}
        </Box>
      )}

      {/* ── Ctrl+S: expanded stats panel (CONTEXT + USAGE columns) ── */}
      {statsExpanded && (
        <Box marginTop={1}>
          <Box flexDirection="column" width="50%">
            <Text color={theme.accent}>CONTEXT</Text>
            <Box>
              <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>{fmtK(agent.context || 0)}</Text>
              <Text color={theme.dim}> / {fmtK(model ? model.maxCtx : 0)}  </Text>
              <Text color={overT ? theme.red : nearT ? theme.yellow : theme.accent}>· {(ctxPct * 100).toFixed(0)}%</Text>
            </Box>
            <Box>
              {cells.map((c, i) => (
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
              <Text color={theme.fg}>{fmtMoney(agent.costSession || 0)}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>cost · week    </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{fmtMoney(agent.costWeek || 0)}</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>turns          </Text>
              <Box flexGrow={1} />
              <Text color={theme.fg}>{agent.turnCount || 0}</Text>
              <Text color={theme.dim}> · {agent.messageCount || 0} msg</Text>
            </Box>
            <Box>
              <Text color={theme.dim}>in {agent.status || 'idle'}     </Text>
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
          cycler) — is forwarded to the embedded claude session. */}
      <Box>
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
        <Box flexGrow={1} />
        <Text color={theme.faint}>Esc · ⇧⇥ → claude</Text>
      </Box>
    </Box>
  );
}
