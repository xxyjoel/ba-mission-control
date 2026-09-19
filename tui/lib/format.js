// tui/lib/format.js — rendering primitives for bars, sparklines, sizes.
//
// All of these output STRINGS (no React) so they can be composed inside
// <Text> nodes — Ink only renders plain strings inside Text, no nested
// components. Color is applied at the caller via <Text color="cyan">.

import { homedir } from 'node:os';
// 0408/R7: measure DISPLAY width (terminal cells), not graphemes. string-width
// is already in the tree as Ink's own dependency — Ink lays text out with it,
// so measuring with anything else is what made padCol/trunc disagree with the
// renderer (a 20-"grapheme" CJK name is 26 cells wide and wrapped the row).
import stringWidth from 'string-width';

const BLOCK = '█';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK = '▁▂▃▄▅▆▇█';

// 0409: the display layer's marker vocabulary. Every visual traces back to a
// measured value from a live feed; where a value is genuinely unmeasured the
// UI must SAY so, visibly different from a real zero.
//
//   UNKNOWN ('?')   — no measurement exists. NOT the same glyph as a real 0.
//   ESTIMATED ('~') — a real number derived from an INHERITED input (already
//                     in use for costs priced off an estimatedPricing row).
//
// One constant so Card / Header / Aggregate / StatusBar / Zoom cannot drift
// into three different ways of spelling "we don't know". `?` was already the
// house spelling (Aggregate's `↻{fmtReset(...) || '?'}`); this just names it.
export const UNKNOWN = '?';
export const ESTIMATED = '~';

// unknownIf — pick the marker or the formatted value in one expression, so a
// caller can't accidentally render `0` for a missing measurement:
//   unknownIf(agent.spawnedAt == null, () => fmtDurShort(now - agent.spawnedAt))
export function unknownIf(isUnknown, fmt) {
  return isUnknown ? UNKNOWN : fmt();
}

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
  // 0408/M3: millions unit — a 224M cache-read count rendered as "224001.6k".
  // Behavior below 1M is unchanged (pinned by tests/lib/format.test.mjs).
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
};

export const fmtMoney = (n) => '$' + (n || 0).toFixed(2);

// fmtMem — RSS KiB → compact "182M" / "1.4G" for the per-card proc stats
// (0387). Sub-MiB rounds to "0M"; the card hides the readout until the
// first sample lands so that never shows for a live process.
export function fmtMem(kb) {
  const mb = (kb || 0) / 1024;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'G';
  return Math.round(mb) + 'M';
}

// 0408/R7: fast-path guard — printable ASCII is always 1 cell per code unit,
// so `s.length <= budget` proves the string fits without calling string-width.
// Anything else (CJK, emoji, combining marks) must be measured in cells.
const NON_ASCII_RX = /[^\x20-\x7e]/;

export function trunc(s, w) {
  s = s == null ? '' : String(s);
  // Fast path: printable-ASCII with code-unit length ≤ w always fits. This
  // keeps the common render-path call cheap; only wide/over-long strings get
  // measured. (A single CJK char is 1 code unit but 2 CELLS, so the old
  // `s.length <= w` shortcut was itself part of the R7 defect.)
  if (s.length <= w && !NON_ASCII_RX.test(s)) return s;
  if (stringWidth(s) <= w) return s;
  // 0010/0408: cut on grapheme boundaries, budgeted in display CELLS, so a
  // multi-byte cluster is never split and a wide glyph never overflows the
  // column. The ellipsis takes 1 cell of the budget.
  const budget = Math.max(0, w - 1);
  let out = '', used = 0;
  for (const seg of graphemes(s)) {
    const cw = stringWidth(seg);
    if (used + cw > budget) break;
    out += seg;
    used += cw;
  }
  return out + '…';
}

// padCol — fit a string into exactly `width` display CELLS: grapheme-safe
// truncate if too long, space-pad if too short. Used for fixed-width columns
// (e.g. the FleetLog name column) so a multi-byte name is never split mid-
// character AND a wide-glyph name never misaligns every column to its right.
// (0024, rewidthed by 0408/R7: cells, not graphemes.)
export function padCol(s, width) {
  s = s == null ? '' : String(s);
  if (!NON_ASCII_RX.test(s)) {
    if (s.length >= width) return s.slice(0, width);
    return s + ' '.repeat(width - s.length);
  }
  let out = '', used = 0;
  for (const seg of graphemes(s)) {
    const cw = stringWidth(seg);
    if (used + cw > width) break; // a straddling wide glyph is dropped, then padded
    out += seg;
    used += cw;
  }
  return out + ' '.repeat(Math.max(0, width - used));
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
//      OSC (window-title AND OSC-52 clipboard-write), CSI, DCS/SOS/PM/APC
//      string payloads, their 8-bit C1 single-byte forms (U+0080–U+009F —
//      xterm.js parses U+009B as CSI and U+009D as OSC, no ESC needed), other
//      ESC-introduced forms (charset/keypad designators), plus stray C0
//      control bytes (CR/BEL/NUL/DEL/lone-ESC). Newline/tab runs collapse to
//      one space — every caller renders a one-row slot (0408/R5). Session
//      content is
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
const OSC_RX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|)?/g; // OSC incl. OSC-52 clipboard / title (BEL, 7-bit ST or C1 ST terminated)
// 0408/S3: 7-bit DCS/SOS/PM/APC — string-payload escapes whose body would
// otherwise leak as printable text (e.g. a sixel DCS left "q#0;2;0;0;0~~").
const DCS7_RX = /\x1b[PX^_][^\x07\x1b]*(?:\x07|\x1b\\|)?/g;
const CSI_RX = /\x1b\[[0-?]*[ -/]*[@-~]/g;             // CSI (color/cursor), full param/intermediate grammar
// 0408/S3: 8-bit C1 forms. xterm.js parses U+009B as CSI and U+009D as OSC, so
// an attacker can drop the ESC byte entirely and the old 7-bit strippers never
// fired — the payload reached the host terminal (escape-leak.mjs / ink-c1.mjs).
// String-type C1s (DCS U+0090, SOS U+0098, OSC U+009D, PM U+009E, APC U+009F)
// consume their payload through ST (U+009C) or BEL — or to end-of-string when
// a length-bounded preview truncated the terminator away.
const C1_STR_RX = /[-][^\x07]*(?:|\x07)?/g;
const C1_CSI_RX = /[0-?]*[ -/]*[@-~]/g;          // C1 CSI: params + final are part of the sequence
const ESCSEQ_RX = /\x1b[@-Z\\-_]|\x1b[ -/]*[0-~]/g;     // other Fe + nF/Fp/Fs escapes
// C0 except \t/\n (collapsed to a space below, before this sweep) PLUS the
// whole C1 range U+0080–U+009F (any stray 8-bit control that wasn't a
// recognised sequence introducer — e.g. NEL U+0085). (0408/S3 widened)
const CTRL_RX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const PATH_RX = /(\/[^\s/]+){2,}/g;
const UUID_RX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JSON_OBJ_RX = /\{[^{}\n]{40,}\}/g;
const JSON_ARR_RX = /\[[^\[\]\n]{40,}\]/g;
const HOME = (() => { try { return homedir(); } catch { return null; } })();

export function humanize(text) {
  if (text == null) return '';
  let out = String(text);
  out = out.replace(C1_STR_RX, '');
  out = out.replace(OSC_RX, '');
  out = out.replace(DCS7_RX, '');
  out = out.replace(CSI_RX, '');
  out = out.replace(C1_CSI_RX, '');
  out = out.replace(ESCSEQ_RX, '');
  // 0408/R5: every humanize() caller renders into a ONE-ROW slot (Card rows,
  // FleetLog rows, Zoom todo lines, toasts). A literal newline/tab in the text
  // becomes an extra unbudgeted frame row (or an Ink 8-cell tab jump), so a
  // 3-line Bash command took 3 rows of a 1-row log slot. Collapse each run to
  // a single space BEFORE the control sweep (CR sits inside CTRL_RX's range).
  out = out.replace(/[\r\n\t]+/g, ' ');
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
