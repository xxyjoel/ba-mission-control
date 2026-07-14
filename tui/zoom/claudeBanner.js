// tui/zoom/claudeBanner.js — heuristic matcher for Claude Code's OWN
// "update available" banner.
//
// When mc zooms a slot it renders claude's real PTY cell-for-cell. Claude
// prints its own update notice into that body region, where it encroaches on
// the conversation. mc can't move text claude paints — but it can recognise
// that row, blank it from the body, and surface a discrete indicator on the
// right of the zoom header instead (see PtyPane / Zoom).
//
// The match is intentionally narrow: it must mention "update"/"upgrade" next to
// an install/version cue, or be the literal `claude update` / npm install line.
// This avoids hiding a user's prose that merely contains the word "update".
// Tunable + gated behind the `hideClaudeUpdateBanner` setting (default on), so a
// false positive is a setting toggle away, and the exact wording can be widened
// here in one place if claude changes its banner.

const PATTERNS = [
  /\b(update|upgrade)\b[^\n]*\b(available|installed|now|to\s+\d|restart)\b/i,
  /\brestart\b[^\n]*\bto\s+(apply|update)\b/i,
  /\b(new|newer)\s+version\b/i,
  /\bclaude\s+update\b/i,
  /npm\s+i(?:nstall)?\s+-g[^\n]*claude-code/i,
];

const VERSION_RE = /\bv?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\b/;

// Returns { version, text } when rowText looks like claude's update banner,
// else null. `version` is the first semver-ish token on the row (or null).
export function matchUpdateBanner(rowText) {
  if (typeof rowText !== 'string') return null;
  const t = rowText.trim();
  if (!t) return null;
  if (!PATTERNS.some((re) => re.test(t))) return null;
  const m = t.match(VERSION_RE);
  return { version: m ? m[1] : null, text: t.slice(0, 80) };
}
