// server/providers/cursor/index.mjs — Cursor provider factory for Fleet.

import { CursorAgent, CURSOR_RESERVED_KEYS } from './cursorAgent.mjs';

export { CursorAgent, CURSOR_RESERVED_KEYS };
export {
  detectTrustPrompt, detectReady, detectWorking, detectApproval,
} from './ptySignals.mjs';
export { startCursorTranscriptTailer, findTranscriptPath, parseCursorLine } from './transcriptTailer.mjs';
export { refreshCursorModels, parseCursorModelList, cursorModelArg } from './models.mjs';

// createCursorAgent — Fleet agentFactories.cursor entry point.
// Mints a chat id when the launch record has none (create-chat).
export function createCursorAgent(opts = {}) {
  const agent = new CursorAgent(opts);
  return agent;
}

// Prefer async mint before start so create-chat's Promise path works.
export async function createCursorAgentReady(opts = {}) {
  const agent = new CursorAgent(opts);
  if (!agent.sessionId) await agent.ensureSessionId();
  return agent;
}
