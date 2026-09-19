# Feature register — what this app does, and whether it does it

Every feature in Mission Control, answered four ways: what it is, what it is
expected to do, whether it does that, and **how we know**. The fourth column is
the point of the exercise.

A passing test was not accepted as proof. Tests here pin current behaviour, and
several were found pinning the defect itself — including two written the same
week by the author of this register. Where nobody could verify a thing, the row
says "unverified" rather than guessing.

Six areas, roughly 400 features, 2,045 lines.

| Area | Features | Broken | File |
|---|---|---|---|
| Fleet view and cards | 135 | 5 | `01-fleet-view.md` |
| Status | 42 | 13 | `02-status.md` |
| Session lifecycle | 62 | 10 | `03-lifecycle.md` |
| Zoom and terminal | 64 | 12 | `04-zoom-terminal.md` |
| Commands, hotkeys, modals | 129 | 12 | `05-commands-modals.md` |
| Data, settings, persistence | 72 | 8 | `06-data-persistence.md` |

Most of the broken items were found by running the code against the user's real
data, not by reading it. The test suite was green the whole time.

## The single root cause

Most status defects are one line. The freshness stamp records **when we read a
file**, not **when the event happened**:

    agent.hookStatusTs = Date.now();        // server/statusHookTailer.mjs:114

Nothing anywhere reads the timestamp inside an event. Attaching to a
fourteen-hour-old feed stamps every historical event as "just now", and the last
one wins. That is why a card sits on WORKING for hours. The same mistake in the
sub-agent reader turned 137 old files into "67 agents, all one second old".

## The worst items, by what a user loses

1. **Pressing K can orphan a claude forever.** The slot is emptied before the
   force-kill can reach the process, so a claude that ignores the first signal
   survives the kill, the quit, and the shutdown — with no card left to show it.
2. **A dead session reports IDLE.** A signal death and a clean exit both arrive
   as exit code zero, which the restart logic does not treat as a failure.
3. **`:resume 12` silently resumes slot 1 and says it worked.** Out-of-range
   slots are dropped and the verb falls through to its bare form. `:kill` was
   fixed for exactly this in the past; `:resume`, `:cap` and `:forget` were not.
4. **Scroll does not hold its place.** The window is measured from claude's live
   cursor, so it drags forward as output arrives. The shell overlay cannot
   scroll at all.
5. **Opening the stats panel on an unknown model crashed the zoom view.**
6. **Six settings are shown and read by nothing.**
7. **A green "clean" git dot also means git failed, timed out, or the folder is
   not a repository.**
8. **A guessed price is shown without its "estimated" marker**, because the
   marker and the price use two different lookups.

## How to read a row

- **verified** — someone ran it or rendered it and quoted the output.
- **traced** — followed from the real source to the screen, with file and line.
- **test only** — a test covers it, which pins behaviour, not correctness.
- **unverified** — nobody checked. Not a judgement, just the truth.
