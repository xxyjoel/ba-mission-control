// tui/lib/plugins.js — central registry of mc's memory-management
// "plugins". Each entry declares:
//   - key      : the settings.json field that toggles it (boolean)
//   - label    : short display name in the Settings PLUGINS tab
//   - layer    : 1 | 2 | 3 — which memory layer the feature targets
//                (see docs/audit/MEMORY.md for the layer model)
//   - default  : on/off out of the box
//   - desc     : single-line summary the Settings UI renders
//   - help     : 2-3 sentence "what does this do" shown when expanded
//
// To add a new plugin: append an entry here, ensure the corresponding
// setting key exists in SETTINGS_DEFAULTS (in lib/settings.js), and
// gate the feature's runtime code with `settings.<key>`.

export const PLUGINS = [
  // ─── Layer 1 — in-session context (claude's 200k window) ───
  {
    key: 'plugin_compactRestart',
    label: '/compact-restart · one-shot summarize + relaunch',
    layer: 1,
    default: true,
    desc: 'Summarize → kill → relaunch focused session with summary injected',
    help: 'When you run /compact-restart in a Zoom composer, mc asks the session for a concise summary, waits for it, then kills + relaunches the session with the summary as the first user message. Frees the full 200k context window while preserving continuity.',
  },
  {
    key: 'plugin_dedupeToolOutput',
    label: 'Tool-output dedupe in tail',
    layer: 1,
    default: false,
    desc: 'Collapse repeated tool outputs (git status, ls) into "[deduped]" markers',
    help: 'Many sessions hammer the same read-only tools repeatedly and the outputs are identical bytes. With this on, mc hashes each tool result and replaces duplicate bodies in the tail with a single-line marker. Reduces visual noise + the size of any future /compact summary input.',
  },
  // ─── Layer 2 — cross-session memory (between sessions in a repo) ───
  {
    key: 'plugin_projectMemory',
    label: '.mc/MEMORY.md auto-inject',
    layer: 2,
    default: true,
    desc: 'On launch, prepend the focused repo\'s .mc/MEMORY.md to the first message',
    help: 'mc looks for .mc/MEMORY.md in the launched cwd. If present, its contents are prepended to whatever prompt you send first (with a "── project memory ──" separator). Append to it with :remember "X". This is like CLAUDE.md but mc-owned and per-repo, so it ships only when you opt-in.',
  },
  {
    key: 'plugin_vectorRecall',
    label: ':recall · semantic search across prior transcripts',
    layer: 2,
    default: false,
    desc: 'Index ~/.local/state/claude-mc/sessions/*.jsonl into a local vector DB; :recall <q> searches it',
    help: 'After each session closes, its transcript is chunked + embedded into a local sqlite-vec index. :recall <query> returns top hits across all prior sessions, surfacing past decisions, code snippets, and rationale. Requires sqlite-vec; not yet wired (stub today).',
  },
  // ─── Layer 3 — external knowledge (codebase / docs / chat) ───
  {
    key: 'plugin_mcpAware',
    label: 'MCP server inventory · :mcp · chip on cards',
    layer: 3,
    default: true,
    desc: 'List MCP servers attached to focused session; surface a chip on Card',
    help: 'mc reads ~/.claude/.mcp.json + per-project .mcp.json to list which MCP servers claude has attached (cocoindex, github, etc.). :mcp toasts the list for the focused session; an "MCP·N" chip appears on the Card so you know retrieval is wired.',
  },
  {
    key: 'plugin_recallSlash',
    label: '/recall slash routes to MCP retrieval (when available)',
    layer: 3,
    default: false,
    desc: 'If an MCP retrieval server is attached, /recall <q> dispatches to it',
    help: 'Heuristic shortcut: when the focused session has a cocoindex-code (or similar) MCP server attached, typing /recall <query> in Zoom sends a structured prompt that nudges claude to call the MCP retrieval tool, rather than answering from session memory. Off by default until you confirm your MCP setup.',
  },
];

// Look up an entry by key. Returns null if unknown.
export function pluginByKey(key) {
  return PLUGINS.find(p => p.key === key) || null;
}

// True when the plugin is enabled in the given settings object. Missing
// setting key falls back to the plugin's declared default.
export function isPluginEnabled(settings, key) {
  const p = pluginByKey(key);
  if (!p) return false;
  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    return !!settings[key];
  }
  return p.default;
}

// Inject defaults into a settings object so a fresh install gets the
// declared defaults without the user touching the file.
export function applyPluginDefaults(target) {
  for (const p of PLUGINS) {
    if (!Object.prototype.hasOwnProperty.call(target, p.key)) {
      target[p.key] = p.default;
    }
  }
  return target;
}
