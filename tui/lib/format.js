// tui/lib/format.js — rendering primitives for bars, sparklines, sizes.
//
// All of these output STRINGS (no React) so they can be composed inside
// <Text> nodes — Ink only renders plain strings inside Text, no nested
// components. Color is applied at the caller via <Text color="cyan">.

import { homedir } from 'node:os';

const BLOCK = '█';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK = '▁▂▃▄▅▆▇█';

// 0010: grapheme segmenter for trunc(). Cached at module scope — constructing
// one per call would be costly on the hot render path. Falls back to a
// codepoint spread (surrogate-pair safe, not ZWJ-cluster safe) where Intl
// .Segmenter is unavailable.
const GRAPHEME_SEG = (() => {
  try { return new Intl.Segmenter(undefined, { granularity: 'grapheme' }); }
  catch { return null; }
})();
function graphemes(s) {
  if (!GRAPHEME_SEG) return [...s];
  const out = [];
  for (const { segment } of GRAPHEME_SEG.segment(s)) out.push(segment);
  return out;
}

// Eighths-block progress bar. Returns { full, partial, empty } character counts.
// The caller composes the colored cells.
export function bar(value, width) {
  const v = Math.max(0, Math.min(1, value));
  const total = v * width;
  const full = Math.floor(total);
  const frac = Math.round((total - full) * 8);
  const partial = EIGHTHS[frac] || '';
  const empty = Math.max(0, width - full - (partial ? 1 : 0));
  return { full, partial, empty };
}

// Build a colored bar as an array of { char, kind } cells. The caller maps
// each cell to a colored <Text> span using the theme. Threshold gets a literal '│'.
export function barCells({ value, width, threshFrac }) {
  const b = bar(value, width);
  const cells = [];
  for (let i = 0; i < b.full; i++) cells.push({ char: BLOCK, kind: 'full' });
  if (b.partial) cells.push({ char: b.partial, kind: 'partial' });
  for (let i = 0; i < b.empty; i++) cells.push({ char: '·', kind: 'empty' });
  while (cells.length < width) cells.push({ char: '·', kind: 'empty' });
  if (typeof threshFrac === 'number' && threshFrac >= 0 && threshFrac <= 1) {
    const tCol = Math.min(width - 1, Math.round(threshFrac * width));
    if (cells[tCol]) cells[tCol] = { char: '│', kind: 'thresh' };
  }
  return cells.slice(0, width);
}

// Sparkline: maps each sample to one of 8 levels. Returns a string.
export function sparkLine(values, width) {
  if (!values || !values.length) return '';
  const slice = values.slice(-width);
  // 0106: all-zero (or no-activity) input renders nothing, not a flat row of
  // low blocks — a baseline sparkline reads as activity the agent doesn't have.
  if (slice.every(v => !v)) return '';
  const max = Math.max(...slice, 1);
  return slice.map(v => SPARK[Math.min(7, Math.max(0, Math.round((v / max) * 7)))]).join('');
}

export const fmtK = (n) => {
  if (n == null || !isFinite(n)) return '0';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
};

export const fmtMoney = (n) => '$' + (n || 0).toFixed(2);

export function trunc(s, w) {
  s = s == null ? '' : String(s);
  // Fast path: code-unit length ≤ w ⇒ grapheme count ≤ w (graphemes never
  // exceed code units), so the string fits — no segmentation needed. This keeps
  // the common render-path call cheap; only over-long strings get segmented.
  if (s.length <= w) return s;
  // 0010: slice on grapheme boundaries so a multi-byte cluster (surrogate-pair
  // emoji, combining marks, ZWJ sequences) is never cut mid-character.
  const g = graphemes(s);
  if (g.length <= w) return s;
  return g.slice(0, Math.max(0, w - 1)).join('') + '…';
}

// padCol — fit a string into exactly `width` grapheme cells: grapheme-safe
// truncate if too long, space-pad if too short. Used for fixed-width columns
// (e.g. the FleetLog name column) so a multi-byte name is never split mid-
// character by a code-unit padEnd/slice. (0024)
export function padCol(s, width) {
  s = s == null ? '' : String(s);
  const g = graphemes(s);
  if (g.length >= width) return g.slice(0, width).join('');
  return g.join('') + ' '.repeat(width - g.length);
}

export function fmtClock(ts, use24 = true) {
  const d = new Date(ts);
  if (use24) return d.toISOString().slice(11, 19);
  let h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ap}`;
}

// humanize — sanitize a tier-2 (machine-flavor) preview line so the
// human scanning a Card / FleetLog / Zoom tail sees signal instead of
// the worst of the raw text. Specifically:
//
//   1. Strip ALL terminal escape sequences — not just CSI color codes:
//      OSC (window-title AND OSC-52 clipboard-write), CSI, other
//      ESC-introduced forms (charset/keypad designators), plus stray C0
//      control bytes (CR/BEL/NUL/DEL/lone-ESC). Session content is
//      attacker-influenceable (a file claude Read()s, a tool-name, an
//      api-error cause string) and is painted to the user's REAL
//      terminal even in the non-zoomed fleet view — an OSC-52 in that
//      content could silently write the user's clipboard. (0181)
//   2. Collapse the user's $HOME prefix to `~`.
//   3. Truncate any path-like substring longer than 60 chars to `…/leaf`.
//   4. Shorten any 36-char canonical UUID to its 8-char prefix + `…`.
//   5. Collapse any { ... } or [ ... ] payload longer than 40 chars
//      between the braces to `{…}` / `[…]`.
//
// Idempotent: humanize(humanize(x)) === humanize(x). The output is
// always a short scannable string suitable for a single-line preview.
// Tier-1 entries (user prompts, assistant prose) are NOT routed
// through this — those are the things the human actually wants
// verbatim.
//
// Escape strippers, applied in order. OSC first (it greedily consumes its
// own payload up to a BEL/ST terminator — or to end-of-string when a
// length-bounded preview truncates it before the terminator); then CSI;
// then any remaining single ESC-introduced sequence; then a final sweep
// of lone C0 control bytes (which mops up a bare ESC too).
const OSC_RX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;   // OSC incl. OSC-52 clipboard / title
const CSI_RX = /\x1b\[[0-?]*[ -/]*[@-~]/g;             // CSI (color/cursor), full param/intermediate grammar
const ESCSEQ_RX = /\x1b[@-Z\\-_]|\x1b[ -/]*[0-~]/g;     // other Fe + nF/Fp/Fs escapes
const CTRL_RX = /[\x00-\x08\x0b-\x1f\x7f]/g;            // C0 except \t (0x09) and \n (0x0a); incl. CR, BEL, lone ESC, DEL
const PATH_RX = /(\/[^\s/]+){2,}/g;
const UUID_RX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JSON_OBJ_RX = /\{[^{}\n]{40,}\}/g;
const JSON_ARR_RX = /\[[^\[\]\n]{40,}\]/g;
const HOME = (() => { try { return homedir(); } catch { return null; } })();

export function humanize(text) {
  if (text == null) return '';
  let out = String(text);
  out = out.replace(OSC_RX, '');
  out = out.replace(CSI_RX, '');
  out = out.replace(ESCSEQ_RX, '');
  out = out.replace(CTRL_RX, '');
  if (HOME) out = out.split(HOME).join('~');
  out = out.replace(PATH_RX, (p) => {
    if (p.length <= 60) return p;
    const leaf = p.substring(p.lastIndexOf('/') + 1);
    return `…/${leaf}`;
  });
  out = out.replace(UUID_RX, (m) => m.slice(0, 8) + '…');
  out = out.replace(JSON_OBJ_RX, '{…}');
  out = out.replace(JSON_ARR_RX, '[…]');
  return out;
}

export function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Compact, variable-length duration for stat chips — "2h14m", "12m", "45s".
// Unlike fmtDuration (fixed HH:MM:SS), this drops leading zero units so a
// card's vitals row stays short. Negative/NaN → "0s".
export function fmtDurShort(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
