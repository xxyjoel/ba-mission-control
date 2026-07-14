// tui/zoom/zoomKeys.js — single source of truth for the zoom pane's CHROME
// keys (the few keystrokes Mission Control intercepts; everything else is
// forwarded to the embedded claude session).
//
// Each entry's `match(input, key)` is written against what Ink's REAL parser
// actually emits, and `bytes` is the exact byte sequence the terminal sends —
// so tests/zoom/zoomKeys.realparser.test.jsx can drive those bytes through
// ink-testing-library (the real parse path) and assert the binding fires.
// This is what makes it impossible to ship a binding that checks a shape Ink
// can never produce — the bug that left Ctrl+] / Ctrl+\ silently dead.
//
// WHY THESE KEYS (verified, not guessed):
//   • Ink sets {ctrl:true, input:<letter>} ONLY for bytes 0x01-0x1a (Ctrl+A..Z)
//     — parse-keypress.js. Ctrl+] (0x1d) / Ctrl+\ (0x1c) are ABOVE that range,
//     so Ink delivers them as raw bytes with ctrl:false → a `key.ctrl &&
//     input===']'` test is unreachable. We use only Ctrl+A..Z keys.
//   • claude-code's keymap binds Ctrl+T (todos), Ctrl+S (stash), Ctrl+L, Ctrl+O,
//     Ctrl+R, Ctrl+J (newline), Esc (cancel). It does NOT bind Ctrl+Q / Ctrl+Y /
//     Ctrl+K / Ctrl+U — so stealing those doesn't shadow a claude binding.
//   • Raw mode disables IXON/ISIG, so Ctrl+Q (0x11) arrives as a byte, not XON.

export const ZOOM_KEYS = {
  // Exit the zoom pane. Replaces the old Esc (which shadowed claude's cancel)
  // and the dead Ctrl+] . Mnemonic: Q = quit.
  EXIT:    { name: 'exit zoom',    bytes: '\x11', match: (i, k) => k.ctrl && i === 'q' }, // Ctrl+Q
  // Enter scroll mode (w/s/b/f/g/G drive the viewport). Replaces dead Ctrl+\ .
  SCROLL:  { name: 'scroll mode',  bytes: '\x19', match: (i, k) => k.ctrl && i === 'y' }, // Ctrl+Y
  // Toggle the tools panel. Moved off Ctrl+T (claude app:toggleTodos).
  TOOLS:   { name: 'toggle tools', bytes: '\x0b', match: (i, k) => k.ctrl && i === 'k' }, // Ctrl+K
  // Toggle the stats panel. Moved off Ctrl+S (claude chat:stash).
  STATS:   { name: 'toggle stats', bytes: '\x15', match: (i, k) => k.ctrl && i === 'u' }, // Ctrl+U
  // Insert a newline WITHOUT submitting. Ink delivers Ctrl+J as input='\n'
  // (raw LF, no ctrl flag); Shift+Enter as {return,shift} where supported.
  // Unchanged from the prior behavior — and matches claude's own chat:newline.
  NEWLINE: { name: 'newline',      bytes: '\n',   match: (i, k) => i === '\n' || (k.return && k.shift) }, // Ctrl+J / Shift+Enter
};

// classifyZoomKey — given Ink's (input, key), return the chrome action name
// (a ZOOM_KEYS key) or null when the keystroke should be forwarded to claude.
// PtyPane calls this; the real-parser test calls this. One code path, one
// source of truth.
export function classifyZoomKey(input, key) {
  for (const [action, def] of Object.entries(ZOOM_KEYS)) {
    if (def.match(input, key)) return action;
  }
  return null; // forward to the embedded claude session
}
