// tui/zoom/ptyKeys.js — translate Ink useInput events into the raw byte
// sequences a real terminal would deliver over stdin to the child.
//
// Ink hands us a parsed key event (input + key flags). The child claude
// expects raw ANSI/CSI byte sequences exactly as a vt220 / xterm would
// emit. This file is the bridge.
//
// Mapping is conservative — only translate the keys claude actually
// listens for. Anything else passes through as `input` verbatim, which
// covers normal printable characters, multibyte unicode, AND paste
// payloads (Ink delivers a paste as a single multi-character `input`).

const CSI = '\x1b[';
const ESC = '\x1b';

// Build the modifier code per the xterm/vt220 convention:
//   1 + (Shift=1, Alt=2, Ctrl=4)
// Used in CSI sequences like CSI 1;<mod>X for modified arrows.
function modCode(key) {
  let mod = 0;
  if (key.shift) mod |= 1;
  if (key.meta)  mod |= 2;   // Option / Alt
  if (key.ctrl)  mod |= 4;
  return mod === 0 ? 0 : 1 + mod;
}

function arrow(letter, key) {
  const m = modCode(key);
  return m === 0 ? `${CSI}${letter}` : `${CSI}1;${m}${letter}`;
}

// Translate Ink (input, key) into the byte sequence to write to the PTY.
// Returns null if the key should be silently dropped (handled upstream).
export function keyToBytes(input, key) {
  // Arrows — including modified variants (shift/alt/ctrl).
  if (key.upArrow)    return arrow('A', key);
  if (key.downArrow)  return arrow('B', key);
  if (key.rightArrow) return arrow('C', key);
  if (key.leftArrow)  return arrow('D', key);

  // Page nav + Home/End — claude uses pageUp/pageDown for scrollback.
  if (key.pageUp)   return `${CSI}5~`;
  if (key.pageDown) return `${CSI}6~`;
  if (key.home)     return `${CSI}H`;
  if (key.end)      return `${CSI}F`;

  // Forward-delete (\x1b[3~). Ink collapses both Backspace and Delete
  // into key.delete/key.backspace with empty input, so this branch
  // only triggers when key.delete is set (we route backspace below).
  // TODO(forward-delete): Ink 5 can't distinguish forward Delete from
  // Backspace on macOS; we treat key.delete as backspace too for now.

  // Backspace — terminals send DEL (0x7f), not BS (0x08).
  if (key.backspace || key.delete) return '\x7f';

  // Tab and Shift+Tab.
  if (key.tab) return key.shift ? `${CSI}Z` : '\t';

  // Return — terminals send CR for the Return key.
  if (key.return) return '\r';

  // Escape standalone — claude uses Esc to interrupt the streaming
  // assistant response. Zoom intercepts a dedicated zoom-exit key
  // (Ctrl+]) BEFORE this function is called, so plain Esc reaches
  // claude as a single 0x1b byte.
  if (key.escape) return ESC;

  // Ctrl+letter — encode as control byte (a=0x01 .. z=0x1a).
  if (key.ctrl && input && input.length === 1) {
    const c = input.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) {
      return String.fromCharCode(c - 0x60);
    }
    // Ctrl+space (NUL), Ctrl+[ (ESC), Ctrl+\ (FS), Ctrl+] (GS),
    // Ctrl+^ (RS), Ctrl+_ (US) — pass through whatever Ink decoded.
    return input;
  }

  // Meta/Alt+character — vt220 convention is ESC-prefix.
  if (key.meta && input && input.length >= 1) {
    return ESC + input;
  }

  // Default: pass `input` verbatim. Covers printable characters and
  // paste payloads (Ink delivers paste as one multi-character chunk).
  if (input && input.length > 0) return input;

  return null;
}
