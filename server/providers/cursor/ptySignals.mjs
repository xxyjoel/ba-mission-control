// server/providers/cursor/ptySignals.mjs — pure detectors over Cursor TUI rows.
//
// Anchors measured from tests/fixtures/cursor/*.screen.txt (spike 2026-09-22).
// Same contract as PtyAgent's detectWorking / detectApprovalPrompt: row arrays
// in, bool out, never throws on bad input.

// Trust dialog on first run in a directory.
const TRUST_RX = /Workspace Trust Required/i;
const TRUST_ACTION_RX = /\[a\]\s*Trust this workspace/i;

// Fresh composer placeholder (and the post-turn follow-up composer).
const READY_FRESH_RX = /→\s*Plan,\s*search,\s*build anything/;
const READY_FOLLOW_RX = /→\s*Add a follow-up/;

// Active turn: stop hint is the stable signal (mirrors Claude's "esc to interrupt").
const WORKING_STOP_RX = /ctrl\+c to stop/i;
// Spinner + verb as a secondary cue when the stop hint is off-screen.
const WORKING_SPIN_RX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▖▘▝▗⠄⠆⠇⠋⠙⠸⠴⠦⠧⠇⠏⠀⠁⠂⠄⡀⢀⠠⠐⠈⠘⠨⠨⠰⠰⠳]\s*(Composing|Editing)\b/i;

// Shell / subagent approval surfaces.
const APPROVAL_WAIT_RX = /Waiting for approval/i;
const APPROVAL_RUN_RX = /Run this command\?/;

function any(rows, ...rxs) {
  if (!Array.isArray(rows)) return false;
  for (const r of rows) {
    if (!r) continue;
    for (const rx of rxs) if (rx.test(r)) return true;
  }
  return false;
}

export function detectTrustPrompt(rows) {
  return any(rows, TRUST_RX) || any(rows, TRUST_ACTION_RX);
}

export function detectReady(rows) {
  if (detectTrustPrompt(rows)) return false;
  return any(rows, READY_FRESH_RX, READY_FOLLOW_RX);
}

export function detectWorking(rows) {
  return any(rows, WORKING_STOP_RX) || any(rows, WORKING_SPIN_RX);
}

export function detectApproval(rows) {
  return any(rows, APPROVAL_WAIT_RX) || any(rows, APPROVAL_RUN_RX);
}
