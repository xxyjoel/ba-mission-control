// tui/Card.jsx — one agent tile in the 5×2 grid.
//
// Anatomy — a PURE STATS tile (no session text; fixed shape). Top to bottom:
//   ┏━[N]━ name ━━━━━━ ●STATUS ━┓
//   ┃ MODEL  ⎇ branch +dirty ↑a ↓b┃
//   ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
//   ┃ ctx ████░░│░░ 142k 71%      ┃
//   ┃ tok/min  3.2k  ▁▂▃▅▇█       ┃
//   ┃            (flex spacer)     ┃
//   ┃ ▸ 3/7 ██████░░ check back    ┃   (triage: burndown + next action)
//   ┃ ↳ current in-progress item   ┃
//   ┃ ●78↑ ⟳12 340✉ ⧗2h14m    ●3m ┃   (health dot + session vitals)
//   ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
//   ┃ $0.42 ses  $12.30 wk  38k↓  ┃
//   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// The session tail + activity line were removed (2026-07-06): they were the
// only variable-height rows and produced unpredictable card shapes. Every
// row is now fixed-height with pre-truncated text.
//
// Border color = status. Focused overrides everything else (bright cyan).
//
// Ink's flexbox handles alignment for us — no char-counting tricks required.
// borderStyle prop maps to Ink's built-in border presets; ctx-full / error
// switch the border color independently of the focus state.

import React from 'react';
import { Box, Text } from 'ink';
import { MODELS, modelColor, modelByCli } from './lib/models.js';
import { barCells, sparkLine, fmtK, fmtMoney, trunc, humanize, fmtDurShort } from './lib/format.js';
import { readProjectHealth, healthColor } from './lib/projectHealth.js';

const STATUS_GLYPH = { working: '●', waiting: '◉', idle: '○', paused: '⏸', error: '✕', empty: '+' };

function statusColor(status, theme, isApproval) {
  if (isApproval)           return theme.red;
  if (status === 'working') return theme.accent;
  if (status === 'waiting') return theme.yellow;
  if (status === 'error')   return theme.red;
  return theme.dim;
}

// Look back through the recent tail for an approval-kind awaiting prompt.
// A separate kind ('approval') exists alongside binary / single-select /
// multi-select because permission requests have a different visual
// urgency: silently dead-ending an approval breaks the user's workflow,
// so the card surfaces a louder red `APPROVE?` marker so the slot is
// findable even when the user is zoomed into another agent.
function pendingApproval(agent) {
  if (agent.status !== 'waiting') return null;
  const tail = agent.tail || [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i];
    if (l && l.awaitingPrompt && l.awaitingPrompt.kind === 'approval') return l.awaitingPrompt;
    if (l && l.awaitingPrompt) return null; // newer prompt of a different kind wins
  }
  return null;
}

// Map our border style preference to Ink's border presets. "rounded" → 'round',
// "sharp" → 'single', "double" → 'double'. Focused always switches to bold.
function inkBorderStyle(borderStyle, focused) {
  if (focused) return 'bold';
  if (borderStyle === 'sharp')  return 'single';
  if (borderStyle === 'double') return 'double';
  return 'round';
}

function cardBorderColor({ status, focused, ctxOver, ctxNear, approval, theme }) {
  if (focused) return theme.accent;
  if (approval) return theme.red; // approval-pending wins over generic waiting/working
  if (status === 'error') return theme.red;
  if (ctxOver) return theme.red;
  if (status === 'waiting') return theme.yellow;
  if (ctxNear) return theme.yellow;
  if (status === 'working') return theme.cyan;
  return theme.faint;
}

// TODO(cleanup): `showTools` is now unused — the card no longer renders the
// session tail, so the tool/sys/think filter it gated is gone. App.jsx still
// passes it; drop the prop there and here in a follow-up.
export default function Card({ agent, focused, threshold, warnPct, borderStyle, showTools = false, theme, cardWidth }) {
  const isEmpty = agent.status === 'empty';

  // ── Empty slot ────────────────────────────────────────────
  if (isEmpty) {
    return (
      <Box
        flexDirection="column"
        borderStyle={focused ? 'bold' : 'round'}
        borderColor={focused ? theme.accent : theme.faint}
        paddingX={1}
        width="100%"
        height={11}
        overflow="hidden"
      >
        <Box>
          <Text color={focused ? theme.accent : theme.dim}>[{agent.slot}] </Text>
          <Text color={theme.faint}>EMPTY</Text>
        </Box>
        <Box flexGrow={1} />
        <Box justifyContent="center">
          <Text color={theme.dim}>+ NEW SESSION</Text>
        </Box>
        <Box justifyContent="center">
          <Text color={theme.faint}>press </Text>
          <Text color={theme.accent}>n</Text>
          <Text color={theme.faint}> or </Text>
          <Text color={theme.accent}>↵</Text>
        </Box>
        <Box flexGrow={1} />
        <Box justifyContent="center">
          <Text color={theme.faint}>slot [{agent.slot}]</Text>
        </Box>
      </Box>
    );
  }

  // ── Live slot ─────────────────────────────────────────────
  // Effective model = what claude is CURRENTLY on. A mid-session `/model`
  // switch only updates agent.resolvedModel (cli id), not agent.model (launch
  // model), so prefer the resolved catalog entry — keeps the card label,
  // color and ctx% denominator in sync with the switch. See modelByCli().
  const resolved = modelByCli(agent.resolvedModel);
  const model = resolved || MODELS[agent.model];
  const modelId = resolved ? resolved.id : agent.model;
  const ctxPct = model ? (agent.context || 0) / model.maxCtx : 0;
  const overT = (agent.context || 0) >= threshold;
  const nearT = (agent.context || 0) >= threshold * ((warnPct || 85) / 100);

  // Session Health (from the per-project benchmarking Stop hook). Cheap:
  // readProjectHealth caches per cwd behind a TTL + mtime check. null until
  // that project has logged its first scored turn.
  const health      = readProjectHealth(agent.cwd);
  const approval    = pendingApproval(agent);
  const sCol        = statusColor(agent.status, theme, !!approval);
  const statusWord  = approval ? 'APPROVE?'
                    : agent.status === 'waiting' ? 'INPUT?'
                    : (agent.status || '').toUpperCase();
  const statusGlyph = STATUS_GLYPH[agent.status] || '·';

  // Branch row
  const branchClean = (agent.dirty || 0) === 0;
  // model.label is a trusted catalog string; on genuine model drift (cli id
  // not in the catalog) we surface the sanitized resolved id rather than a
  // bare '—', routing the attacker-influenceable resolvedModel through the
  // escape stripper before it can reach the terminal. (0181)
  const modelLabel  = model ? model.label
                    : agent.resolvedModel ? humanize(trunc(String(agent.resolvedModel), 18))
                    : '—';
  const mCol        = modelColor(modelId, theme);

  // CTX bar — give it ~14 cells of room
  const ctxBarW = 14;
  const threshFrac = model ? (threshold / model.maxCtx) : 0.75;
  const ctxCells = barCells({ value: ctxPct, width: ctxBarW, threshFrac });
  const ctxStatColor = overT ? theme.red : nearT ? theme.yellow : theme.fg;

  // Sparkline
  const sparkStr = sparkLine(agent.spark || [], 14);
  const lastTpm = (agent.spark && agent.spark.length)
    ? Math.round(agent.spark[agent.spark.length - 1] * 8000)
    : 0;

  // Todos — the session's live TodoWrite checklist (agent.todos, normalized
  // to { content, status, activeForm } server-side). This is the closest
  // thing to a per-session "workflow": what claude is working through right
  // now. We show done/total + the in-progress item's title. The tile no
  // longer renders raw session text (tail/activity) — those were the only
  // variable-height rows and caused unpredictable card shapes (2026-07-06).
  const todos      = Array.isArray(agent.todos) ? agent.todos : [];
  const todoTotal  = todos.length;
  const todoDone   = todos.filter(t => t.status === 'completed').length;
  const todoActive = todos.find(t => t.status === 'in_progress');
  // Sanitize before truncating so an escape can't survive across the cut. (0181)
  const todoCurrent = todoActive
    ? trunc(humanize(todoActive.activeForm || todoActive.content || ''), 44)
    : '';

  // Parallel fan-out — Task/Workflow sub-agents currently in flight (server
  // pairs tool_use→tool_result into agent.activeSubagents). When present it's
  // the liveliest "what's happening now" signal, so it takes the current-item
  // row. Label is humanize()'d + truncated — the underlying strings come from
  // claude's tool input, so treat as untrusted (0181).
  const activeSubagents = Array.isArray(agent.activeSubagents) ? agent.activeSubagents : [];
  const subCount = activeSubagents.length;
  const subLabel = subCount === 1
    ? `⋔ ${trunc(humanize(activeSubagents[0].label || activeSubagents[0].type || 'agent'), 42)}`
    : `⋔${subCount} agents running`;

  // Session vitals — cheap counters already on the snapshot. Anchored to a
  // single `now` so uptime and time-in-state advance together each render.
  const now       = Date.now();
  const uptime    = fmtDurShort(now - (agent.spawnedAt || now));
  const stateAge  = fmtDurShort(now - (agent.stateSince || now));

  // ── Triage line ──────────────────────────────────────────────
  // The operator scans 10 cards asking one prospective question: "does this
  // need me, when, and what do I do next." Health answered a RETROSPECTIVE
  // question (was the session any good) so it's demoted to a small dot below;
  // this row is the burndown + a status-derived next-action verb.
  //
  // Show the todo burndown bar only while the session is live-working or idle
  // with a plan; waiting/error/paused get a full-width imperative instead. The
  // action strings are all literals — no escape surface. Color = urgency:
  // red needs-you-now, yellow soon, green harvestable, dim leave-alone.
  const allDone = todoTotal > 0 && todoDone >= todoTotal;
  const showBurndown = todoTotal > 0 && (agent.status === 'working' || agent.status === 'idle');
  let action, actionColor;
  if (agent.status === 'error') {
    action = 'errored · see log'; actionColor = theme.red;
  } else if (agent.status === 'paused') {
    action = 'paused'; actionColor = theme.dim;
  } else if (agent.status === 'waiting') {
    action = approval ? 'needs approval · answer to proceed' : 'needs input · answer to continue';
    actionColor = approval ? theme.red : theme.yellow;
  } else if (agent.status === 'idle') {
    action = allDone ? 'ready to review →' : todoTotal > 0 ? 'needs a nudge →' : `idle · ${stateAge} in state`;
    actionColor = allDone ? theme.green : todoTotal > 0 ? theme.yellow : theme.dim;
  } else { // working
    action = todoTotal > 0 ? 'check back' : `working · ${stateAge} in state`;
    actionColor = theme.dim;
  }

  // Pre-truncate the two variable-length labels (name, branch) to the actual
  // card width so each renders on ONE line WITHOUT Ink flex-truncation — which
  // wraps/phantoms unpredictably in a row of differently-colored Texts and was
  // the source of the random card overlap. Mirrors the tail rows' trunc()
  // approach. cardWidth = the slot column width from App.jsx; innerW strips the
  // border (2) + paddingX (2). Fixed-width siblings are measured exactly so the
  // label gets precisely the leftover room.
  const innerW = Math.max(16, (cardWidth || 56) - 4);
  const slotTagW = `[${agent.slot}] `.length;
  const statusTagW = `${statusGlyph} ${statusWord}`.length
    + (nearT ? ` · ${(ctxPct * 100).toFixed(0)}%`.length : 0)
    + (agent.stuckMin > 0 ? ` · STUCK ${agent.stuckMin}m`.length : 0);
  const nameStr = trunc(agent.name || '—', Math.max(3, innerW - slotTagW - statusTagW - 1));
  const gitChipsW = (branchClean ? 1 : `+${agent.dirty}`.length)
    + (agent.ahead  > 0 ? ` ↑${agent.ahead}`.length : 0)
    + (agent.behind > 0 ? ` ↓${agent.behind}`.length : 0);
  const branchStr = trunc(humanize(agent.branch || '—'), Math.max(3, innerW - `${modelLabel}  ⎇ `.length - gitChipsW - 1));

  return (
    <Box
      flexDirection="column"
      borderStyle={inkBorderStyle(borderStyle, focused)}
      borderColor={cardBorderColor({ status: agent.status, focused, ctxOver: overT, ctxNear: nearT, approval: !!approval, theme })}
      paddingX={1}
      width="100%"
      height={11}
      overflow="hidden"
    >
      {/* Title row — status pill at right, with a context-pressure chip
          appended when the slot is approaching its model's max ctx. The
          chip gives at-a-glance triage even when the CTX bar is mentally
          tuned out (e.g. while scanning a 10-card grid for who needs
          attention). Color follows urgency: yellow near threshold, red
          when over. */}
      <Box>
        <Text color={focused ? theme.accent : theme.dim}>[{agent.slot}] </Text>
        {/* nameStr is pre-truncated to fit (above) — plain one-line Text. The
            spacer pushes the status pill to the right edge; nothing here can
            wrap because the widths were budgeted exactly. */}
        <Text color={focused ? theme.accent : theme.fg}>{nameStr}</Text>
        <Box flexGrow={1} />
        <Text color={sCol}>{statusGlyph} {statusWord}</Text>
        {nearT && (
          <Text color={overT ? theme.red : theme.yellow}> · {(ctxPct * 100).toFixed(0)}%</Text>
        )}
        {agent.stuckMin > 0 && (
          // Wired by stuck-detection (#25); only renders when the server
          // has flagged the slot as silent past the threshold.
          <Text color={theme.red}> · STUCK {agent.stuckMin}m</Text>
        )}
      </Box>

      {/* Meta row: model + branch + git */}
      <Box>
        <Text color={mCol}>{modelLabel}</Text>
        <Text color={theme.dim}>  ⎇ </Text>
        {/* branchStr pre-truncated to fit (above) — one-line plain Text; spacer
            right-aligns the git chips. e.g. ops/db-recovery-incident-20 → … */}
        <Text color={theme.fg}>{branchStr}</Text>
        <Box flexGrow={1} />
        {branchClean
          ? <Text color={theme.green}>●</Text>
          : <Text color={theme.yellow}>+{agent.dirty}</Text>}
        {agent.ahead  > 0 && <Text color={theme.accent}> ↑{agent.ahead}</Text>}
        {agent.behind > 0 && <Text color={theme.yellow}> ↓{agent.behind}</Text>}
      </Box>

      {/* CTX bar */}
      <Box>
        <Text color={theme.dim}>ctx </Text>
        {ctxCells.map((c, i) => (
          <Text key={i} color={
            c.kind === 'thresh'  ? theme.yellow :
            c.kind === 'full'    ? (overT ? theme.red : nearT ? theme.yellow : theme.accent) :
            c.kind === 'partial' ? theme.brBlue : theme.faint
          }>{c.char}</Text>
        ))}
        <Text color={ctxStatColor}> {fmtK(agent.context || 0)} {(ctxPct * 100).toFixed(0)}%</Text>
      </Box>

      {/* Tok/min + sparkline */}
      <Box>
        <Text color={theme.dim}>tok/min </Text>
        <Text color={theme.fg}>{fmtK(lastTpm)}  </Text>
        <Text color={theme.accent}>{sparkStr}</Text>
      </Box>

      {/* Flex spacer — absorbs the one leftover line so the card stays a
          fixed height={11} while the content rows below sit together above
          the foot. */}
      <Box flexGrow={1} />

      {/* Triage row — burndown + next-action (replaces the centered health
          bar, 0256 redesign). While working/idle-with-a-plan it shows todo
          done/total + an 8-cell progress bar + a short verb; waiting/error/
          paused take the whole row as a colored imperative. The verb sits in a
          shrink+truncate box so it can never reflow the fixed-height card. */}
      <Box>
        <Text color={theme.accent}>▸ </Text>
        {showBurndown && (
          <>
            <Text color={allDone ? theme.green : theme.fg}>{todoDone}/{todoTotal} </Text>
            {barCells({ value: todoDone / todoTotal, width: 8 }).map((c, i) => (
              <Text key={i} color={c.kind === 'full' || c.kind === 'partial' ? (allDone ? theme.green : theme.accent) : theme.faint}>{c.char}</Text>
            ))}
            <Text> </Text>
          </>
        )}
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={actionColor} wrap="truncate">{action}</Text>
        </Box>
      </Box>

      {/* Current item — the in-progress todo's activeForm (what claude is doing
          right now), or a neutral placeholder. todoCurrent is already
          humanize()'d + truncated (above); the shrink+truncate box guards the
          card shape against a long title. */}
      <Box>
        <Text color={theme.faint}>↳ </Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          {subCount > 0
            ? <Text color={theme.accent} wrap="truncate">{subLabel}</Text>
            : <Text color={todoCurrent ? theme.dim : theme.faint} wrap="truncate">{todoCurrent || '—'}</Text>}
        </Box>
      </Box>

      {/* Vitals — turns / messages / uptime / time-in-current-state. Narrow
          cards drop msgs then uptime so the row can't wrap; turns and the
          state age (colored by status) always stay. */}
      <Box>
        {health && (
          // Health demoted to a small ●score↑ dot (0256) — matches Zoom's
          // glyph. Numeric score + fixed-set arrow only; the untrusted verdict
          // STRING is no longer rendered anywhere on the card, so its escape
          // surface is gone entirely (supersedes the 0181 humanize path).
          <Text color={healthColor(health, theme)}>●{health.score.toFixed(0)}{health.arrow}  </Text>
        )}
        <Text color={theme.fg}>⟳{agent.turnCount || 0}</Text>
        {innerW >= 30 && <Text color={theme.dim}>  {agent.messageCount || 0}✉</Text>}
        {innerW >= 40 && <Text color={theme.dim}>  ⧗{uptime}</Text>}
        <Box flexGrow={1} />
        <Text color={sCol}>{statusGlyph}{stateAge}</Text>
      </Box>

      {/* Foot: costs + tokens. On a tight (narrow-grid) card the week cost is
          dropped so the row doesn't wrap — it's the least-critical at-a-glance
          metric and is still shown in the aggregate bar up top. */}
      <Box>
        <Text color={theme.dim}>{fmtMoney(agent.costSession || 0)} </Text>
        <Text color={theme.faint}>ses</Text>
        {innerW >= 40 && (
          <>
            <Text color={theme.faint}>  </Text>
            <Text color={theme.dim}>{fmtMoney(agent.costWeek || 0)} </Text>
            <Text color={theme.faint}>wk</Text>
          </>
        )}
        <Box flexGrow={1} />
        <Text color={theme.green}>{fmtK(agent.tokensIn || 0)}↓ {fmtK(agent.tokensOut || 0)}↑</Text>
      </Box>
    </Box>
  );
}
