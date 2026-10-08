// server/permissionModes.mjs — the permission modes claude accepts, in one place.
//
// 0439: claude reports its mode on hook payloads (`permission_mode`) and on
// transcript lines (`permissionMode`). Both come from files on disk, so they
// are untrusted: a value is applied to agent.permissionMode only when it is one
// of these strings. Otherwise sessionStore would save it and the next resume
// would pass it to `claude --permission-mode`.
//
// Import-free on purpose: the pure transcript parser
// (jsonlConnector) and the hook tailer both import it.

export const CLAUDE_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']);

// knownClaudeMode(v) → v when it is a mode claude accepts, else null.
export function knownClaudeMode(v) {
  return typeof v === 'string' && CLAUDE_PERMISSION_MODES.includes(v) ? v : null;
}
