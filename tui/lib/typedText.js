// tui/lib/typedText.js — normalize one burst of typed text before it enters
// an input surface.
//
// 0389: dictation (and paste) does not arrive one character at a time. macOS
// speech-to-text hands the terminal a whole phrase as a single write, and
// revises its guess by sending a run of DEL bytes followed by replacement
// words. Measured with Ink 5: a chunk is split into separate useInput events
// per control byte, but any text run arrives as ONE multi-character `input`,
// and an embedded CR or C0 control byte arrives INSIDE that string.
//
// Untreated, those bytes land in the value: a bare \r inside a broadcast
// message, or a stray control character in a session path. This is the one
// place that decides what counts as typed text.
//
//   allowNewlines: true  — multi-line surfaces (a broadcast message body).
//                          CRLF and CR normalize to LF; LF is kept.
//   allowNewlines: false — single-line surfaces (the command/filter bar, a
//                          path field). Every line break collapses to one
//                          space, so a dictated "new line" reads as a word
//                          gap instead of corrupting the field.
//
// Control bytes are dropped in both modes. TAB is dropped rather than kept:
// Ink already delivers a real Tab keypress as key.tab (surfaces use it for
// completion), so a tab inside a text run is always stray.
// Returns '' when nothing printable survives — callers must treat that as
// "no input", not as an empty edit.

// C0 controls including TAB (0x09) but NOT LF (0x0a), plus DEL (0x7f). CR
// (0x0d) never reaches this — it is rewritten to LF first.
const CONTROL_RX = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g;

export function normalizeTypedText(input, { allowNewlines = false } = {}) {
  if (typeof input !== 'string' || input.length === 0) return '';
  // CRLF and a lone CR both mean "line break" from a terminal's point of view.
  let out = input.replace(/\r\n?/g, '\n');
  if (!allowNewlines) out = out.replace(/\n+/g, ' ');
  out = out.replace(CONTROL_RX, '');
  return out;
}
