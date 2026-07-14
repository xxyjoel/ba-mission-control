// tui/lib/usage.js — read claude's plan-side rate-limit telemetry.
//
// Claude Code writes the same numbers that drive `/usage` to a JSON file
// at ~/.claude/abtop-rate-limits.json. Reading that file gives us the
// real Anthropic-side weekly usage (% of Max-plan quota consumed) and the
// 5-hour rolling window — both of which are far more useful than our own
// locally-tracked $ figure since they reflect every claude invocation on
// this machine, not just sessions launched from Mission Control.
//
// Shape (observed against Claude Code 2.1.x):
//   {
//     "source": "claude",
//     "updated_at": 1779829045,
//     "five_hour": { "used_percentage": 1,  "resets_at": 1779846600 },
//     "seven_day": { "used_percentage": 29, "resets_at": 1780070400 }
//   }
//
// File is updated whenever `claude` runs, so we just re-read it on
// demand. We avoid imports beyond fs/os/path so this module loads
// before Ink is ready.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_FILE = join(homedir(), '.claude', 'abtop-rate-limits.json');

// Read the rate-limits JSON, or return null if claude hasn't written one
// yet (fresh install / no sessions ever run on this machine).
export function readUsage() {
  try {
    if (!existsSync(USAGE_FILE)) return null;
    const raw = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    const fiveH = raw.five_hour || {};
    const sevenD = raw.seven_day || {};
    return {
      updatedAt: (raw.updated_at || 0) * 1000,
      fiveHour: {
        usedPct: Number(fiveH.used_percentage) || 0,
        resetsAt: (fiveH.resets_at || 0) * 1000,
      },
      sevenDay: {
        usedPct: Number(sevenD.used_percentage) || 0,
        resetsAt: (sevenD.resets_at || 0) * 1000,
      },
      source: raw.source || 'claude',
    };
  } catch {
    return null;
  }
}

// Compact "resets in 2d 14h" / "resets in 47m" string. Returns null when
// the timestamp is missing or in the past.
export function fmtReset(unixMs, now = Date.now()) {
  if (!unixMs) return null;
  const ms = unixMs - now;
  if (ms <= 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}
