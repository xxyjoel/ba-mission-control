// server/providers/cursor/models.mjs — Cursor --list-models → catalog.
//
// Re-exports the dataseam parsers from tui/lib/models.js and adds the
// refresh path that probes the live CLI and calls registerProviderModels.

import { execFile } from 'node:child_process';
import { getProvider } from '../index.mjs';
import {
  parseCursorModelList,
  registerProviderModels,
  cursorCliArg,
} from '../../../tui/lib/models.js';

export { parseCursorModelList, registerProviderModels, cursorCliArg };

// cursorModelArg — spawn-time helper; same strip as cursorCliArg.
export function cursorModelArg(modelId) {
  return cursorCliArg(modelId);
}

const LIST_TIMEOUT_MS = 8000;

function defaultExec(bin, args, { timeout = LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

// refreshCursorModels — run `cursor-agent --list-models`, parse, register.
// Injectable `exec(bin, args) → Promise<stdout>` so tests never spawn.
export async function refreshCursorModels({ exec = defaultExec } = {}) {
  const bin = getProvider('cursor').bin();
  const out = await exec(bin, ['--list-models'], { timeout: LIST_TIMEOUT_MS });
  const models = parseCursorModelList(out);
  registerProviderModels('cursor', models);
  return models;
}
