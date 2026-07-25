// tui/shell/shellKeys.js — chrome key classifier for the shell overlay.
//
// CRITICAL DESIGN CONSTRAINT: This module defines ONLY the close chord.
// It does NOT match Ctrl+K, Ctrl+U, Ctrl+J, or any other readline keys —
// those must fall through to the PTY unmodified. Reusing ZOOM_KEYS here is
// the exact bug this module exists to prevent (zoom binds Ctrl+K/U/J for
// chrome actions; a shell user needs those for kill-line/newline).
//
// The single chrome key (Ctrl+Q, 0x11):
//   • Raw mode disables IXON/ISIG, so Ctrl+Q arrives as a byte, not XON.
//   • Ink delivers it as {ctrl:true, input:'q'} (verified in zoomKeys.js
//     comments — Ink sets ctrl:true only for bytes 0x01-0x1a, Ctrl+A..Z).

export const SHELL_KEYS = {
  // Close the shell overlay. Ctrl+Q chosen deliberately over Esc because
  // shells and vi use Esc — it cannot be the close chord.
  EXIT: { name: 'close shell', bytes: '\x11', match: (i, k) => k.ctrl && i === 'q' }, // Ctrl+Q
};

// classifyShellKey — given Ink's (input, key), return the chrome action name
// ('EXIT') or null when the keystroke must be forwarded to the PTY.
// ShellOverlay calls this; the paired test (0313) calls this.
export function classifyShellKey(input, key) {
  for (const [action, def] of Object.entries(SHELL_KEYS)) {
    if (def.match(input, key)) return action;
  }
  return null; // forward verbatim to the PTY — including Ctrl+K, Ctrl+U, Ctrl+J
}
