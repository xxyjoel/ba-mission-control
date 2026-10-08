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
import { modelColor, resolveAgentModel } from './lib/models.js';
import { barCells, sparkLine, fmtK, fmtMem, trunc, humanize, fmtDurShort, UNKNOWN, UNMEASURED, fmtMoneyMeasured, fmtKMeasured } from './lib/format.js';
import { readProjectHealth, healthColor, healthScoreText } from './lib/projectHealth.js';

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
  // color and ctx% denominator in sync with the switch. `auto` launches
  // resolve through resolveAgentModel so ctx% is not `?%`.
  const model = resolveAgentModel(agent);
  const modelId = model?.id || agent.model;
  // 0409: ctx% needs a DENOMINATOR, and the only source of one is the model's
  // maxCtx. When claude reports a model the catalog has never heard of there is
  // no denominator — the old `: 0` then rendered a confident `0%` beside a real
  // 142k token count, and an empty 14-cell bar that read as "plenty of room".
  // ctxKnown gates every ctx visual: the bar and the % are replaced by the
  // unknown marker, and the measured token count (which IS a live figure) stays.
  const ctxKnown = !!(model && Number.isFinite(model.maxCtx) && model.maxCtx > 0);
  // 0420/D1: a null context was never measured — no bar (an empty one reads as
  // 0% used) and no %, just the `-` placeholder beside whatever limit we know.
  const ctxMeasured = agent.context !== null;
  const ctxPct = ctxKnown ? (agent.context || 0) / model.maxCtx : 0;
  const ctxPctText = ctxKnown ? `${(ctxPct * 100).toFixed(0)}%` : `${UNKNOWN}%`;
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
  // 0403: background agents are shown BESIDE the status, never merged into it.
  // Reported twice from opposite directions: gtm-gov-miner read a flat WORKING
  // on a conversation whose turn had ended 28 min earlier, and labor-market-app
  // read IDLE while a fleet of background agents ran. Both are the same card
  // telling one truth where there are two. Suppressed while an approval is
  // pending — that needs the user now and must not share the row.
  //
  // 0409: the chip must not invent a COUNT. `bgCount` is a real tally of
  // outstanding Task/Workflow calls, except on one path: ptyAgent's hook-clock
  // fallback sets `bgCount = 1` when the transcript never showed the Task, so
  // five running background agents rendered "1bg". The count there is genuinely
  // unmeasured — one is a guess that happens to look like a measurement.
  //
  // So the chip reads the LIVENESS flag (bgStatus) and the COUNT separately:
  // background work is shown whenever bgStatus says it is live, and the count
  // is printed only when it is a real positive tally — otherwise `?bg`. That
  // keeps a measured tally rendering exactly as before, and lets the server
  // report "live, count unknown" (bgCount null) without the card lying.
  //
  // 0416: the COUNT is now gone from the chip — reported as a duplicate, and it
  // is one. Whenever the server can count, the SAME number already renders
  // below as `⋔N agents running` off the SAME array: ptyAgent.mjs:1271 sets
  // `bgCount = liveSubFiles.length` and :1312-1320 maps that identical array
  // into activeSubagents, so `bgCount === activeSubagents.length` there by
  // construction. `?bg` was worse than useless — an unknown tally printed where
  // a tally was never the point.
  //
  // The WORD stays. On the hook-clock path (ptyAgent.mjs:1276-1277) bgStatus is
  // live while activeSubagents is empty, so the ↳ row falls back to `—` and the
  // chip is the only thing on the card saying background work is running. The
  // main status still reads IDLE there (0403 superseded the 0398 override,
  // ptyAgent.mjs:1230-1244), and `IDLE · WORKING` — two status words on one row
  // separated only by colour — reads as a contradiction, not as two facts. Two
  // letters buy that disambiguation; the tally bought nothing.
  const bgLive = !!agent.bgStatus || agent.bgCount > 0;
  // 0418: the status row says the SESSION's status and nothing else. It used
  // to carry a second status word for background work — `3bg WORKING`, later
  // `bg WORKING` — in a different colour beside the real one. Two status words
  // on one row is not a summary, it is a question: a reader saw teal WORKING
  // and light-blue `bg WORKING` flip between each other and could not tell
  // which one described the session. Background work is work the card should
  // list, not a modifier on the session's own state, so it moved to the body
  // row below with the sub-agents.
  //
  // bgLive stays. It is not only the chip's gate — Card.jsx:281 uses it to turn
  // the triage verb from `needs a nudge →` into `check back`, so an idle slot
  // with background work running is never advertised as safe to interrupt.

  // Branch row
  // 0452: git state contract (server/git.mjs fullStatus). isRepo false → not a
  // repo → no git chips. dirty === null → the read failed → UNKNOWN, never the
  // green clean dot. Only an explicit null is unknown; an absent field keeps the
  // old rendering (same rule as UNMEASURED in format.js).
  const gitNone     = agent.isRepo === false;
  const dirtyKnown  = agent.dirty !== null;
  const branchClean = dirtyKnown && (agent.dirty || 0) === 0;
  // model.label is a trusted catalog string; on genuine model drift (cli id
  // not in the catalog) we surface the sanitized resolved id rather than a
  // bare '—', routing the attacker-influenceable resolvedModel through the
  // escape stripper before it can reach the terminal. (0181)
  const modelLabel  = model ? model.label
                    : agent.resolvedModel ? humanize(trunc(String(agent.resolvedModel), 18))
                    : '—';
  const mCol        = modelColor(modelId, theme);

  // 0414: WHICH conversation is this card showing? A user sent a long list of
  // requirements to one stonks session at 20:42:40 on 2026-09-19; Mission
  // Control started 39 seconds later on a different, older session in the same
  // folder, and every message typed afterwards went to the second conversation.
  // Three live sessions sat in that one folder. Nothing on the card said which.
  //
  // The short id is the same eight characters `:bg` and `claude agents` print,
  // so a card can be matched against them by eye.
  const sidTag = agent.sessionId ? ` ${String(agent.sessionId).slice(0, 8)}` : '';
  // How many OTHER conversations claude holds in this folder. Undefined or null
  // means we could not read claude's list — unknown, and it must not draw a
  // mark that says "none". Only a real positive count draws one.
  // Plain `!` and not a warning sign: the budget below measures with .length,
  // and U+26A0 is an ambiguous-width glyph that over-runs the row on some
  // terminals. Every chip on this row is deliberately narrow.
  const otherSessions = agent.otherSessions;
  const othersTag = Number.isFinite(otherSessions) && otherSessions > 0 ? ` !${otherSessions}` : '';

  // CTX bar — give it ~14 cells of room.
  // 0409: threshFrac was `: 0.75` for an unknown model — a threshold marker
  // drawn three-quarters along a bar whose scale nobody knows. It is omitted
  // now (barCells skips the marker when threshFrac isn't a number), and the
  // whole bar is suppressed when there's no denominator to plot against.
  //
  // 0459: EVERY row is budgeted against innerW, not just the name and branch.
  // At cardWidth 23 the ctx and tok/min rows wrapped onto two lines each and
  // the fixed 11-row box clipped the rows below them — the model/branch tail
  // and the vitals row vanished. Each row now measures its fixed parts and
  // shrinks or drops its lowest-priority part, so it always fits one line.
  // innerW strips the border (2) + paddingX (2) from the slot column width.
  const innerW = Math.max(16, (cardWidth || 56) - 4);
  const ctxStatText = ctxMeasured ? ` ${fmtK(agent.context || 0)} ${ctxPctText}` : ` ${UNMEASURED}`;
  const ctxRoom = innerW - 'ctx '.length - ctxStatText.length;
  // 0459: the bar shrinks to the room left (max 14 cells) and drops below 4,
  // where it is too short to read; the token count and % always stay.
  const ctxBarW = Math.min(14, ctxRoom);
  const threshFrac = ctxKnown ? (threshold / model.maxCtx) : undefined;
  const ctxBarWanted = ctxKnown && ctxMeasured;
  const ctxCells = ctxBarWanted && ctxBarW >= 4 ? barCells({ value: ctxPct, width: ctxBarW, threshFrac }) : null;
  const ctxLimitText = `limit ${ctxKnown ? fmtK(model.maxCtx) : UNKNOWN}`;
  const showCtxLimit = !ctxBarWanted && ctxLimitText.length <= ctxRoom;
  const ctxStatColor = overT ? theme.red : nearT ? theme.yellow : theme.fg;
  // tok/min NUMBER = the true last-sample rate (agent.lastTokRate), shown only
  // while actively working — 0 otherwise. The old `spark[last] * 8000` read the
  // glyph array, which carries a 0.5 floor (→ phantom 4000 tok/min on idle cards)
  // and a fill(1) cold-start baseline (→ 8000 on brand-new sessions); the spark
  // array stays as the decorative history bars only.
  // TODO(tpm-decay): lastTokRate freezes at the last sample; a long-running Bash
  // tool with no token flow still reads 'working'. Decay toward 0 by elapsed
  // time since agent.lastTokSampleTs for a live-throughput readout.
  const lastTpm = agent.status === 'working' ? Math.round(agent.lastTokRate || 0) : 0;
  // 0420/D1: no token feed → no throughput to report, working or not.
  const tpmText = agent.lastTokRate === null || agent.tokensOut === null ? UNMEASURED : fmtK(lastTpm);
  // 0459: tok/min row budget. Label + rate always; the proc readout (real
  // data) next if it fits with a 1-cell gap; the sparkline (decoration) takes
  // what is left, up to 14 cells, and drops below 3.
  const procText = (agent.procMemKb || 0) > 0
    ? `${Math.round(agent.procCpu || 0)}% ${fmtMem(agent.procMemKb)}` : '';
  const tpmUsed = 'tok/min '.length + tpmText.length;
  const showProc = procText !== '' && tpmUsed + 1 + procText.length <= innerW;
  const sparkRoom = innerW - tpmUsed - 2 - (showProc ? 1 + procText.length : 0);
  const sparkStr = sparkRoom >= 3 ? sparkLine(agent.spark || [], Math.min(14, sparkRoom)) : '';
  const tpmGap = innerW - tpmUsed - (showProc ? 1 + procText.length : 0) >= 2 ? '  ' : '';

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
  // 0409: `(agent.spawnedAt || now)` made a MISSING spawn timestamp render as
  // "0s" — a brand-new session and an unstamped one looked identical. A real
  // agent always carries both (PtyAgent stamps them in its constructor), so
  // these branches only fire on a snapshot that lost the field; say so.
  //
  // 0409: the ⧗ hourglass answers "how old is this CONVERSATION", so it reads
  // sessionStartedAt — the first record in the session transcript. spawnedAt
  // measures the agent OBJECT's life, which a resume or a Mission Control
  // restart re-stamps: seven slots relaunched from a saved set all showed the
  // same one-second uptime for conversations days apart. spawnedAt stays as
  // the fallback for the legacy Agent path and for a session whose transcript
  // isn't readable yet; neither present still renders UNKNOWN, never 0s.
  const now       = Date.now();
  const convoFrom = agent.sessionStartedAt || agent.spawnedAt || null;
  const uptime    = convoFrom ? fmtDurShort(now - convoFrom) : UNKNOWN;
  const stateAge  = agent.stateSince ? fmtDurShort(now - agent.stateSince) : UNKNOWN;

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
  } else if (agent.status === 'idle' && bgLive) {
    // 0409: reads the same liveness flag as the chip above, so the verb and the
    // chip can never disagree — and so an unknown-but-live background count
    // still suppresses "needs a nudge →" on a genuinely busy slot.
    // 0408/D2: background agents keep working while the foreground turn is
    // idle (e7e28fa keeps status 'idle' during fan-out). The triage verb must
    // read the WHOLE card's truth, not status alone — `IDLE · 3bg WORKING`
    // above a `needs a nudge →` told the operator to interrupt a busy slot.
    // Use the working-branch verb instead.
    action = 'check back'; actionColor = theme.dim;
  } else if (agent.status === 'idle') {
    // 0386: no `idle · Xm in state` fallback — status already sits top-right
    // and the duration bottom-right, so the midbox restatement was noise.
    // The row only speaks when it has something actionable to say.
    action = allDone ? 'ready to review →' : todoTotal > 0 ? 'needs a nudge →' : '';
    actionColor = allDone ? theme.green : todoTotal > 0 ? theme.yellow : theme.dim;
  } else { // working
    action = todoTotal > 0 ? 'check back' : ''; // 0386: ditto for `working · Xm`
    actionColor = theme.dim;
  }

  // Pre-truncate the two variable-length labels (name, branch) to the actual
  // card width so each renders on ONE line WITHOUT Ink flex-truncation — which
  // wraps/phantoms unpredictably in a row of differently-colored Texts and was
  // the source of the random card overlap. Mirrors the tail rows' trunc()
  // approach. cardWidth = the slot column width from App.jsx; innerW strips the
  // border (2) + paddingX (2). Fixed-width siblings are measured exactly so the
  // label gets precisely the leftover room.
  //
  // 0459: the old floor `Math.max(3, …)` handed the label 3 cells even when
  // the fixed parts had already used the row, so the row wrapped. Now the
  // optional chips are added in priority order only while the label keeps at
  // least LABEL_MIN cells; once nothing optional fits the label takes what is
  // left (possibly nothing) and the row still fits. The 1-cell gap between
  // the label and a right-hand part is budgeted wherever a right-hand part is
  // drawn (the title's status word, the meta row's git chips), so a label at
  // its floor never runs into it. labelRoom keeps the pre-0459 rule (gap only
  // when there is room) for a meta row with no right-hand chip, where nothing
  // follows the branch. Wide cards render as before (card-golden-0420.json;
  // its narrow 30-col case was updated in 0459, see the test header).
  const LABEL_MIN = 3;
  const fitsWithLabel = (used, w) => innerW - used - w >= LABEL_MIN;
  const labelRoom = (used) => Math.min(innerW - used, Math.max(LABEL_MIN, innerW - used - 1));

  // Title: [slot] + status word are required; STUCK beats the ctx% chip,
  // which the ctx row already shows.
  // The trailing 1 is the gap before the status word: a name cut to its
  // floor must not run into the status glyph (`gt…● WORKING`).
  let titleUsed = `[${agent.slot}] `.length + `${statusGlyph} ${statusWord}`.length + 1;
  // A narrow card keeps the alert as ` · STUCK` rather than losing it. The
  // separator stays so it can't read as part of a neighbouring chip.
  const stuckFull = agent.stuckMin > 0 ? ` · STUCK ${agent.stuckMin}m` : '';
  const stuckShort = ' · STUCK';
  const stuckChip = stuckFull === '' ? ''
    : fitsWithLabel(titleUsed, stuckFull.length) ? stuckFull
    : fitsWithLabel(titleUsed, stuckShort.length) ? stuckShort : '';
  const showStuck = stuckChip !== '';
  if (showStuck) titleUsed += stuckChip.length;
  // The ctx% chip repeats the ctx row, so it never keeps its place while the
  // STUCK minutes are being cut: no chip unless STUCK is absent or whole.
  const ctxChip = nearT ? ` · ${ctxPctText}` : '';
  const showCtxChip = ctxChip !== '' && stuckChip === stuckFull
    && fitsWithLabel(titleUsed, ctxChip.length);
  if (showCtxChip) titleUsed += ctxChip.length;
  const nameRoom = Math.max(0, innerW - titleUsed);
  const nameStr = nameRoom > 0 ? trunc(agent.name || '—', nameRoom) : '';

  // Meta: model + `  ⎇ ` + branch are required (model capped so the branch
  // keeps LABEL_MIN). Then git dirty chip, other-sessions warning, ahead,
  // behind, and last the 9-cell session-id tag, the longest chip. It shows
  // from cardWidth 39 for a full git row; the grid minimum (34) may drop it.
  const branchSep = '  ⎇ ';
  const modelStr = trunc(modelLabel, Math.max(1, innerW - branchSep.length - LABEL_MIN - 1));
  let metaUsed = modelStr.length + branchSep.length;
  const dirtyChip = gitNone ? '' : !dirtyKnown ? UNKNOWN : branchClean ? '●' : `+${agent.dirty}`;
  // 0459: the git chips sit right of the branch with no leading space of
  // their own, so once any right-hand chip is kept the row also reserves the
  // 1-cell gap after the branch — a branch cut to the LABEL_MIN floor must
  // not run into them (`fe…+12345`, `ma…●`).
  let metaGap = 0;
  const metaPart = (s, right) => {
    const gap = right || metaGap ? 1 : 0;
    if (s === '' || !fitsWithLabel(metaUsed + gap, s.length)) return '';
    metaUsed += s.length;
    if (right) metaGap = 1;
    return s;
  };
  const dirtyStr  = metaPart(dirtyChip, true);
  const othersStr = metaPart(othersTag, false);
  const aheadStr  = !gitNone && agent.ahead  > 0 ? metaPart(` ↑${agent.ahead}`, true)  : '';
  const behindStr = !gitNone && agent.behind > 0 ? metaPart(` ↓${agent.behind}`, true) : '';
  const sidStr    = metaPart(sidTag, false);
  const branchStr = trunc(humanize(agent.branch || '—'), Math.max(1, labelRoom(metaUsed)));

  // Triage: the action verb beats the burndown bar. The bar takes what the
  // verb (up to 12 cells) leaves, max 8, and drops below 3.
  const burnCount = showBurndown ? `${todoDone}/${todoTotal} ` : '';
  const triageUsed = (showBurndown || action !== '' ? 2 : 0) + burnCount.length;
  const burnRoom = innerW - triageUsed - 1 - Math.min(action.length, 12);
  const burnBarW = showBurndown && burnRoom >= 3 ? Math.min(8, burnRoom) : 0;
  const actionStr = trunc(action, Math.max(0, innerW - triageUsed - (burnBarW ? burnBarW + 1 : 0)));

  // Current-item row: `↳ ` + the text, cut to the row.
  const itemRoom = Math.max(1, innerW - 2);

  // Vitals: turns + state age are required; then health, msgs (innerW >= 30),
  // uptime (innerW >= 40), each only if it still fits the row.
  const stateText = `${statusGlyph}${stateAge}`;
  let vitalsUsed = `⟳${agent.turnCount || 0}`.length + 1 + stateText.length;
  const vitalsPart = (on, s) => {
    if (!on || vitalsUsed + s.length > innerW) return '';
    vitalsUsed += s.length;
    return s;
  };
  const healthStr = health ? vitalsPart(true, `●${healthScoreText(health)}${health.arrow}  `) : '';
  const msgsStr   = vitalsPart(innerW >= 30, `  ${agent.messageCount || 0}✉`);
  const uptimeStr = vitalsPart(innerW >= 40, `  ⧗${uptime}`);

  // Foot: cost + `ses` are required; then tokens in, then tokens out.
  const costText = `${model && model.estimatedPricing ? '~' : ''}${fmtMoneyMeasured(agent.costSession)} `;
  const footUsed = costText.length + 'ses'.length + 1;
  const tokInText = `${fmtKMeasured(agent.tokensIn)}↓`;
  const tokOutText = ` ${fmtKMeasured(agent.tokensOut)}↑`;
  const showTokIn = footUsed + tokInText.length <= innerW;
  const showTokOut = showTokIn && footUsed + tokInText.length + tokOutText.length <= innerW;

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
        {showCtxChip && (
          <Text color={overT ? theme.red : theme.yellow}> · {ctxPctText}</Text>
        )}
        {showStuck && (
          // Wired by stuck-detection (#25); only renders when the server
          // has flagged the slot as silent past the threshold.
          <Text color={theme.red}>{stuckChip}</Text>
        )}
      </Box>

      {/* Meta row: model + branch + git */}
      <Box>
        <Text color={mCol}>{modelStr}</Text>
        {sidStr && <Text color={theme.dim}>{sidStr}</Text>}
        {othersStr && <Text color={theme.yellow}>{othersStr}</Text>}
        <Text color={theme.dim}>  ⎇ </Text>
        {/* branchStr pre-truncated to fit (above) — one-line plain Text; spacer
            right-aligns the git chips. e.g. ops/db-recovery-incident-20 → … */}
        <Text color={theme.fg}>{branchStr}</Text>
        <Box flexGrow={1} />
        {/* 0452: no chips for a non-repo; '?' when the dirty count is unknown. */}
        {/* 0459: each chip renders only if the row budget kept it. */}
        {dirtyStr && (
          <Text color={!dirtyKnown ? theme.dim : branchClean ? theme.green : theme.yellow}>{dirtyStr}</Text>
        )}
        {aheadStr  && <Text color={theme.accent}>{aheadStr}</Text>}
        {behindStr && <Text color={theme.yellow}>{behindStr}</Text>}
      </Box>

      {/* CTX bar. 0409: with no known maxCtx the bar is SUPPRESSED rather than
          drawn empty — 14 empty cells read as "0% used", which is exactly the
          unknown-as-zero confusion this row is being cleared of. The measured
          token count still shows; the ratio says `?`. One row either way. */}
      <Box>
        <Text color={theme.dim}>ctx </Text>
        {ctxCells
          ? ctxCells.map((c, i) => (
              <Text key={i} color={
                c.kind === 'thresh'  ? theme.yellow :
                c.kind === 'full'    ? (overT ? theme.red : nearT ? theme.yellow : theme.accent) :
                c.kind === 'partial' ? theme.brBlue : theme.faint
              }>{c.char}</Text>
            ))
          : showCtxLimit ? <Text color={theme.faint}>{ctxLimitText}</Text> : null}
        {/* 0459: with nothing between the label and the stat, drop the stat's
            leading space so the row does not read `ctx  150.8k`. */}
        <Text color={ctxMeasured ? ctxStatColor : theme.dim}>
          {ctxCells || showCtxLimit ? ctxStatText : ctxStatText.slice(1)}
        </Text>
      </Box>

      {/* Tok/min + sparkline · right side: subprocess CPU/RSS (0387).
          procCpu is ps's %-of-one-core; procMemKb the claude process RSS.
          Hidden until the first fleet sample lands (both 0). */}
      <Box>
        <Text color={theme.dim}>tok/min </Text>
        <Text color={theme.fg}>{tpmText}{tpmGap}</Text>
        <Text color={theme.accent}>{sparkStr}</Text>
        <Box flexGrow={1} />
        {showProc && <Text color={theme.dim}>{procText}</Text>}
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
        {/* 0386: the ▸ marker only draws when the row has content — an empty
            row keeps its line (fixed card height) but goes fully blank. */}
        {(showBurndown || action !== '') && <Text color={theme.accent}>▸ </Text>}
        {showBurndown && (
          <>
            <Text color={allDone ? theme.green : theme.fg}>{burnCount}</Text>
            {burnBarW > 0 && (
              <>
                {barCells({ value: todoDone / todoTotal, width: burnBarW }).map((c, i) => (
                  <Text key={i} color={c.kind === 'full' || c.kind === 'partial' ? (allDone ? theme.green : theme.accent) : theme.faint}>{c.char}</Text>
                ))}
                <Text> </Text>
              </>
            )}
          </>
        )}
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={actionColor} wrap="truncate">{actionStr}</Text>
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
            ? <Text color={theme.accent} wrap="truncate">{trunc(subLabel, itemRoom)}</Text>
            : bgLive
              /* 0418: background work the server can see but cannot count —
                 the hook-clock path sets bgStatus live with an empty
                 activeSubagents array (server/ptyAgent.mjs:1276). Before this
                 row existed that case showed only in the header chip; with the
                 chip gone it would have shown nowhere at all. No invented
                 number: say that it is running, not how many. */
              ? <Text color={theme.accent} wrap="truncate">{trunc('⋔ background agents running', itemRoom)}</Text>
              : <Text color={todoCurrent ? theme.dim : theme.faint} wrap="truncate">{trunc(todoCurrent || '—', itemRoom)}</Text>}
        </Box>
      </Box>

      {/* Vitals — turns / messages / uptime / time-in-current-state. Narrow
          cards drop msgs then uptime so the row can't wrap; turns and the
          state age (colored by status) always stay. */}
      <Box>
        {healthStr && (
          // Health demoted to a small ●score↑ dot (0256) — matches Zoom's
          // glyph. Numeric score + fixed-set arrow only; the untrusted verdict
          // STRING is no longer rendered anywhere on the card, so its escape
          // surface is gone entirely (supersedes the 0181 humanize path).
          // 0409: healthScoreText prints `?` for a reading whose composite was
          // unusable — `score.toFixed(0)` on the old `|| 0` rendered `●0`, the
          // worst possible health, for a score that was never measured. The
          // arrow is '' until there are two readings to take a delta between.
          <Text color={healthColor(health, theme)}>{healthStr}</Text>
        )}
        <Text color={theme.fg}>⟳{agent.turnCount || 0}</Text>
        {msgsStr   && <Text color={theme.dim}>{msgsStr}</Text>}
        {uptimeStr && <Text color={theme.dim}>{uptimeStr}</Text>}
        <Box flexGrow={1} />
        <Text color={sCol}>{stateText}</Text>
      </Box>

      {/* Foot: session cost + tokens. The weekly cost is a FLEET total (not
          per-agent), so it lives once in the aggregate bar up top — showing it
          per-card made every card duplicate the same number. */}
      <Box>
        {/* 0408/M4: `~` marks a cost computed from an INHERITED pricing row
            (models.js estimatedPricing) — it must not pass for a billed figure. */}
        <Text color={theme.dim}>{costText}</Text>
        <Text color={theme.faint}>ses</Text>
        <Box flexGrow={1} />
        {showTokIn && <Text color={theme.green}>{tokInText}{showTokOut ? tokOutText : ''}</Text>}
      </Box>
    </Box>
  );
}
