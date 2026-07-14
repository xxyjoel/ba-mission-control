// tui/lib/projectMemory.js — Layer-2 cross-session memory.
//
// A repo's per-project memory lives at `<cwd>/.mc/MEMORY.md`. mc owns
// the file format; the user owns the content. Plugin gating is the
// caller's responsibility — feature flag `plugin_projectMemory` in
// settings. See tui/lib/plugins.js.
//
// On launch (when enabled): mc reads MEMORY.md from the session's cwd
// and prepends the body to the user's first message with a "── project
// memory ──" separator. The session sees the memory as part of the
// initial turn, not as a system prompt — keeps the surface compatible
// with claude's stream-json wire format.
//
// `:remember "X"` appends a dated bullet to the file. We never read
// outside cwd, never overwrite — append-only.

import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MEMORY_DIR_NAME = '.mc';
export const MEMORY_FILE_NAME = 'MEMORY.md';
const SEPARATOR = '── project memory ──';
const MEMORY_HEADER = '# mc · project memory\n\nAppended by `:remember "..."` from a focused session.\nEach line is a dated note the next mc session in this repo can build on.\n\n---\n';

// Returns the absolute path to <cwd>/.mc/MEMORY.md. Pure path math; no
// I/O. Caller checks existence with `readProjectMemory`.
export function memoryPathFor(cwd) {
  if (!cwd) return null;
  return join(resolve(cwd), MEMORY_DIR_NAME, MEMORY_FILE_NAME);
}

// Returns the raw memory body or null if no file. Always safe to call;
// IO errors map to null so the boot path doesn't fail when a repo has
// no memory file yet (the common case).
export function readProjectMemory(cwd) {
  try {
    const p = memoryPathFor(cwd);
    if (!p || !existsSync(p)) return null;
    const body = readFileSync(p, 'utf8').trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

// Append a dated note. Creates the .mc dir + MEMORY.md on first call.
// Returns { ok, path, bytes } so callers can toast accurately.
export function appendMemoryNote(cwd, note) {
  if (!cwd) return { ok: false, error: 'no cwd' };
  const clean = String(note || '').trim();
  if (!clean) return { ok: false, error: 'empty note' };
  try {
    const dir = join(resolve(cwd), MEMORY_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, MEMORY_FILE_NAME);
    const isNew = !existsSync(p);
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `- **${stamp}** · ${clean}\n`;
    const payload = isNew ? MEMORY_HEADER + '\n' + line : line;
    appendFileSync(p, payload);
    const bytes = statSync(p).size;
    return { ok: true, path: p, bytes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Wrap a user prompt with the project memory body, marked by the
// well-known separator. Idempotent: if the prompt already begins with
// the separator (some other code already injected), we skip.
export function injectMemoryIntoPrompt(prompt, memoryBody) {
  if (!memoryBody) return prompt;
  if (prompt && prompt.startsWith(SEPARATOR)) return prompt;
  return `${SEPARATOR}\n${memoryBody}\n${SEPARATOR}\n\n${prompt || ''}`.trim();
}

export const MEMORY_INJECTION_SEPARATOR = SEPARATOR;
