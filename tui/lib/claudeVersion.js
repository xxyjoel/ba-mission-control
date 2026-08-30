// tui/lib/claudeVersion.js — probe the on-disk claude CLI version (0333).
//
// Two readers with different freshness needs share this module:
//   - PtyAgent stamps each session with the version its process launched on
//     (cached probe — spawn-time freshness is "since mc booted or the last
//     explicit probe", which is exactly right: the binary a spawn gets is
//     the binary on disk at that moment, and every path that could change
//     it goes through `:update`, which calls probeClaudeVersion(true)).
//   - `:update` compares a FRESH probe against each live session's stamp to
//     report drift (Unix keeps the old inode alive in running processes, so
//     updating the binary on disk changes nothing for live sessions).
//
// CLAUDE_BIN is user-controlled → argv-form execFile only, never a shell
// string (project security rule).

import { execFileSync } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

let cached = null;

/**
 * probeClaudeVersion(fresh = false) → version string ('2.1.220 (Claude Code)')
 * or null when claude isn't on PATH. Cached unless fresh=true.
 */
export function probeClaudeVersion(fresh = false) {
  if (!fresh && cached !== null) return cached;
  try {
    cached = execFileSync(CLAUDE_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim().slice(0, 80) || null;
  } catch {
    cached = null;
  }
  return cached;
}
