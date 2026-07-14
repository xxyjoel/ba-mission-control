// tui/lib/slashCommands.js — catalog of slash commands available inside
// the Zoom composer.
//
// These mirror the most-useful subset of Anthropic's Claude Code REPL
// slash commands, plus a few mc-specific ones. They DO NOT round-trip to
// the `claude` subprocess (stream-json non-interactive mode doesn't
// dispatch slash commands itself) — instead they're handled client-side
// in App.jsx, routed through the same dispatcher that powers the `:cmd`
// command bar. Adding a new entry here MUST also add a matching `case`
// to App.jsx's `runCommand` (or wire a Zoom-local handler).

export const SLASH_COMMANDS = [
  { name: '/help',    desc: 'open the keymap reference' },
  { name: '/cost',    desc: 'show this session\'s cost in a toast' },
  { name: '/usage',   desc: 'show plan-side rate-limit usage (5h + 7d)' },
  { name: '/compact', desc: 'ask session for a summary (review before /clear)' },
  { name: '/compact-restart', desc: 'summarize → kill → relaunch with summary as first message (Layer 1)' },
  { name: '/clear',   desc: 'kill + restart session in same slot (no summary, fresh start)' },
  { name: '/remember', desc: '<text> — append a dated note to .mc/MEMORY.md (Layer 2)' },
  { name: '/memory',  desc: 'show this repo\'s .mc/MEMORY.md in the session tail' },
  { name: '/mcp',     desc: 'list MCP servers attached to the focused session (Layer 3)' },
  { name: '/perm',    desc: '<mode> — change this session\'s permission mode' },
  { name: '/note',    desc: '<text> — drop a local annotation in the log' },
  { name: '/approve', desc: 'send a generic "continue" reply' },
  { name: '/pause',   desc: 'SIGSTOP this session' },
  { name: '/resume',  desc: 'SIGCONT a paused session' },
  { name: '/kill',    desc: 'terminate this session (SIGTERM)' },
  { name: '/quit',    desc: 'close the zoom view (same as esc)' },
];

// Returns the subset of commands whose name starts with the first
// whitespace-separated token of `line` (case-insensitive). Returns []
// when the line doesn't begin with `/` so callers can use truthiness on
// the result length to drive dropdown visibility.
export function matchSlash(line) {
  const t = (line || '').trim();
  if (!t.startsWith('/')) return [];
  const firstToken = t.split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(firstToken));
}
