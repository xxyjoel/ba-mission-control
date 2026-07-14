// server/eventShapes.mjs — pure helpers for shaping claude session
// events, shared between the stream-json parser in agent.mjs and the
// JSONL connector that will eventually replace it.
//
// Lives in its own file so server modules can import these without
// pulling in the whole Agent class (which would create circular
// imports during the single-pipeline rewrite). See
// .claude/plans/single-pipeline-rewrite.md task A3.

// Tools that spawn a parallel sub-agent / fan-out we count on the card.
// Shared by both pipelines (agent.mjs stream-json + jsonlConnector) so the
// tracking stays identical. See tui/Card.jsx ⋔{n} indicator.
export const SUBAGENT_TOOLS = new Set(['Task', 'Workflow']);

// Human-readable label for an in-flight sub-agent, from its tool_use input.
export function subagentLabel(name, input) {
  if (name === 'Workflow') return String(input?.name || 'workflow').slice(0, 40);
  // Task: prefer the short description, fall back to the agent type.
  return String(input?.description || input?.subagent_type || 'subagent').slice(0, 40);
}

// Turn an opaque tool_use event into a short one-line summary for
// FleetLog / Ctrl+T tools strip / card preview. Order of fallback
// checks is deliberate — Bash's `command` is the most useful single
// field; Edit/Read/Write/Glob have `file_path` or `path`; Grep has
// `pattern`; WebFetch has `url`; TodoWrite et al. fall back to a
// truncated JSON dump.
export function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return `pattern=${input.pattern}`;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  return JSON.stringify(input).slice(0, 120);
}
