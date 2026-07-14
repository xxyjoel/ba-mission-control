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
  useEffect(() => {
    if (value !== lastValueRef.current) {
      // The parent changed value out from under us (history recall,
      // submit-clear, etc.). Park the cursor at the new end.
      setCursorPos(value.length);
      lastValueRef.current = value;
    }
  }, [value]);

  // Clamp once per render so we never index past either bound.
  const safeCursor = Math.min(Math.max(0, cursorPos), value.length);

  // Commit a new value+cursor in a single step. Record what we just sent
  // so the external-change detector above doesn't fire on our own edit.
  const commit = (next, nextCursor) => {
    lastValueRef.current = next;
    onChange(next);
    setCursorPos(Math.min(Math.max(0, nextCursor), next.length));
  };

  const escTimerRef = useRef(null);
  useEffect(() => () => {
    if (escTimerRef.current) clearTimeout(escTimerRef.current);
  }, []);

  useInput((input, key) => {
    if (!focus) return;
    logKey(input, key, 'received');

    // Return arriving while an escape is pending → reinterpret as ⌥↵.
    if (key.return && escTimerRef.current) {
      clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
      logKey(input, key, 'newline (esc-then-return merge)');
      commit(value.slice(0, safeCursor) + '\n' + value.slice(safeCursor), safeCursor + 1);
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
      setCursorPos(prevWordBoundary(value, safeCursor));
      return;
    }
    if (key.rightArrow && (key.meta || key.ctrl)) {
      setCursorPos(nextWordBoundary(value, safeCursor));
      return;
    }
    if (key.meta && (input === 'b' || input === 'B')) {
      setCursorPos(prevWordBoundary(value, safeCursor));
      return;
    }
    if (key.meta && (input === 'f' || input === 'F')) {
      setCursorPos(nextWordBoundary(value, safeCursor));
      return;
    }
    if (key.leftArrow) {
      setCursorPos(Math.max(0, safeCursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos(Math.min(value.length, safeCursor + 1));
      return;
    }
    // Home → Ctrl+A (readline). The raw Home-key escape sequence
    // (\x1b[H / \x1b[1~ / \x1bOH) is NOT delivered to useInput by Ink
    // 5; it's filtered upstream. Document and rely on Ctrl+A.
    if (key.ctrl && input === 'a') {
      setCursorPos(moveHome(value, safeCursor));
      return;
    }
    // End → Ctrl+E (readline). Same note re: raw \x1b[F.
    if (key.ctrl && input === 'e') {
      setCursorPos(moveEnd(value, safeCursor));
      return;
    }

    // ── Newline inserts (at cursor) ──────────────────────────
    if (key.return && (key.meta || key.shift)) {
      logKey(input, key, 'newline (meta/shift+return)');
      commit(value.slice(0, safeCursor) + '\n' + value.slice(safeCursor), safeCursor + 1);
      return;
    }
    if (
      (key.ctrl && input === 'j') ||
      (input === '\n' && !key.meta && !key.shift)
    ) {
      logKey(input, key, 'newline (ctrl+j / raw LF)');
      commit(value.slice(0, safeCursor) + '\n' + value.slice(safeCursor), safeCursor + 1);
      return;
    }
    if (key.return) {
      logKey(input, key, 'submit (return)');
      onSubmit && onSubmit(value);
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
      if (safeCursor === 0) return;
      commit(value.slice(0, safeCursor - 1) + value.slice(safeCursor), safeCursor - 1);
      return;
    }

    // Other ctrl/meta combos: ignore (don't insert as text).
    if (key.ctrl || key.meta) return;
    // Up/Down: when the buffer has multiple lines AND the cursor isn't
    // at the relevant boundary, navigate within the field. At the
    // boundary, fall through (return without consuming) so the parent
    // (e.g. Zoom's composer history recall) handles the keystroke.
    if (key.upArrow) {
      const next = moveUp(value, safeCursor);
      if (next != null) { setCursorPos(next); return; }
      return; // at top of field — let parent see ↑ via its own useInput
    }
    if (key.downArrow) {
      const next = moveDown(value, safeCursor);
      if (next != null) { setCursorPos(next); return; }
      return; // at bottom of field — parent sees ↓
    }
    // Tab also delegated.
    if (key.tab) return;

    // Insert character(s) at cursor. `input` may be multi-byte for
    // pasted text — we treat it as opaque and insert atomically.
    if (input && input.length > 0) {
      commit(value.slice(0, safeCursor) + input + value.slice(safeCursor), safeCursor + input.length);
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
  const above = beforeLines.slice(0, -1);
  const beforeTail = beforeLines[beforeLines.length - 1] ?? '';
  const afterHead = afterLines[0] ?? '';
  const below = afterLines.slice(1);

  return (
    <Box width={width} flexGrow={width ? 0 : 1} flexDirection="column">
      {above.map((line, i) => (
        <Text key={`a${i}`} color={valueColor} wrap="wrap">{line || ' '}</Text>
      ))}
      <Text color={valueColor} wrap="truncate-start">
        {beforeTail}
        {focus && <Text color={caretColor || color}>{caret}</Text>}
        {afterHead}
      </Text>
      {below.map((line, i) => (
        <Text key={`b${i}`} color={valueColor} wrap="wrap">{line || ' '}</Text>
      ))}
    </Box>
  );
}
