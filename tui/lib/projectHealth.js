// tui/lib/projectHealth.js — read a project's Session Health Benchmark score.
//
// The session-benchmarking Stop hook appends one JSON reading per turn to
// <cwd>/.project-health/history.jsonl (composite 0-100 + verdict). ba-mc
// surfaces the latest reading as a per-card chip and a zoom stats line.
//
// Cards re-render on every fleet tick, so reads must be cheap: we cache per
// cwd, re-stat behind a short TTL, and only re-read when the file's mtime
// actually changed. The file grows unbounded (one line/turn), so we tail the
// last TAIL_BYTES rather than slurp the whole thing, and parse complete lines
// from the end (the first line in the window may be cut mid-record).

import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const TTL_MS = 2500;      // don't re-stat the same cwd more often than this
const TAIL_BYTES = 16384; // last ~16KB covers many readings; plenty for last 2

const cache = new Map(); // cwd -> { checkedAt, mtimeMs, data }

// First word of the verdict ("HEALTHY — converging…" -> "HEALTHY").
function verdictWord(v) {
  return String(v || '').split('—')[0].trim().split(/\s+/)[0] || '?';
}

function readTail(path, size) {
  const len = Math.min(size, TAIL_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, Math.max(0, size - len));
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// readProjectHealth(cwd) -> { score, verdict, verdictWord, arrow, timestamp } | null
// `now` is injectable for tests. Returns null when there is no reading yet.
export function readProjectHealth(cwd, now = Date.now()) {
  if (!cwd) return null;
  const path = join(cwd, '.project-health', 'history.jsonl');
  const cached = cache.get(cwd);
  if (cached && now - cached.checkedAt < TTL_MS) return cached.data;

  let st;
  try {
    st = statSync(path);
  } catch {
    cache.set(cwd, { checkedAt: now, mtimeMs: 0, data: null });
    return null;
  }
  if (cached && cached.mtimeMs === st.mtimeMs) {
    cached.checkedAt = now;
    return cached.data;
  }

  let data = null;
  try {
    const lines = readTail(path, st.size).split('\n').filter((l) => l.trim());
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < 2; i--) {
      try { rows.push(JSON.parse(lines[i])); } catch { /* partial leading line */ }
    }
    if (rows.length) {
      const last = rows[0];
      const prev = rows[1];
      // 0409: `Number(last.composite) || 0` reported an UNMEASURED score as 0,
      // which the card renders as `●0` — the worst possible health, not
      // "unknown". It also destroyed a legitimate composite of 0. Keep null for
      // "the reading carries no usable composite" and let the renderers print
      // the unknown marker; a real 0 stays 0.
      const raw = Number(last.composite);
      const score = Number.isFinite(raw) ? raw : null;
      // Trend needs TWO readings. With only one, there is no measured delta —
      // '·' would claim a flat trend we never measured, so the arrow is empty
      // and the chip renders as a bare score. '·' now means exactly one thing:
      // measured, and flat within ±0.5.
      let arrow = '';
      if (score != null && prev && Number.isFinite(Number(prev.composite))) {
        const d = score - Number(prev.composite);
        arrow = d > 0.5 ? '↑' : d < -0.5 ? '↓' : '·';
      }
      data = {
        score,
        verdict: last.verdict || '',
        verdictWord: verdictWord(last.verdict),
        arrow,
        timestamp: last.timestamp || null,
      };
    }
  } catch {
    data = null;
  }
  cache.set(cwd, { checkedAt: now, mtimeMs: st.mtimeMs, data });
  return data;
}

// healthColor(reading, theme) → a theme color for the score chip. By verdict
// word first (matches the session-benchmarking statusline tiers), score as a
// fallback. Shared by the card chip and the zoom stats line.
export function healthColor(h, theme) {
  const w = (h?.verdictWord || '').toUpperCase();
  if (w === 'HEALTHY') return theme.green;
  if (w === 'STABLE')  return theme.cyan;
  if (w === 'DEGRADED' || w === 'CRITICAL') return theme.red;
  // 0409: the score fallbacks used to be `?? 0` (→ red) and `?? 100` (→ green),
  // so a reading with NO composite got a confident color off a fabricated
  // number. An unmeasured score gets a neutral color instead; only a real
  // number picks a tier.
  const s = h?.score;
  if (!Number.isFinite(s)) return theme.dim;
  if (s >= 80) return theme.green;
  if (s < 50)  return theme.red;
  return theme.yellow;
}

// healthScoreText — the `78` / `?` half of the `●78↑` chip. Shared by the Card
// chip and the Zoom stats line so the two cannot spell "unknown" differently.
export function healthScoreText(h) {
  return Number.isFinite(h?.score) ? h.score.toFixed(0) : '?';
}

// Test helper — drop the memoized state so a test can re-read a rewritten file.
export function _resetProjectHealthCache() {
  cache.clear();
}
