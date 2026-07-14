// tui/modals/Help.jsx — keymap reference (`?` opens, esc closes).

import React from 'react';
import { Box, Text, useInput } from 'ink';

function Row({ left, right, theme }) {
  return (
    <Box>
      <Text color={theme.fg}>{left.padEnd(38, ' ')}</Text>
      <Text color={theme.accent}>{right}</Text>
    </Box>
  );
}

function Section({ title, children, theme, highlight = false }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={highlight ? theme.green : theme.accent} bold={highlight}>
        {highlight ? '▶ ' : ''}{title}{highlight ? '  · CURRENT VIEW' : ''}
      </Text>
      {children}
    </Box>
  );
}

// `view` is the active high-level surface ('main' | 'zoom' | 'new' |
// 'broadcast' | 'settings'). When present, we highlight the section
// most relevant to the user RIGHT NOW so the help screen acts as a
// context-aware overlay instead of a uniform wall of keys.
export default function Help({ onClose, theme, width = 64, view = 'main' }) {
  useInput((input, key) => {
    if (key.escape || key.return || input === '?') onClose();
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text color={theme.accent}>━━ KEYBOARD ━━</Text>
      <Section title="NAVIGATION" theme={theme} highlight={view === 'main'}>
        <Row left="  Move across the grid"          right="← ↑ ↓ →   (or hjkl)" theme={theme} />
        <Row left="  Jump to slot 1–9, 0"           right="1 .. 0"              theme={theme} />
        <Row left="  Switch pane (when grid pages)"  right="[  ·  ]"            theme={theme} />
        <Row left="  Open / zoom focused session"   right="↵  (enter)"          theme={theme} />
        <Row left="  Defocus / close overlay"      right="esc"                  theme={theme} />
      </Section>
      <Section title="SESSIONS" theme={theme} highlight={view === 'main'}>
        <Row left="  New session (next free slot)"   right="n  ·  ctrl+n"       theme={theme} />
        <Row left="  In NewSession · type to filter, ↑↓ pick, ↵ launch" right=""  theme={theme} />
        <Row left="  In NewSession · browse filesystem"  right="ctrl+b"          theme={theme} />
        <Row left="  In NewSession · cycle model"     right="← →"                theme={theme} />
        <Row left="  Resume saved session"            right=":resume <slot>"     theme={theme} />
        <Row left="  Pause / Resume"                  right="p / r"              theme={theme} />
        <Row left="  Kill (press K twice · 3s arm)"   right="K K   or  :kill!"   theme={theme} />
        <Row left="  Approve pending action"          right="a"                  theme={theme} />
        <Row left="  Cycle perm (plan → auto → acceptEdits)" right="shift+tab"   theme={theme} />
      </Section>
      <Section title="ZOOM (focused session)" theme={theme} highlight={view === 'zoom'}>
        <Row left="  Exit zoom"                      right="ctrl+q"             theme={theme} />
        <Row left="  Newline (plain ↵ submits)"      right="ctrl+j · shift+↵"   theme={theme} />
        <Row left="  Scroll mode (w/s/b/f/g/G)"      right="ctrl+y"             theme={theme} />
        <Row left="  Expand / collapse stats panel"  right="ctrl+u"             theme={theme} />
        <Row left="  Show / hide tool events"        right="ctrl+k"             theme={theme} />
        <Row left="  → forwarded to claude"          right="esc · ctrl+t · ctrl+s · shift+tab" theme={theme} />
      </Section>
      <Section title="SLASH COMMANDS (in zoom composer)" theme={theme} highlight={view === 'zoom'}>
        <Row left="  /help · /cost · /usage"         right="show info"          theme={theme} />
        <Row left="  /perm <mode>"                   right="change session perm" theme={theme} />
        <Row left="  /note <text>"                   right="local annotation"   theme={theme} />
        <Row left="  /approve · /pause · /resume"    right="session actions"    theme={theme} />
        <Row left="  /kill · /quit"                  right="terminate · close"  theme={theme} />
      </Section>
      <Section title="COMMANDS" theme={theme}>
        <Row left="  Open broadcast modal"           right="b"                  theme={theme} />
        <Row left="  Fleet log: all ↔ narrative"     right="Shift+L"            theme={theme} />
        <Row left="  Filter (dims non-matches)"      right="/"                  theme={theme} />
        <Row left="  Command bar"                    right=":"                  theme={theme} />
        <Row left="  Help"                           right="?"                  theme={theme} />
      </Section>
      <Section title="COMMAND BAR (:cmd)" theme={theme}>
        <Row left="  :theme <name>"                  right="cycle palette"      theme={theme} />
        <Row left="  :cols 3|4|5"                    right="grid columns"       theme={theme} />
        <Row left="  :goto <slot>"                   right="focus slot 1..N (for caps > 10)" theme={theme} />
        <Row left="  :perm <mode>"                   right="change focused session's mode (live)" theme={theme} />
        <Row left="  :perm default <mode>"           right="change fleet default for new launches" theme={theme} />
        <Row left="  :kill [slot] · :pause · :resume" right="agent actions"     theme={theme} />
        <Row left="  :resume [slot ...]"             right="restore one or many (e.g. :resume 1 3 5)" theme={theme} />
        <Row left="  :resume-all"                    right="restart the sessions open at last close" theme={theme} />
        <Row left="  :history [n]"                   right="VIEW-ONLY last N sessions (reference; not restorable)" theme={theme} />
        <Row left="  :sessions  /  :forget <slot>"   right="manage saved"       theme={theme} />
        <Row left="  :repos  (:repos clear)"         right="pick repo scan folder (clear → defaults)" theme={theme} />
        <Row left="  :whoami  (or :auth)"            right="check signed-in account" theme={theme} />
        <Row left="  :usage"                         right="re-read plan-side /usage (5h + 7d)" theme={theme} />
        <Row left="  :cost"                          right="show focused session's running cost" theme={theme} />
        <Row left="  :cap [slot] <usd>"              right="per-slot cost cap (refuse sends past this $)" theme={theme} />
        <Row left="  :cap default <usd>"             right="fleet-wide cost cap default for new launches" theme={theme} />
        <Row left="  :budget <usd>"                  right="daily spend budget across all slots" theme={theme} />
        <Row left="  :template  (or :tpl)"           right="list templates · :template <name> launches bundle" theme={theme} />
        <Row left="  :model"                         right="show focused session's requested + resolved model" theme={theme} />
        <Row left="  :model <id>"                    right="switch focused session's model (live · restarts subprocess)" theme={theme} />
        <Row left="  :model default <id>"            right="set fleet default model for new launches" theme={theme} />
        <Row left="  :model refresh"                 right="probe live models (billed ~$0.10/ea · updates ctx window + discovers new)" theme={theme} />
        <Row left="  :version  (or :ver)"            right="show running build (version · git-sha · dirty?)" theme={theme} />
        <Row left="  :transcript  (or :tx · :log)"   right="show on-disk transcript path for focused session" theme={theme} />
        <Row left="  :where"                         right="show config dir + transcript path" theme={theme} />
        <Row left="  :debug-keys [on|off|clear]"     right="record raw key events to debug-keys.log · REC chip when on" theme={theme} />
        <Row left="  /compact  (or :compact)"        right="ask focused session for a summary so far (review before /clear)" theme={theme} />
        <Row left="  /compact-restart  (or :cr)"      right="L1 · summary → kill → relaunch with summary as first msg" theme={theme} />
        <Row left="  /clear   (or :clear · :restart)" right="kill + relaunch focused session in same slot · fresh sessionId" theme={theme} />
        <Row left="  /remember  (or :remember · :rem)" right="L2 · append a dated note to <cwd>/.mc/MEMORY.md" theme={theme} />
        <Row left="  /memory   (or :memory · :mem)"   right="L2 · dump this repo\'s project memory into the session tail" theme={theme} />
        <Row left="  /mcp     (or :mcp)"              right="L3 · list MCP servers attached to the focused session" theme={theme} />
        <Row left="  :tasks  (or :todo · :t)"        right="GitHub Issues for focused session's repo (via gh CLI)" theme={theme} />
        <Row left="  :note <text>  (or :n)"          right="add local annotation to chat log" theme={theme} />
        <Row left="  :slack <url>"                   right="set Slack webhook (:slack clear to remove)" theme={theme} />
        <Row left="  :feedback <msg>"                right="send feedback to Slack" theme={theme} />
        <Row left="  :request <msg>"                 right="send customer request to Slack" theme={theme} />
        <Row left="  :quit"                          right="exit"               theme={theme} />
      </Section>
      <Section title="SETTINGS" theme={theme}>
        <Row left="  Open settings menu"             right="esc  (or  ,)"       theme={theme} />
        <Row left="  Quit"                           right="q → confirm modal (or ctrl-c)" theme={theme} />
      </Section>
      <Box marginTop={1}>
        <Text color={theme.dim}>[esc] close</Text>
      </Box>
    </Box>
  );
}
