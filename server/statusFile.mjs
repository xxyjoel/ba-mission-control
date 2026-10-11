// server/statusFile.mjs — derive the per-session NDJSON status-file path.
//
// MC owns ~/.local/state/claude-mc/status/<sid>.ndjson — distinct from
// claude's transcript space (~/.claude/projects/…) so the two namespaces
// never collide. Both the emitter (0207) and the tailer must import from
// here so the path is computed in exactly one place.
//
// UUID guard mirrors sessionFileTailer.mjs (0181) so a tampered/garbage
// session id read off disk can't traverse outside the state dir.

import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// Canonical UUID shape — matches sessionFileTailer.mjs UUID_SHAPE exactly.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Base dir for all MC-owned per-session status files.
// 0437: MC_STATUS_DIR (absolute paths only) overrides it. The emitter runs as
// claude's child and inherits claude's env, so a claude started under a
// different HOME (the opt-in real-claude tests: real HOME for the login, mc
// sandboxed) would otherwise write its status files into that other home.
// PtyAgent's caller sets it in claude's env to mc's own dir so both sides agree.
const STATUS_ENV = process.env.MC_STATUS_DIR;
export const STATUS_DIR = STATUS_ENV && isAbsolute(STATUS_ENV)
  ? STATUS_ENV
  : join(homedir(), '.local', 'state', 'claude-mc', 'status');

/**
 * Return the absolute path to the NDJSON status file for a given session.
 * Throws if sessionId is not a canonical UUID string.
 *
 * @param {{ sessionId: string }} opts
 * @returns {string} absolute path: ~/.local/state/claude-mc/status/<sid>.ndjson
 */
export function statusFilePath({ sessionId } = {}) {
  if (typeof sessionId !== 'string' || !UUID_SHAPE.test(sessionId)) {
    throw new Error(
      `statusFilePath: refusing non-UUID sessionId ${JSON.stringify(sessionId)}`,
    );
  }
  return join(STATUS_DIR, `${sessionId}.ndjson`);
}
