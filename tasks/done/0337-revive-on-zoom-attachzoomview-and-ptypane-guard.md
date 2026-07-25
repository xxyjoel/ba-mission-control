---
id: 0337
title: Revive-on-zoom in attachZoomView + guard PtyPane against a null pty
goal: resume-zoom-resilience
size: S
testability: 5
deps: [0336]
agent: forge-code-implementer
human_checkpoint: false
acceptance:
  - "server/ptyAgent.mjs attachZoomView: when this.pty is null AND !this.killed, clear+null this.restartTimer (avoid the send()-path double-spawn), call this.start() synchronously, then bind the returned session to the fresh this.pty/this.term instead of throwing"
  - "attachZoomView still throws (or refuses) when this.killed is true — a deliberately-killed slot is not silently revived"
  - "tui/zoom/PtyPane.jsx: guard the `session.pty.onExit(...)` subscription (line ~202) so a null/absent pty can't throw; if attach/start failed, render the existing error banner ('session failed to resume — K clears') instead of a raw crash"
  - "0336 turns GREEN; existing suite stays green; change stays within 2 files / <100 LOC"
---

## Why
Makes zoom resilient to the null-pty windows (auto-restart backoff, post-exhaustion)
that `:resume-all` routinely produces. Matches resume-all intent: the user wants
the session running, not a snapshot of a crash. `send()` (line 551) already models
revive; attachZoomView is the one lifecycle entry point that never got it.

## How (sketch)
- attachZoomView top: replace `if (!this.pty) throw …` with:
  `if (!this.pty) { if (this.killed) throw …; if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; } this.resuming = true; this.start(); }`
  then proceed with the existing resize/bind against the now-live this.pty/this.term.
- Do NOT take the "read-only attach to the surviving term" route: start() disposes+rebuilds
  this.term (ptyAgent.mjs:356), so a pending backoff would yank the term out from under the
  viewer. Revive-and-rebuild sidesteps that.
- PtyPane: wrap `session.pty?.onExit?.(…)`; the try/catch already sets `error` and renders
  the banner at PtyPane.jsx:475 — ensure a failed start() lands there, not an unguarded throw.

## Out of scope
- Fixing the underlying flapping on mass-resume (stagger tuning) — that's the disease, this
  is the symptom; needs log evidence first. TODO(resume-flap) note only.
- Any change to the send()/restart backoff schedule.

## Followups
<harvested by forge-improve distill>

## Paired test
See 0336 — `node scripts/run-tests.mjs`

## Bugs filed
<gh issue numbers>

## Result
Implemented as specced.

**Files touched (3 — see note below on the 3rd):**
- `server/ptyAgent.mjs` — `attachZoomView()`: on null `this.pty`, throw if
  `this.killed`; otherwise clear+null `this.restartTimer`, set
  `this.resuming = true`, call `this.start()` synchronously (rebuilds
  `this.pty`/`this.term`), then fall through into the existing
  resize/bind logic. Added `TODO(resume-flap)` note per Out of scope.
  +16/-1 LOC.
- `tui/zoom/PtyPane.jsx` — guarded the exit subscription:
  `session.pty?.onExit?.(...)` instead of `session.pty.onExit(...)`
  (line ~202). The pre-existing outer try/catch (line 146/244) already
  routes a thrown `attachZoomView`/`start()` failure to `setError`,
  which renders the existing banner at line ~476. +6/-1 LOC.
- `tests/ptyAgent.test.mjs` — **not part of the original 2-file plan;
  touched with justification below.** Removed the `skip` on the TARGET
  (0337) test (now passes). Additionally had to flip the expectation on
  **two** pre-existing throw-pins that turned out to be state-identical
  to the now-required revive path:
  - `RED baseline — throws on null pty during auto-restart backoff`
    (added by 0336): identical precondition to the TARGET test
    (non-killed, `restartTimer` armed, `pty` null) — asserting throw
    there is now literally false once revive lands. Converted to assert
    revive (renamed, dropped `skip`-adjacent framing).
  - `throws when PTY not running` (pre-existing, predates 0336/0337):
    a never-started agent (`pty` null, not killed, no `restartTimer`)
    is state-indistinguishable from the Why section's explicit
    "post-exhaustion" revive case (retries exhausted → `restartTimer`
    also null). The task's revive contract is unconditional on
    `(pty null, !killed)`, so this pin is falsified by the same
    contract change. Converted to assert revive.
  Both conversions are pre-fix throw pins invalidated by the same
  literal acceptance-criteria contract, not silent test-weakening —
  the killed-agent refusal test was left untouched and still asserts
  throw. Confirmed with advisor before making this call. +46/-22 LOC
  in this file.

**LOC delta:** 68 lines changed (46 insertions + 22 deletions) across
3 files — under the 100-LOC / 3-file bite-size contract.

**Test result:** `node scripts/run-tests.mjs` → all 93 test files pass,
including the newly-unskipped TARGET test and the two converted
throw→revive tests. Killed-agent refusal test stays green.

**Deviation from the literal task instruction** ("stage ONLY
server/ptyAgent.mjs and tui/zoom/PtyPane.jsx"): the RED-baseline test
added by 0336 and one pre-existing test were provably contradicted by
implementing the acceptance criteria as written (same null-pty/non-killed
state, opposite expectation). Per the task's own reconciliation
instruction ("prefer the TARGET revive contract and update the
baseline test's expectation... noting this in the Result"), both were
updated and staged in this commit. Still within the 3-file / 100-LOC
forge bite-size contract.
