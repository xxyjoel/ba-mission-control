// tui/modals/BackgroundSessions.jsx — the sessions claude is running that are
// NOT in the fleet.
//
// Mission Control does not create these. claude does, when a conversation is
// moved to the background, and it keeps them until someone removes them. But
// this is the only screen the user watches, so a session running outside the
// fleet was completely invisible here. Measured on one machine, 2026-09-19:
// six of them, the oldest blocked for 9.8 days, together holding 1875 MB
// across 13 processes. The user called them orphans, and was right to.
//
// Removing one DELETES A CONVERSATION. It is therefore two deliberate
// keystrokes on a named row, never a bulk action and never a single key.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { trunc, humanize } from '../lib/format.js';

// Rows are capped so the modal can never out-grow a short terminal — Ink
// cannot erase a frame taller than the screen, and the whole UI tears. The cap
// follows the terminal instead of being a fixed 12, and when it bites the list
// says so rather than silently hiding sessions.
function maxRowsFor(height) {
  const CHROME = 10;                       // title, header, name line, footer, padding
  return Math.max(3, Math.min(20, (Number.isFinite(height) ? height : 40) - CHROME));
}

// How long ago, in the coarsest unit that is still honest.
function ageText(startedAt) {
  if (!Number.isFinite(startedAt)) return '?';
  const ms = Date.now() - startedAt;
  if (ms < 0) return '?';          // a timestamp in the future is not an age
  const days = ms / 86400000;
  if (days >= 1) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  const hours = ms / 3600000;
  if (hours >= 1) return `${hours.toFixed(0)}h`;
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}

function stateColor(state, theme) {
  if (state === 'working') return theme.accent;
  if (state === 'blocked') return theme.yellow;
  return theme.dim;
}

export default function BackgroundSessions({ background, theme, width = 100, height = 40, onClose, onRemove }) {
  const [idx, setIdx] = useState(0);
  const [armed, setArmed] = useState(null);   // sessionId awaiting a second key
  const [note, setNote] = useState('');

  // null means we could not read claude's list. That is not the same as none.
  const unknown = background == null;
  const maxRows = maxRowsFor(height);
  const all = unknown ? [] : background;
  const rows = all.slice(0, maxRows);
  const hidden = all.length - rows.length;
  // Clamp ONCE and use the SAME index everywhere. Clamping only for `sel` let
  // the list shrink under the selection, leaving no row marked while the
  // delete gesture stayed live on the last one.
  const cur = Math.min(idx, Math.max(0, rows.length - 1));
  const sel = rows[cur] || null;

  useInput((input, key) => {
    if (key.escape || input === 'q') { onClose?.(); return; }
    if (rows.length === 0) return;
    if (key.upArrow   || input === 'k') { setArmed(null); setNote(''); setIdx(Math.max(0, cur - 1)); return; }
    if (key.downArrow || input === 'j') { setArmed(null); setNote(''); setIdx(Math.min(rows.length - 1, cur + 1)); return; }
    // Two deliberate presses of X on the SAME row, because this deletes a
    // conversation. Moving the selection disarms, above.
    if (input === 'X') {
      if (!sel) return;
      if (armed === sel.sessionId) {
        setArmed(null);
        setNote(`removing ${sel.shortId}…`);
        onRemove?.(sel.shortId);
      } else {
        setArmed(sel.sessionId);
        setNote('');
      }
    }
  });

  const innerW = Math.max(40, width - 6);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} width={width}>
      <Box>
        <Text color={theme.accent} bold>BACKGROUND SESSIONS</Text>
        <Text color={theme.dim}>  claude is running these · they are not in your fleet</Text>
      </Box>

      <Box height={1} />

      {unknown ? (
        <Text color={theme.faint}>
          Could not read claude&apos;s session list. This is unknown, not empty —
          there may be sessions running.
        </Text>
      ) : rows.length === 0 ? (
        <Text color={theme.dim}>None. Every session claude is running is in your fleet.</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.faint}>{'  id        age    state     project'}</Text>
          </Box>
          {rows.map((e, i) => {
            const on = i === cur;
            const isArmed = armed === e.sessionId;
            const proj = (e.cwd || '').split('/').filter(Boolean).pop() || '—';
            return (
              <Box key={e.sessionId}>
                <Text color={on ? theme.accent : theme.faint}>{on ? '▸ ' : '  '}</Text>
                <Text color={on ? theme.fg : theme.dim} wrap="truncate">{e.shortId.padEnd(9)} </Text>
                <Text color={theme.dim}>{ageText(e.startedAt).padStart(5)}  </Text>
                <Text color={stateColor(e.state, theme)}>{(e.state || '?').padEnd(9)}</Text>
                <Text color={on ? theme.fg : theme.dim} wrap="truncate">
                  {trunc(humanize(proj), Math.max(10, innerW - 34))}
                </Text>
                {isArmed && <Text color={theme.red}>  press X again to delete</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {sel && !armed && (
        <>
          <Box height={1} />
          <Box flexDirection="column">
            <Text color={theme.dim} wrap="truncate">
              {trunc(humanize(sel.name || 'untitled'), innerW - 2)}
            </Text>
          </Box>
        </>
      )}

      {note !== '' && (
        <Box><Text color={theme.yellow}>{note}</Text></Box>
      )}

      {hidden > 0 && (
        <Box><Text color={theme.yellow}>{`  … ${hidden} more not shown — this terminal fits ${maxRows}`}</Text></Box>
      )}

      <Box height={1} />
      <Box>
        <Text color={theme.faint}>
          ↑↓ move · X twice deletes that conversation · esc close
        </Text>
      </Box>
    </Box>
  );
}
