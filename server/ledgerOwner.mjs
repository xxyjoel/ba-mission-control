// server/ledgerOwner.mjs — who owns a session, per claude's daemon ledger (0396).
//
// ~/.claude/jobs/<id8>/state.json records background agents (claude.ai bridge
// dispatches, daemon jobs). Dir name = first 8 hex of the owning session id.
// When a `--resume` is refused because a background agent holds the session,
// this lookup turns an opaque failure into an explanation the card can show:
// what state the owner is in and what it was last doing.
//
// Read-only, called only on the refusal path (not a poll) — no steady-state
// I/O cost. Every failure returns null; explaining a refusal must never
// throw into the exit handler.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const JOBS_DIR = join(homedir(), '.claude', 'jobs');

// classifyEarlyExit — pure. Decide whether an exit is claude REFUSING the
// resume because something else owns the session. Anchored on full phrases
// (replayed conversation prose could contain the words "background agent",
// so loose substrings are not acceptable — security review 2026-08-12), but
// tolerant of wording drift across claude versions, ANY exit code (a refusal
// can exit 0), and gated on the exit happening soon after spawn — a genuine
// refusal dies in seconds, before any real session output.
const REFUSAL_RX = new RegExp(
  [
    '(currently|already|is) (running|in use) as a background agent',
    'held by a background agent',
    'in use by (a|another) (background agent|agent|process)',
    'session is (already )?(running|in use|active) (elsewhere|in another)',
  ].join('|'), 'i',
);
export function classifyEarlyExit(probeBuf, msSinceSpawn, windowMs = 20_000) {
  if (!probeBuf) return null;
  if (!(msSinceSpawn >= 0 && msSinceSpawn <= windowMs)) return null;
  return REFUSAL_RX.test(probeBuf) ? 'held-by-agent' : null;
}

/**
 * findLedgerOwner(sessionId) → { state, tempo, detail } | null
 * Matches on the ledger's dir-name convention (first 8 hex of the sid).
 */
export function findLedgerOwner(sessionId) {
  try {
    const id8 = String(sessionId || '').slice(0, 8).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(id8)) return null;
    const raw = readFileSync(join(JOBS_DIR, id8, 'state.json'), 'utf8');
    const s = JSON.parse(raw);
    return {
      state: typeof s.state === 'string' ? s.state.slice(0, 40) : 'unknown',
      tempo: typeof s.tempo === 'string' ? s.tempo.slice(0, 40) : '',
      detail: typeof s.detail === 'string' ? s.detail.slice(0, 120) : '',
    };
  } catch {
    return null;
  }
}
