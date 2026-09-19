// tui/lib/TextField.jsx — single-/multi-line text input with cursor
// positioning.
//
// What this supports:
// - Characters insert AT the cursor (not always at the end)
// - ←/→ move the cursor one char; Home/End jump to current-line bounds
// - Backspace deletes the char BEFORE the cursor; Delete the one AT it
// - Multi-line via Ctrl+J / ⌥↵ / Shift+↵ — newline inserts at cursor
// - Plain Return submits
// - Esc cancels (deferred 80ms to merge a split ⌥↵)
//
// What it deliberately does NOT do yet (tracked in audit/IMPROVEMENTS.md):
// - ↑/↓ vertical motion — Zoom uses these for history recall; needs a
//   parent-coordinated handoff (#48-49 in IMPROVEMENTS)
// - Word jumps (Ctrl+Left/Right), selection, undo/redo, paste — #10-26
// - Cursor position is local state; if the parent replaces `value`
//   externally (e.g. history recall), cursor resets to end of new value.
//
// Rendering: we split `value` at the cursor into before/after, then by
// '\n' into lines. The caret-bearing row is `lastOfBefore + caret +
// firstOfAfter`; earlier lines render above, later lines below. The
// caret-bearing row uses wrap="truncate-start" so a long line keeps the
// caret on-screen by scrolling LEFT (with leading ellipsis), not by
// pushing the caret off the right edge — fixes "typing blind past one
// terminal width" (GH #1).

import React, { useState, useEffect, useRef } from 'react';
import { Text, Box, useInput } from 'ink';
// Runtime-toggleable; flipped on/off via the :debug-keys verb at any
// time. Initial state honored from MC_DEBUG_KEYS=1 env so existing
// launches keep working.
import { logKey } from './debugKeys.js';
import { normalizeTypedText } from './typedText.js';

const ESC_MERGE_WINDOW_MS = 80;

// Pure cursor-motion helpers. Each takes (value, cursor) and returns the
// new cursor index. No-op if motion would leave the buffer.
function moveHome(value, cursor) {
  const lastNL = value.lastIndexOf('\n', cursor - 1);
  return lastNL + 1;
}
function moveEnd(value, cursor) {
  const nextNL = value.indexOf('\n', cursor);
  return nextNL === -1 ? value.length : nextNL;
}
// Word boundary = transition between alnum/underscore and other chars.
// `prevWordBoundary` walks LEFT past whitespace/punct, then past the
// preceding word, landing at the word's start (Option+Left convention).
// `nextWordBoundary` mirrors right (Option+Right).
const WORD_CHAR = /[A-Za-z0-9_]/;
function prevWordBoundary(value, cursor) {
  let i = Math.max(0, Math.min(value.length, cursor)) - 1;
  while (i >= 0 && !WORD_CHAR.test(value[i])) i--;
  while (i >= 0 &&  WORD_CHAR.test(value[i])) i--;
  return i + 1;
}
function nextWordBoundary(value, cursor) {
  let i = Math.max(0, Math.min(value.length, cursor));
  while (i < value.length && !WORD_CHAR.test(value[i])) i++;
  while (i < value.length &&  WORD_CHAR.test(value[i])) i++;
  return i;
}
// Move cursor up one visual line, preserving the column when possible.
// Returns null when there's no prior line (caller should fall through
// to parent — e.g. Zoom history recall).
function moveUp(value, cursor) {
  const lastNL = value.lastIndexOf('\n', cursor - 1);
  if (lastNL === -1) return null;
  const col = cursor - (lastNL + 1);
  const prevNL = value.lastIndexOf('\n', lastNL - 1);
  const prevStart = prevNL + 1;
  const prevLen = lastNL - prevStart;
  return prevStart + Math.min(col, prevLen);
}
// ── Code-point stepping (0408/I7) ────────────────────────────
// The buffer is a UTF-16 string, so an emoji (or any astral-plane char) is
// TWO code units. Cursor math that steps by one unit splits the surrogate
// pair: backspace after "a😀" left "a\ud83d", and ←-then-type inserted inside
// the pair. All motion/edit below steps by CODE POINT instead.
const isHighSurrogate = (c) => c >= '\uD800' && c <= '\uDBFF';
const isLowSurrogate  = (c) => c >= '\uDC00' && c <= '\uDFFF';
// Index of the code-point boundary at or before i (never lands between a pair).
function snapToBoundary(s, i) {
  return (i > 0 && i < s.length && isLowSurrogate(s[i]) && isHighSurrogate(s[i - 1])) ? i - 1 : i;
}
// One code point left of i (0 at the start).
function prevCodePoint(s, i) {
  if (i <= 0) return 0;
  return (i >= 2 && isLowSurrogate(s[i - 1]) && isHighSurrogate(s[i - 2])) ? i - 2 : i - 1;
}
// One code point right of i (length at the end).
function nextCodePoint(s, i) {
  if (i >= s.length) return s.length;
  return (isHighSurrogate(s[i]) && i + 1 < s.length && isLowSurrogate(s[i + 1])) ? i + 2 : i + 1;
}

// Move cursor down one visual line; null when no next line.
function moveDown(value, cursor) {
  const nextNL = value.indexOf('\n', cursor);
  if (nextNL === -1) return null;
  const lastNL = value.lastIndexOf('\n', cursor - 1);
  const col = cursor - (lastNL + 1);
  const nextStart = nextNL + 1;
  const afterNext = value.indexOf('\n', nextStart);
  const nextLen = (afterNext === -1 ? value.length : afterNext) - nextStart;
  return nextStart + Math.min(col, nextLen);
}

export default function TextField({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = '',
  focus = true,
  color,
  caretColor,
  width,
  // 0408/I6: optional hard cap on rendered rows. A multi-line paste used to
  // render every line, blowing the host modal's height budget (at 80×24 Ink
  // then shrank the column and every other line vanished). With maxRows set,
  // the field renders a fixed-height window of at most maxRows lines that
  // follows the caret, clipped with overflow=hidden.
  maxRows,
}) {
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    if (!focus) return;
    const t = setInterval(() => setBlink(b => !b), 530);
    return () => clearInterval(t);
  }, [focus]);

  // Cursor position in [0, value.length]. Local — parent doesn't need to
  // care unless it externally replaces `value`, in which case the
  // effect below resets us to the new end-of-value.
  const [cursorPos, setCursorPos] = useState(value.length);
  const lastValueRef = useRef(value);

  // 0389: the live edit state, carried between input events in the SAME tick.
  //
  // Ink splits one terminal write into several useInput events (a text run,
  // then one event per control byte, then the next text run), and it delivers
  // all of them before React re-renders. Reading the `value` prop or the
  // `cursorPos` state inside the handler therefore returns the state from
  // BEFORE the burst on every event after the first, so all but the last edit
  // are silently discarded. Human typing never noticed — one event per tick —
  // but dictation does exactly this: macOS speech-to-text revises its guess by
  // sending a run of DEL bytes followed by replacement words. Measured before
  // the fix: "dictate the thing" then 5xDEL + "word" produced
  // "dictate the thingword" — the deletions dropped and the revision glued on.
  //
  // These refs are the authoritative value/cursor during a burst. The prop
  // stays the render source; the effect below resynchronises if the parent
  // hands back something other than what we committed.
  const liveRef = useRef(value);
  const cursorRef = useRef(value.length);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      // The parent changed value out from under us (history recall,
      // submit-clear, etc.). Park the cursor at the new end.
      setCursorPos(value.length);
      lastValueRef.current = value;
      liveRef.current = value;
      cursorRef.current = value.length;
    }
  }, [value]);

  // Clamp once per render so we never index past either bound.
  const safeCursor = Math.min(Math.max(0, cursorPos), value.length);

  // Commit a new value+cursor in a single step. Record what we just sent
  // so the external-change detector above doesn't fire on our own edit.
  const commit = (next, nextCursor) => {
    const clamped = Math.min(Math.max(0, nextCursor), next.length);
    lastValueRef.current = next;
    liveRef.current = next;
    cursorRef.current = clamped;
    onChange(next);
    setCursorPos(clamped);
  };

  // Cursor-only motion. Writes the ref as well as the state so a motion and an
  // edit inside the same burst compose instead of fighting. Snapped to a
  // code-point boundary so vertical motion / word jumps / Home-End can never
  // park the cursor between surrogate halves (0408/I7).
  const setCursor = (next) => {
    const clamped = Math.min(Math.max(0, next), liveRef.current.length);
    const snapped = snapToBoundary(liveRef.current, clamped);
    cursorRef.current = snapped;
    setCursorPos(snapped);
  };

  const escTimerRef = useRef(null);
  useEffect(() => () => {
    if (escTimerRef.current) clearTimeout(escTimerRef.current);
  }, []);

  useInput((input, key) => {
    if (!focus) return;
    logKey(input, key, 'received');
    // Live value/cursor for THIS event — see liveRef above. Never read the
    // `value` prop or `cursorPos` state here: during a burst they are stale.
    const cur = liveRef.current;
    const pos = Math.min(Math.max(0, cursorRef.current), cur.length);

    // Return arriving while an escape is pending → reinterpret as ⌥↵.
    if (key.return && escTimerRef.current) {
      clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
      logKey(input, key, 'newline (esc-then-return merge)');
      commit(cur.slice(0, pos) + '\n' + cur.slice(pos), pos + 1);
      return;
    }

    if (key.escape) {
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = setTimeout(() => {
        escTimerRef.current = null;
        onCancel && onCancel();
      }, ESC_MERGE_WINDOW_MS);
      return;
    }

    if (escTimerRef.current) {
      clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
      onCancel && onCancel();
      return;
    }

    // ── Cursor motion ────────────────────────────────────────
    // Option+Left / Option+Right (macOS) and Ctrl+Left / Ctrl+Right
    // (Linux/Windows) jump by word. Terminal.app + iTerm2 deliver this
    // as `key.meta + arrow`; some setups split it as `\x1bb` / `\x1bf`
    // (Emacs convention) which Ink surfaces as `key.meta + input='b'/'f'`.
    // We accept all four shapes so the binding is reliable.
    if (key.leftArrow && (key.meta || key.ctrl)) {
      setCursor(prevWordBoundary(cur, pos));
      return;
    }
    if (key.rightArrow && (key.meta || key.ctrl)) {
      setCursor(nextWordBoundary(cur, pos));
      return;
    }
    if (key.meta && (input === 'b' || input === 'B')) {
      setCursor(prevWordBoundary(cur, pos));
      return;
    }
    if (key.meta && (input === 'f' || input === 'F')) {
      setCursor(nextWordBoundary(cur, pos));
      return;
    }
    if (key.leftArrow) {
      setCursor(prevCodePoint(cur, pos));
      return;
    }
    if (key.rightArrow) {
      setCursor(nextCodePoint(cur, pos));
      return;
    }
    // Home → Ctrl+A (readline). The raw Home-key escape sequence
    // (\x1b[H / \x1b[1~ / \x1bOH) is NOT delivered to useInput by Ink
    // 5; it's filtered upstream. Document and rely on Ctrl+A.
    if (key.ctrl && input === 'a') {
      setCursor(moveHome(cur, pos));
      return;
    }
    // End → Ctrl+E (readline). Same note re: raw \x1b[F.
    if (key.ctrl && input === 'e') {
      setCursor(moveEnd(cur, pos));
      return;
    }

    // ── Newline inserts (at cursor) ──────────────────────────
    if (key.return && (key.meta || key.shift)) {
      logKey(input, key, 'newline (meta/shift+return)');
      commit(cur.slice(0, pos) + '\n' + cur.slice(pos), pos + 1);
      return;
    }
    if (
      (key.ctrl && input === 'j') ||
      (input === '\n' && !key.meta && !key.shift)
    ) {
      logKey(input, key, 'newline (ctrl+j / raw LF)');
      commit(cur.slice(0, pos) + '\n' + cur.slice(pos), pos + 1);
      return;
    }
    if (key.return) {
      logKey(input, key, 'submit (return)');
      onSubmit && onSubmit(cur);
      return;
    }

    // ── Edit at cursor ───────────────────────────────────────
    // Ink 5 (+ ink-testing-library) maps BOTH `\x7f` (macOS Backspace,
    // DEL) and `\x1b[3~` (forward Delete) to `key.delete=true` with
    // empty input — they're indistinguishable at this layer. We treat
    // both as backspace (delete char BEFORE cursor) since macOS
    // Backspace is overwhelmingly the common case and the old code's
    // contract was already "either flag = delete". Real forward-delete
    // is tracked in audit/IMPROVEMENTS.md (terminal-specific follow-up).
    if (key.backspace || key.delete) {
      if (pos === 0) return;
      // Delete one CODE POINT before the cursor — an emoji goes away whole
      // instead of leaving a lone surrogate half (0408/I7).
      const np = prevCodePoint(cur, pos);
      commit(cur.slice(0, np) + cur.slice(pos), np);
      return;
    }

    // Other ctrl/meta combos: ignore (don't insert as text).
    if (key.ctrl || key.meta) return;
    // Up/Down: when the buffer has multiple lines AND the cursor isn't
    // at the relevant boundary, navigate within the field. At the
    // boundary, fall through (return without consuming) so the parent
    // (e.g. Zoom's composer history recall) handles the keystroke.
    if (key.upArrow) {
      const next = moveUp(cur, pos);
      if (next != null) { setCursor(next); return; }
      return; // at top of field — let parent see ↑ via its own useInput
    }
    if (key.downArrow) {
      const next = moveDown(cur, pos);
      if (next != null) { setCursor(next); return; }
      return; // at bottom of field — parent sees ↓
    }
    // Tab also delegated.
    if (key.tab) return;

    // Insert character(s) at cursor. `input` is a whole text run for a
    // paste or a dictated phrase — inserted atomically, but normalized first:
    // a run can carry an embedded CR or C0 control byte that would otherwise
    // land in the value (0389). Newlines are kept; this field is multi-line.
    if (input && input.length > 0) {
      const text = normalizeTypedText(input, { allowNewlines: true });
      if (!text) return;
      // Snap the splice point to a code-point boundary so typed text can never
      // land between an emoji's surrogate halves (0408/I7).
      const at = snapToBoundary(cur, pos);
      commit(cur.slice(0, at) + text + cur.slice(at), at + text.length);
    }
  }, { isActive: focus });

  const showPlaceholder = !value && placeholder;
  const caret = focus && blink ? '█' : ' ';
  const valueColor = showPlaceholder ? 'gray' : color;

  // Render: split at cursor, then by line. Above lines render naturally,
  // the caret-bearing row uses truncate-start so a long line scrolls
  // LEFT and keeps the caret visible, below lines render naturally.
  const source = showPlaceholder ? placeholder : value;
  const cursorForRender = showPlaceholder ? source.length : safeCursor;
  const beforeCursor = source.slice(0, cursorForRender);
  const afterCursor = source.slice(cursorForRender);
  const beforeLines = beforeCursor.split('\n');
  const afterLines = afterCursor.split('\n');
  let above = beforeLines.slice(0, -1);
  const beforeTail = beforeLines[beforeLines.length - 1] ?? '';
  const afterHead = afterLines[0] ?? '';
  let below = afterLines.slice(1);

  // 0408/I6: window the rows around the caret when a cap is set. The caret
  // row always stays visible; rows scroll off the top (and bottom) instead of
  // growing the field past its budget. When capped, sibling rows truncate
  // rather than wrap so one logical line can never cost two screen rows.
  const cap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : null;
  const totalRows = above.length + 1 + below.length;
  if (cap && totalRows > cap) {
    const caretRow = above.length;
    // Window start: keep the caret row inside [start, start+cap).
    const start = Math.min(Math.max(0, caretRow - cap + 1), totalRows - cap);
    const end = start + cap;
    above = above.slice(start);                      // rows before the caret row
    below = below.slice(0, Math.max(0, end - caretRow - 1)); // rows after it
  }
  const sideWrap = cap ? 'truncate' : 'wrap';

  return (
    <Box
      width={width}
      flexGrow={width ? 0 : 1}
      flexShrink={cap ? 0 : undefined}
      flexDirection="column"
      height={cap ? Math.min(totalRows, cap) : undefined}
      overflow={cap ? 'hidden' : undefined}
    >
      {above.map((line, i) => (
        <Text key={`a${i}`} color={valueColor} wrap={sideWrap}>{line || ' '}</Text>
      ))}
      <Text color={valueColor} wrap="truncate-start">
        {beforeTail}
        {focus && <Text color={caretColor || color}>{caret}</Text>}
        {afterHead}
      </Text>
      {below.map((line, i) => (
        <Text key={`b${i}`} color={valueColor} wrap={sideWrap}>{line || ' '}</Text>
      ))}
    </Box>
  );
}
