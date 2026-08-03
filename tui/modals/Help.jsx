// tui/modals/Help.jsx — keymap reference (`?` opens, esc closes).
//
// The keymap is ~65 rows — taller than most terminals (24–50 rows). Rendering it
// all at once overflowed the viewport with no scroll, so sections dropped and
// rows rendered overlaid on each other (release bug B2). We now flatten the
// content to lines and render a SCROLLABLE window sized to the terminal height,
// with ↑↓ / PgUp-PgDn / g-G navigation and a position indicator.

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

const PAD = 38;

// Content as data so it can be flattened + windowed. `views` (when present)
// marks the section as the CURRENT surface for context-aware highlighting.
const SECTIONS = [
  { title: 'NAVIGATION', views: ['main'], rows: [
    ['Move across the grid', '← ↑ ↓ →   (or hjkl)'],
    ['Jump to slot 1–9, 0', '1 .. 0'],
    ['Switch pane (when grid pages)', '[  ·  ]'],
    ['Open / zoom focused session', '↵  (enter)'],
    ['Defocus / close overlay', 'esc'],
  ]},
  { title: 'SESSIONS', views: ['main'], rows: [
    ['New session (next free slot)', 'n  ·  ctrl+n'],
    ['In NewSession · type to filter, ↑↓ pick, ↵ launch', ''],
    ['In NewSession · browse filesystem', 'ctrl+b'],
    ['In NewSession · cycle model', '← →'],
    ['Resume saved session', ':resume <slot>'],
    ['Pause / Resume', 'p / r'],
    ['Kill (press K twice · 3s arm)', 'K K   or  :kill!'],
    ['Approve pending action', 'a'],
    ['Cycle perm (plan → auto → acceptEdits)', 'shift+tab'],
  ]},
  { title: 'ZOOM (focused session)', views: ['zoom'], rows: [
    ['Exit zoom', 'ctrl+q'],
    ['Newline (plain ↵ submits)', 'ctrl+j · shift+↵'],
    ['Scroll mode (w/s/b/f/g/G)', 'ctrl+y'],
    ['Expand / collapse stats panel', 'ctrl+u'],
    ['Show / hide tool events', 'ctrl+k'],
    ['→ forwarded to claude', 'esc · ctrl+t · ctrl+s · shift+tab'],
  ]},
  { title: 'SLASH COMMANDS (in zoom composer)', views: ['zoom'], rows: [
    ['/help · /cost · /usage', 'show info'],
    ['/perm <mode>', 'change session perm'],
    ['/note <text>', 'local annotation'],
    ['/approve · /pause · /resume', 'session actions'],
    ['/kill · /quit', 'terminate · close'],
  ]},
  { title: 'COMMANDS', rows: [
    ['Open broadcast modal', 'b'],
    ['Open shell overlay', '!'],
    ['In shell · close (all other keys → shell)', 'ctrl+q'],
    ['Fleet log: all ↔ narrative', 'Shift+L'],
    ['Filter (dims non-matches)', '/'],
    ['Command bar', ':'],
    ['Help', '?'],
  ]},
  { title: 'COMMAND BAR (:cmd)', rows: [
    [':theme <name>', 'cycle palette'],
    [':cols 3|4|5', 'grid columns'],
    [':goto <slot>', 'focus slot 1..N (for caps > 10)'],
    [':perm <mode>', "change focused session's mode (live)"],
    [':perm default <mode>', 'change fleet default for new launches'],
    [':kill [slot] · :pause · :resume', 'agent actions'],
    [':resume [slot ...]', 'restore one or many (e.g. :resume 1 3 5)'],
    [':resume-all', 'restart the sessions open at last close'],
    [':history [n]', 'VIEW-ONLY last N sessions (reference; not restorable)'],
    [':sessions  /  :forget <slot>', 'manage saved'],
    [':repos  (:repos clear)', 'pick repo scan folder (clear → defaults)'],
    [':whoami  (or :auth)', 'check signed-in account'],
    [':usage', 're-read plan-side /usage (5h + 7d)'],
    [':cost', "show focused session's running cost"],
    [':cap [slot] <usd>', 'per-slot cost cap (refuse sends past this $)'],
    [':cap default <usd>', 'fleet-wide cost cap default for new launches'],
    [':budget <usd>', 'daily spend budget across all slots'],
    [':template  (or :tpl)', 'list templates · :template <name> launches bundle'],
    [':model', "show focused session's requested + resolved model"],
    [':model <id>', "switch focused session's model (live · restarts subprocess)"],
    [':model default <id>', 'set fleet default model for new launches'],
    [':model refresh', 'probe live models (billed ~$0.10/ea · updates ctx window)'],
    [':version  (or :ver)', 'show running build (version · git-sha · dirty?)'],
    [':transcript  (or :tx · :log)', 'show on-disk transcript path for focused session'],
    [':where', 'show config dir + transcript path'],
    [':debug-keys [on|off|clear]', 'record raw key events · REC chip when on'],
    ['/compact  (or :compact)', 'ask focused session for a summary so far'],
    ['/compact-restart  (or :cr)', 'L1 · summary → kill → relaunch with summary'],
    ['/clear   (or :clear · :restart)', 'kill + relaunch focused session · fresh sessionId'],
    ['/remember  (or :remember · :rem)', 'L2 · append a dated note to <cwd>/.mc/MEMORY.md'],
    ['/memory   (or :memory · :mem)', "L2 · dump this repo's project memory into the tail"],
    ['/mcp     (or :mcp)', 'L3 · list MCP servers attached to the focused session'],
    [':tasks  (or :todo · :t)', "GitHub Issues for focused session's repo (via gh)"],
    [':note <text>  (or :n)', 'add local annotation to chat log'],
    [':slack <url>', 'set Slack webhook (:slack clear to remove)'],
    [':feedback <msg>', 'send feedback to Slack'],
    [':request <msg>', 'send customer request to Slack'],
    [':quit', 'exit'],
  ]},
  { title: 'SETTINGS', rows: [
    ['Open settings menu', 'esc  (or  ,)'],
    ['Quit', 'q → confirm modal (or ctrl-c)'],
  ]},
];

// Flatten sections → renderable lines for windowing.
function buildLines(view) {
  const lines = [];
  for (const s of SECTIONS) {
    lines.push({ kind: 'section', title: s.title, highlight: !!s.views?.includes(view) });
    for (const [left, right] of s.rows) lines.push({ kind: 'row', left, right });
  }
  return lines;
}

export default function Help({ onClose, theme, width = 64, view = 'main', rows }) {
  const { stdout } = useStdout();
  // `rows` is an optional render seam: omitted, we use the live terminal height;
  // a caller (e.g. a test at a fixed-size harness, or an embedder) can force a
  // height so the keymap renders un-windowed. Behavior is unchanged when omitted.
  const termRows = rows ?? (stdout?.rows || 24);
  const lines = buildLines(view);
  // Body capacity, leaving room for: this modal's border+padding, its header +
  // footer, App's wrapper padding, and the FeedbackStrip + StatusBar below it.
  // Reserve generously and (below) render the body in a FIXED-height,
  // overflow:hidden box so a slight miscount CLIPS rather than overlaps — the
  // overlap was the whole B2 defect. Blank space is fine; collision is not.
  const capacity = Math.max(4, termRows - 15);
  const maxOffset = Math.max(0, lines.length - capacity);
  const [offset, setOffset] = useState(0);
  const clamp = (n) => Math.max(0, Math.min(maxOffset, n));
  const scrollable = lines.length > capacity;

  useInput((input, key) => {
    if (key.escape || key.return || input === '?') { onClose(); return; }
    if (!scrollable) return;
    if (key.downArrow || input === 'j') setOffset((o) => clamp(o + 1));
    else if (key.upArrow || input === 'k') setOffset((o) => clamp(o - 1));
    else if (key.pageDown || input === ' ') setOffset((o) => clamp(o + capacity));
    else if (key.pageUp) setOffset((o) => clamp(o - capacity));
    else if (input === 'g') setOffset(0);
    else if (input === 'G') setOffset(maxOffset);
  });

  const start = Math.min(offset, maxOffset);
  const visible = lines.slice(start, start + capacity);
  const posLabel = scrollable ? `  (${start + 1}-${Math.min(start + capacity, lines.length)}/${lines.length})` : '';

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor={theme.accent} paddingX={2} paddingY={1} width={width}>
      <Text color={theme.accent}>━━ KEYBOARD ━━<Text color={theme.dim}>{posLabel}</Text></Text>
      <Box flexDirection="column" height={capacity} overflow="hidden">
        {visible.map((ln, i) => {
          if (ln.kind === 'section') {
            return (
              <Text key={i} wrap="truncate" color={ln.highlight ? theme.green : theme.accent} bold={ln.highlight}>
                {ln.highlight ? '▶ ' : ''}{ln.title}{ln.highlight ? '  · CURRENT VIEW' : ''}
              </Text>
            );
          }
          // Guarantee a gap even when the left label is >= PAD chars (B2 cosmetic).
          const left = ln.left.length >= PAD ? ln.left + '  ' : ln.left.padEnd(PAD, ' ');
          return (
            <Box key={i}>
              <Text wrap="truncate" color={theme.fg}>{'  ' + left}</Text>
              <Text wrap="truncate" color={theme.accent}>{ln.right}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{scrollable ? '↑↓ / PgUp·PgDn / g·G scroll  ·  ' : ''}[esc] close</Text>
      </Box>
    </Box>
  );
}
