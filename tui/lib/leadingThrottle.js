// tui/lib/leadingThrottle.js — pure leading-edge + trailing-coalesce throttle
// decision, shared by the PTY render loops (PtyPane, ShellOverlay).
//
// A trailing-only scheduler (setTimeout on the first change) delays every paint
// by the full interval, so a single keystroke's echo lands up to `interval` ms
// late — the "typing feels a beat behind" symptom. Leading-edge paints the first
// change after an idle gap immediately, then coalesces the burst to <=1 frame per
// interval so streaming output never renders per-event (which would blow past the
// frame budget). Same shape as the App-level flush at tui/App.jsx.
//
// Pure so the timing logic is unit-testable without fake timers.
//
// @param {number} now           current timestamp (ms)
// @param {number} lastRenderTs  timestamp of the last committed paint (ms); 0 if none
// @param {number} interval      minimum ms between paints (e.g. RENDER_INTERVAL_MS)
// @returns {{ paintNow: boolean, scheduleIn: number|null }}
//   paintNow=true  → paint synchronously now (leading edge); scheduleIn=null.
//   paintNow=false → a paint happened <interval ago; schedule a trailing paint in
//                    `scheduleIn` ms (the remaining time) IF one isn't already pending.
export function throttleDecision(now, lastRenderTs, interval) {
  const elapsed = now - (lastRenderTs || 0);
  if (elapsed >= interval) return { paintNow: true, scheduleIn: null };
  return { paintNow: false, scheduleIn: interval - elapsed };
}
