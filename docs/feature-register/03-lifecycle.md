# Feature register 03 — session lifecycle and process supervision

Area: `server/fleet.mjs`, `server/ptyAgent.mjs`, `server/agent.mjs`,
`server/zoomSession.mjs`, `server/shellSession.mjs`, `server/procStats.mjs`,
`server/hookSettings.mjs`, `tui/main.jsx`.

Written 2026-09-19. Read-only audit — no product code was changed. Line numbers
are against the working tree as of that afternoon (`main` at `f2fda14`, plus the
uncommitted changes to `ledgerOwner.mjs`, `ptyAgent.mjs` and
`subagentUsageTailer.mjs` that were already in the tree). Every citation in the
BROKEN section was re-checked against the file on disk at the end of the audit.

## How to read the evidence column

- **exercised** — I ran the code and watched what happened. The observed output
  is quoted.
- **traced** — I followed the code by hand, every hop named with `file:line`.
  Nobody ran it.
- **test only** — a unit test is the only evidence. Per the rules of this
  register that pins *current behaviour*, not correctness. Several tests in this
  repo pin the defect (one is named below).
- **unverified** — I did not check. Not a guess either way.

Nothing was tested against a real `claude`. Every run used a stand-in binary in
a scratch `HOME`. Where the answer depends on what the real `claude` does, the
row says so instead of guessing.

## Terms used below

- **PTY** — a pseudo-terminal. Mission Control gives each session a fake
  terminal so `claude` renders exactly as it would in a real window.
- **SIGTERM / SIGKILL / SIGSTOP / SIGCONT** — Unix signals. SIGTERM asks a
  program to stop and can be ignored; SIGKILL cannot be ignored or caught;
  SIGSTOP freezes a program; SIGCONT wakes it up again.
- **orphan** — a `claude` that outlives Mission Control. It keeps running,
  keeps costing money, and holds the session lock so that session cannot be
  reopened.
- **slot** — one of the numbered cards on screen. A slot is empty, or it owns
  exactly one `claude`.

---

## The register

| Feature | Expected to do | Does it? | How I know |
|---|---|---|---|
| **Fleet slot table** (`fleet.mjs:58-80`, `130-137`) | Hold N slots, each empty or one agent; `snapshot()` returns one plain record per slot | Yes | **exercised** — `new Fleet({slots:3})`, launched into slot 2: `slots= 3 agents= 1:empty 2:idle 3:empty` |
| **Launch guards** (`fleet.mjs:173-174`) | Refuse a slot number out of range, refuse a slot already occupied | Yes | **exercised** — `launch({slot:2})` twice → `slot 2 already occupied`; `launch({slot:9})` on a 3-slot fleet → `bad slot 9` |
| **Spawn flags** (`ptyAgent.mjs:414-435`) | Pass only the flags Mission Control means to pass; never ask for a background session | Yes | **exercised** — captured the real argv through the spawn seam: `claude ["--session-id","aaaa…","--model","claude-opus-4-8","--permission-mode","acceptEdits","--add-dir","/tmp/proj","--settings","{…}"]`. Five flags, no background or daemon flag. A grep for `--background` / `--daemon` across `server/` and `tui/` returns nothing |
| **Resume vs. fresh session id** (`ptyAgent.mjs:419-424`) | Use `--resume <id>` when the transcript file exists, else `--session-id <id>` so `claude` creates it | Mechanically yes — **but it lies to the user when it falls back** | **exercised** — with `resume:true` and no transcript on disk, the captured argv was `--session-id`, and `this.resuming` was silently set back to `false` (`ptyAgent.mjs:422`). See BROKEN #5 |
| **Hook block injection** (`ptyAgent.mjs:429-435`, `hookSettings.mjs:16-53`) | Give every spawned session a `--settings` block wiring five lifecycle events to Mission Control's emitter | Yes | **exercised** — `buildHookSettings` returned `Notification, UserPromptSubmit, PreToolUse, PostToolUse, Stop` |
| **Hook command quoting** (`hookSettings.mjs:24-25`) | Survive an install path containing spaces or quotes without letting it become shell code | Yes | **exercised** — with `emitterPath = "/a b/emit'x.mjs"` the command came out `'/opt/homebrew/…/node' '/a b/emit'\''x.mjs'`. Correct POSIX single-quote escaping |
| **Hook timeout** (`hookSettings.mjs:29`) | Cap how long a hook may block `claude` | Value present, source doubtful | **exercised** (`timeout: 5`) + **flagged** — the comment says *"5 is the max allowed by the test"*. That is a constant justified by a test, not by anything `claude` publishes |
| **Model carry-over on relaunch** (`ptyAgent.mjs:411-413`) | If the user typed `/model` inside the session, relaunch on that model, not the launch model | **unverified** | Traced only. Depends on `resolvedModel` being filled by the transcript reader, which is outside this area |
| **Banner-draw delay before first write** (`ptyAgent.mjs:226`, `568-575`) | Hold sends for 3 s after spawn so `claude` finishes drawing, then flush the queue | **unverified** as to whether 3 s is right | Traced. `READY_MS = 3000` is **hardcoded**; the comment records a measurement of ~500 ms and then picks 3000 as "comfortable margin" |
| **Queue-and-respawn on send** (`ptyAgent.mjs:729-770`) | Typing to a slot whose process died should revive it and deliver the message | Yes | **exercised** — after a crash left the slot in backoff: `backoff armed=true pty=GONE` → `send()` → `backoffTimer=false pty=live (respawned) pending=1` |
| **Backoff timer cancelled on revive** (`ptyAgent.mjs:755-759`) | A manual revive must cancel the pending auto-restart, or two `claude`s spawn | Yes | **exercised** — same run; the armed timer was cleared before `start()` |
| **Paste sanitising before the PTY** (`ptyAgent.mjs:89-95`) | Strip control bytes so text cannot end the paste early and run as keystrokes | **test only — pins behaviour, not correctness** | `tests/ptyAgent.pasteSanitize.test.mjs` exists. I did not exercise it; it is a security control and belongs in the security register |
| **`approve()`** (`ptyAgent.mjs:718-720`, call site `App.jsx:996-1010`) | Answer whatever `claude` is blocked on | **Doubtful — traced, not confirmed** | It types the fixed English sentence `'yes, please continue with the proposed action'`. `claude`'s permission box and its AskUserQuestion / ExitPlanMode boxes are numbered menus that read keystrokes (`1`, `2`, arrows). Prose is the right answer for only one of the three states that show as `waiting`. **Hardcoded prose standing in for a menu selection.** Verifying needs a real `claude`, which this audit may not spawn |
| **`pause()` — freeze by signal** (`ptyAgent.mjs:824-837`) | SIGSTOP the process and show the card as paused | Yes | **exercised** — `after pause : status=paused signals=["SIGSTOP"] paused=true` |
| **`resume()` — wake by signal** (`ptyAgent.mjs:839-852`) | SIGCONT the process and restore the card to what it was doing | Signal yes, **status is a lie** | **exercised** — agent was `idle` before the pause; after `resume()`: `status=working`. `ptyAgent.mjs:844` assigns `'working'` unconditionally. See BROKEN #4 |
| **`kill()` wakes a frozen process first** (`ptyAgent.mjs:885-894`) | SIGCONT before SIGTERM, or a frozen process never handles the request and is stranded | Yes (new path) | **exercised** — killing a paused agent emitted `["SIGCONT","SIGTERM"]` in that order |
| **`kill()` tears down watchers and timers** (`ptyAgent.mjs:854-884`) | Stop all three file watchers, clear both timers, drop both PTY subscriptions, dispose the terminal buffer | Yes | **traced**, every hop: tailer `:864-867`, status tailer `:868-869`, usage tailer `:870-871`, data sub `:872-875`, exit sub `:876-879`, terminal `:880-884` |
| **`hardKill()`** (`ptyAgent.mjs:902-906`) | SIGKILL a process that ignored SIGTERM | Yes | **exercised** — see the exit-route table below; a `claude` stand-in with `trap '' TERM HUP` survived `killAll()` and died on `hardKillAll()` |
| **Double-start guard** (`ptyAgent.mjs:400-404`) | Never spawn a second `claude` beside a live one | Yes | **traced** — `if (this.pty) { … return; }` before any spawn |
| **Late-exit identity guard** (`ptyAgent.mjs:601-606`) | An exit arriving from a PTY the agent no longer owns must not tear down the current one | Yes | **traced** — the callback is stamped with the PTY it belongs to at `:534-535` and compared at `:606` |
| **Auto-restart on a crash** (`ptyAgent.mjs:672-699`) | Retry up to three times at 2 s, 5 s, 15 s, then stop | Yes | **exercised** — `crash 1: restartCount=1 … "auto-restart 1/3 in 2s"`, `crash 2: … 2/3 in 5s`, `crash 3: … 3/3 in 15s`, `crash 4: status=error … "auto-restart exhausted (3 attempts) — leaving slot errored · K clears"` |
| **Restart budget resets after a stable run** (`ptyAgent.mjs:679-682`) | Three crashes days apart must not permanently error a slot | Yes | **exercised** — with 61 s of uptime and `restartCount=2`, the next crash reset it to 1 and re-armed the timer |
| **Restart budget vs. a live conversation** (`ptyAgent.mjs:683-706`) | Give up without destroying anything | Yes, with a real cost | **exercised** — after exhaustion: `toJSON.status=error pty=GONE sessionId=1b8227e1 killed=false`. The transcript on disk is untouched and `K` then `:resume` recovers it. But the whole budget is spent in about 22 s, so any outage longer than that leaves the slot dead until a human presses a key. Nothing retries later |
| **Early-exit classifier — session held elsewhere** (`ledgerOwner.mjs:26-49`, used `ptyAgent.mjs:651-664`) | Recognise `claude` refusing to resume a session something else owns, and not waste the restart budget on it | Yes, for the wordings it knows | **exercised** — `held-by-agent` for claude 2.1.267's live wording *"belongs to another running Claude Code session (locked: …)"*, and for the four older phrasings; `null` for an unrelated crash and for prose that merely mentions a background agent. This is the fix for the crm-helper incident and it now matches |
| **Classifier time window** (`ledgerOwner.mjs:45-48`) | Only treat an exit as a refusal if it happened soon after spawn | Yes, **but the window is a hardcoded guess** | **exercised** — the same live wording at 25 s returns `null`. `windowMs = 20_000` is **hardcoded** with no measurement behind it |
| **Ledger owner lookup** (`ledgerOwner.mjs:55-69`) | Turn a refusal into "who holds it and what is it doing" by reading `~/.claude/jobs/<id8>/state.json` | **unverified** | Traced only. It depends on a directory layout owned by `claude`, with no contract check anywhere |
| **`changeModel()` / `changePermissionMode()`** (`ptyAgent.mjs:923-945`) | Switch the setting by relaunching the same session | Works, **but overlaps two processes on one session** | **exercised** — immediately after `changeModel()`: `old pid=27237 alive=true  new pid=27273 alive=true`, i.e. `two claude processes on one sessionId at the same instant: true`. Teardown sends SIGTERM (`:991`) and `start()` runs in the same tick (`:943`). See BROKEN #6 |
| **Teardown suppresses auto-restart** (`ptyAgent.mjs:983-992`) | A deliberate relaunch must not look like a crash | Yes | **traced** — `killed` is flipped true across the kill and restored after |
| **`resize()`** (`ptyAgent.mjs:1003-1015`) | Change PTY and buffer geometry together, no-op when unchanged | Yes | **exercised** via `setViewport` below |
| **`attachZoomView()`** (`ptyAgent.mjs:1028-1079`) | Show the running session without spawning anything, and revive it if the process is in a restart gap | **unverified** for the happy path | Traced. The revive branch (`:1029-1043`) mirrors the `send()` revive, which I did exercise. Carries its own open `TODO(resume-flap)` at `:1037` |
| **Dead-process error guard** (`ptyAgent.mjs:1274`) | A slot whose `claude` is gone must never report idle | **Only for one of three ways a process can die** | **exercised** — see BROKEN #1. Covers the "restarts exhausted" case only |
| **`Fleet.kill(id)` — the `K` hotkey** (`fleet.mjs:229-237`) | End that session's process and free the slot | **No — it can orphan the process** | **exercised** — see BROKEN #2 |
| **`Fleet.killAll()`** (`fleet.mjs:269-271`) | SIGTERM every live agent | Yes | **exercised** — reaped a cooperative stand-in; left the SIGTERM-ignoring one alive, which is the documented split |
| **`Fleet.hardKillAll()`** (`fleet.mjs:278-280`) | SIGKILL anything that survived | Yes, for agents still in the slot table | **exercised** — the wedged stand-in died only at this step |
| **Reach of the kill escalation** (`node_modules/node-pty/lib/unixTerminal.js:226-230`) | — | Signals **one process**, not the group | **exercised + traced** — node-pty's `kill()` is `process.kill(this.pid, signal)`. In practice `claude`'s own children still died in my runs, because closing the terminal hangs up the whole terminal session. A child that detaches itself (which is what `claude`'s daemon does — 13 such processes on this machine right now, none created by Mission Control) is out of reach by construction |
| **`Fleet.broadcast()`** (`fleet.mjs:250-267`) | Send to every live target, skip frozen ones, report the split | Yes | **exercised** — with one live and one paused slot plus one unknown id: `result={"sent":1,"skipped":2} delivered=[["s1","hello"]]` |
| **`Fleet.setViewport()`** (`fleet.mjs:149-162`) | Set one terminal size for the whole fleet; ignore garbage; resize live agents; do nothing when unchanged | Yes | **exercised** — `0x0 → 0 resized, viewport=null`; `{} → 0 resized`; `180x50 → viewport set`, agent then spawned at `180x50`; same value again → `0 resized`; `120x40 → 1 resized; agent now 120x40` |
| **`Fleet.setSlots()`** (`fleet.mjs:310-327`) | Grow freely; when shrinking never drop a live agent; clamp to 1..64 | Mostly — one odd edge | **exercised** — shrink 6→2 with slot 4 live returned `4`; grow → `9`; `999` → `64`. But `setSlots(0)` returned **10**, not 1, because `n \| 0 \|\| DEFAULT_SLOTS` turns zero into the default (`fleet.mjs:311`) |
| **`Fleet.resume()`** (`fleet.mjs:218-227`) | Put a saved session back in a slot | Works, **and will happily run one session twice** | **exercised** — see BROKEN #3 |
| **Shared watcher tick** (`fleet.mjs:84-98`) | One wake-up drives every agent's file watchers; stretch to 3 s when the fleet is idle; never hold the process open | Yes for the "never hold open" part | **exercised** — a script that created a Fleet and never killed it still exited by itself, so the timer is unreferenced as documented. The 1500 ms / 3000 ms cadence is **hardcoded**; **unverified** whether it is the right cadence |
| **CPU and memory sampling** (`fleet.mjs:107-128`, `procStats.mjs:17-43`) | One `ps` call covers every live agent; a pid that vanished mid-sample keeps its last values | Yes, within a narrow scope | **exercised** — `samplePids([self]) -> [[23913,{"cpu":3.7,"rssKb":80304}]]`; a dead pid returned an empty map; ragged `ps` rows parsed correctly. **Scope flag:** it samples only the `claude` process itself, never the tools and servers `claude` starts, so a card's CPU and memory understate the real cost. `pcpu` is `ps`'s decaying average, not an instant reading |
| **`costWeek` on every card** (`ptyAgent.mjs:1326`) | Report the week's spend | **No** | **traced** — the field ships the literal `0`. A **hardcoded value standing in for a measurement**, going straight into the UI as data. See BROKEN #9 |
| **Background-agent count** (`ptyAgent.mjs:158`, `1234-1260`) | Count background work honestly, or say it cannot | Partly | **traced.** `SUB_ACTIVE_MS = 15_000` sits next to a comment recording a *measured* 166 s gap between background events. The code documents its own wrongness. The newer path counts real files and reports `null` (shown as `?bg`) when work is live but uncountable, which is the honest shape |
| **`STUCK` threshold** (`ptyAgent.mjs:1121`) | Flag a session that has gone silent while a tool is outstanding | **unverified** | `STUCK_MIN_THRESHOLD = 5` minutes is **hardcoded** with no measurement cited |
| **Overlay shell — lazy spawn** (`shellSession.mjs:49-164`) | Start the user's shell once and keep it warm across open/close | Yes | **exercised** — spawned, wrote a command into it, read the output back out of the buffer |
| **`killShellSession()`** (`shellSession.mjs:228-253`) | End the overlay shell on shutdown | **No — SIGTERM alone does not end an interactive shell** | **exercised** — `after killShellSession -> shell=true inner=true`. See BROKEN #7 |
| **Overlay shell at real shutdown** | The shell and anything inside it must not outlive Mission Control | Yes, by luck of the terminal, not by the kill | **exercised** — on SIGTERM, SIGINT, SIGHUP *and* SIGKILL of Mission Control, the shell and the process inside it were both gone. They die from the terminal hang-up when the process exits, not from `killShellSession()` |
| **Overlay shell drops itself when it exits** (`shellSession.mjs:146-156`) | If the user types `exit`, forget the handle so a later kill cannot signal a recycled pid | **test only — pins behaviour, not correctness** | Traced; `tests/shell/` covers it. I did not exercise it |
| **`cd` into the focused repo** (`shellSession.mjs:202-218`) | Only inject `cd` when the shell is at a fresh prompt, and quote the path safely | **unverified** | Traced. Carries its own open `TODO(fresh-prompt)` at `:24-26` saying the prompt detection is a heuristic |
| **Instance lock** (`main.jsx:137-146`, `instanceLock.js:83-97`) | One Mission Control per config folder; a second one boots read-only instead of corrupting shared files | **test only — pins behaviour, not correctness** | Traced end to end. `tests/` covers the stale-lock and recycled-pid cases. I did not exercise it |
| **Boot order** (`main.jsx:72-165`) | Preflight → settings → model cache → PTY helper repair → tighten file permissions → **lock** → prune → Fleet → screen | Yes | **traced** — preflight `:72`, settings `:78`, cache `:85-88`, helper `:121`, permissions `:127`, lock `:137`, prune `:148`, Fleet `:156`, alt-screen `:176`. The lock is taken before prune writes anything, which is the point |
| **Preflight never blocks boot** (`main.jsx:31-70`) | Warn about a missing `claude` or a logged-out account, then continue | Yes | **traced**. Uses `execFileSync` with an argument array, so a hostile `CLAUDE_BIN` cannot inject shell |
| **Shutdown on Ctrl+C / terminal close / SIGTERM** (`main.jsx:199-238`) | Save the open set, release the lock, kill the shell, SIGTERM the fleet, then SIGKILL stragglers after 1.5 s | Yes | **exercised at component level** — see the exit-route table. The 1.5 s grace is **hardcoded** |
| **Clean quit (`q` → save)** (`main.jsx:308-326`) | Same escalation as a signal exit, with an explicit process exit so a wedged child cannot stall the quit | **traced** | `App.jsx:1502` opens the confirm modal; `QuitConfirm.jsx:22-23` sets the save mode then calls Ink's `exit()`; `main.jsx:308` resumes after `waitUntilExit()` and runs the same save → kill → 1.5 s → hard-kill → `process.exit(0)` sequence |
| **Crash net** (`main.jsx:268-283`) | Restore the terminal, print one line, exit — never dump a stack over the screen | **traced** | Registers `uncaughtException` and `unhandledRejection`; both end in `process.exit(1)`, which fires the exit net below |
| **Synchronous exit net** (`main.jsx:292-305`) | Last chance on any path: save, kill shell, SIGTERM, SIGKILL, restore the screen | **traced** — and **exercised at component level** | The escalation it calls is the one proven in the exit-route table |
| **Ctrl+Z is swallowed** (`main.jsx:251`) | Never let the fleet controller be suspended | **unverified** | Traced. Registering any SIGTSTP handler does override Node's default; the comment says this was verified, I did not re-verify |
| **Legacy stream-json agent** (`agent.mjs`) | Emergency fallback behind `FLEET_USE_PTY=0` | Present, and **behind on three fixes** | **traced** — see BROKEN #10. (a) no early-exit classifier, so it burns its whole restart budget against a session `claude` already holds (`agent.mjs:573-615`); (b) `kill()` does not SIGCONT a frozen process before SIGTERM (`agent.mjs:763-779`), the exact stranding `ptyAgent.mjs:885-894` was fixed for; (c) same clean-exit hole as BROKEN #1 (`agent.mjs:585`) |
| **Legacy zoom session** (`zoomSession.mjs:78-318`) | Spawn a second `claude` for the zoom view on the legacy path | Present, and **reachable from mock mode** | **traced**, on an exercised precondition — `MockAgent.attachZoomView is undefined` (exercised), and it has a session id. The ternary at `PtyPane.jsx:172-174` therefore falls through to `startZoomSession()`, which spawns `CLAUDE_BIN` (`zoomSession.mjs:136`). I did not let it spawn. The boot banner for mock mode says *"no real claude subprocess will spawn"* (`main.jsx:44`). See BROKEN #8 |
| **Zoom session id detection** (`zoomSession.mjs:177-202`) | Notice when `claude` minted its own session id, by diffing file timestamps | Works as written, **wrong by design** | **traced.** Picking the newest-changed transcript file is precisely the timestamp-guessing that the stabilisation task identifies as the root cause of cards following the wrong conversation |
| **Zoom teardown hold** (`zoomSession.mjs:302-316`) | Wait for the session to go quiet before killing, so an in-flight reply is not lost | **unverified** | Traced. `QUIET_HOLD_MS = 1500`, `MAX_HOLD_MS = 30000`, `SESSION_DETECT_MS = 1200`, `KILL_GRACE_MS = 250` are all **hardcoded** and justified in prose ("comfortable margin"), not by measurement |
| **`MockAgent` has no `hardKill`** (`mockAgent.mjs`) | — | Silently skipped | **exercised** — `MockAgent.hardKill is undefined`; `fleet.hardKillAll()` calls `a.hardKill?.()` (`fleet.mjs:279`) so it no-ops. Harmless today because mock mode owns no real process, except via the zoom hole above |

---

## What happens to a `claude` when Mission Control exits

Measured, not argued. Each route booted a real `Fleet` with a `claude`
stand-in that **ignores SIGTERM and SIGHUP** (the wedged case the code comments
describe), plus a real overlay shell holding a long-running process. Then the
Mission Control process was signalled and every pid checked with `ps` four
seconds later.

| Exit route | Signal sent | Wedged `claude` | Overlay shell | Process inside the shell |
|---|---|---|---|---|
| `q` → save, and `:q` | — (Ink exit → `main.jsx:308-326`) | **not exercised** — traced only; same escalation as SIGTERM | traced | traced |
| Ctrl+C | SIGINT | reaped | reaped | reaped |
| Terminal / window close | SIGHUP | reaped | reaped | reaped |
| `kill <pid>` | SIGTERM | reaped | reaped | reaped |
| Force-close, `kill -9`, power loss | SIGKILL | **ORPHAN — still alive** | reaped | reaped |

Reading: the three signal routes all work, **including against a `claude` that
ignores every polite request.** The escalation earns its keep — SIGTERM alone
left the wedged stand-in running; the 1.5-second SIGKILL follow-up ended it.

The SIGKILL row is not a defect. No program can clean up after SIGKILL. It is
worth stating plainly because it is the exact chain the code comments describe:
force-close leaves a `claude` behind, `claude`'s daemon adopts it, and that
session can no longer be reopened. The shell and its child still die, because
they honour the terminal hang-up; the wedged `claude` ignores it.

**There is a fourth orphan route that has nothing to do with quitting** — see
BROKEN #2. It fires on a single keystroke during normal use.

---

## Can a resumed session be resumed twice?

**Yes. Nothing anywhere checks.**

Exercised: `fleet.resume()` called twice with the same session id into slots 1
and 2 returned two live agents, both carrying
`11111111-2222-3333-4444-555555555555`. No error, no warning.

The guards that do exist check something else:

- `fleet.launch` (`fleet.mjs:174`) refuses an **occupied slot**, not a duplicate
  session.
- `:resume <slot>` (`App.jsx:1047`) refuses a **slot in use**, not a session
  already live.
- `pruneSessions` (`sessionStore.js:327-341`) de-duplicates saved records by
  **working directory**, not by session id — and explicitly exempts two records
  that were both live at the last close.

What the user sees when this happens: the second slot spawns
`claude --resume <same id>`, `claude` refuses with *"belongs to another running
Claude Code session"*, the classifier catches it, and the card reads *held by a
background agent* — pointing the user at a background agent that does not
exist. The real cause is the slot next door.

Separately, `:resume <slot>` filters slot numbers to `1..10`
(`App.jsx:1028`) while the fleet can hold up to 64 (`fleet.mjs:70`). On a fleet
larger than ten, `:resume 11` is silently ignored. **Hardcoded 10 standing in
for `fleet.slots`.**

---

## Can the restart budget strand a live conversation?

**It strands the slot, not the conversation.** Exercised above: after the third
crash the agent reports `error`, the process is gone, `killed` stays false, and
the session id is still held. The transcript on disk is untouched, so `K` then
`:resume` brings the conversation back.

Two real costs:

1. The whole budget is spent in roughly 22 seconds (2 s + 5 s + 15 s). Any
   outage longer than that — a network drop, a service incident, a laptop
   sleeping — permanently errors the slot. Nothing ever retries.
2. Until the `belongs to another running Claude Code session` wording was added
   to the classifier (`ledgerOwner.mjs:39`), those three restarts were fired at
   a session `claude` already held, which is what happened to crm-helper. That
   specific wording now matches — verified above. The next wording change will
   do it again, because nothing checks the phrases against a live `claude`.

---

## Summary

**62 features examined.** A row that carries two claims of different strength
is counted once, at its weakest claim.

| Evidence tier | Count |
|---|---|
| exercised (I ran it and watched) | 36 |
| traced (`file:line`, not run) | 14 |
| test only — pins behaviour, not correctness | 3 |
| unverified | 9 |

**Verdict, cutting across the tiers:**

| Verdict | Count |
|---|---|
| works as intended | 38 |
| works, with a caveat named in its row | 5 |
| **broken** | 10 |
| present but unproven (unverified, no reason to suspect it either way) | 9 |

The five with a caveat: `approve()` (doubtful, unconfirmed) · hook `timeout`
(value present, source doubtful) · `Fleet.setSlots()` (one odd edge at zero) ·
background-agent count (partly) · zoom session id detection (works as written,
wrong by design).

Every broken item was reached by exercising or tracing, not by a failing test.
The suite is green.

**Hardcoded values standing in for a measurement — 14 found:**
`costWeek: 0` (`ptyAgent.mjs:1326`) · hook `timeout: 5` (`hookSettings.mjs:29`)
· `READY_MS = 3000` (`ptyAgent.mjs:226`) · `RESTART_MAX = 3` and the
`[2000,5000,15000]` backoff (`ptyAgent.mjs:233`, `:672`) · `RESTART_STABLE_MS =
60_000` (`ptyAgent.mjs:679`) · classifier `windowMs = 20_000`
(`ledgerOwner.mjs:45`) · `SUB_ACTIVE_MS = 15_000` beside a measured 166 s
(`ptyAgent.mjs:158`) · `STUCK_MIN_THRESHOLD = 5` (`ptyAgent.mjs:1121`) ·
`TERM_SCROLLBACK = 5000` (`ptyAgent.mjs:61`) · the 1.5 s shutdown grace
(`main.jsx:229`, `:325`) · watcher cadence 1500/3000 ms (`fleet.mjs:27-28`) ·
`KILL_GRACE_MS`, `SESSION_DETECT_MS`, `QUIET_HOLD_MS`, `MAX_HOLD_MS`
(`zoomSession.mjs:25-40`) · slot cap `10` in `:resume` against a 64-slot fleet
(`App.jsx:1028`) · the approval sentence `'yes, please continue with the
proposed action'` (`ptyAgent.mjs:719`).

---

## BROKEN

### 1. A dead session still reports IDLE — two of the three ways it can die

`server/ptyAgent.mjs:673` and `server/ptyAgent.mjs:1274`

The guard added for the crm-helper incident only fires when the stored status
is exactly `error`, and `error` is only ever set when the restart budget runs
out. Every other way a process can die leaves the card reporting a healthy
session over a process that no longer exists.

Exercised, real node-pty child, killed from outside:

```
after external SIGKILL -> pty: GONE _statusValue=idle toJSON.status=idle restartCount=0
tail: sys:process exited code=0 signal=9
```

Through the spawn seam, all four routes:

```
exit code=0      pty=GONE  _statusValue=idle     toJSON.status=idle
exit code=1 x3   pty=GONE  _statusValue=error    toJSON.status=error   <- the only covered case
exit SIGKILL     pty=GONE  _statusValue=idle     toJSON.status=idle
working, exit0   pty=GONE  _statusValue=working  toJSON.status=working
```

Two separate causes:

- **Signal deaths are invisible.** node-pty reports a signal death as
  `{"exitCode":0,"signal":9}` — exit code **zero**, signal as a **number**.
  `transient = code !== 0 && code != null` (`:673`) is therefore false for
  every signal death. A `claude` killed by the system running out of memory, by
  Activity Monitor, or by `killall claude` gets **no restart, no error, and no
  change to the card.**
- **Clean exits are invisible.** A user typing `/exit` inside the zoom view
  exits 0. Same path, same silence.

Related dead code at `ptyAgent.mjs:631`:
`if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;` — node-pty gives
signal as a number, so this string comparison can never be true. (It *is*
meaningful in the legacy `agent.mjs:576`, which uses a different spawn API that
reports signal names.)

**A test pins this defect.** `tests/ptyAgent.erroredSlot.test.mjs:42-48`,
"a slot in the restart backoff is not mislabelled as errored", builds an agent
with no process, an untouched status and a quiet idle hook, and asserts the
status is **not** `error`. That state is indistinguishable from a process that
died cleanly or was killed. The test passes, and it locks in the wrong answer.

### 2. `K` orphans a `claude` that ignores SIGTERM

`server/fleet.mjs:229-237`

`Fleet.kill(id)` sends SIGTERM and then immediately removes the agent from the
slot table. Every escalation path in the program — `hardKillAll()` at
`fleet.mjs:278-280`, and both shutdown nets in `main.jsx` — walks that same slot
table. Once the slot is `null` the process is unreachable by all of them.

Exercised, with a `claude` stand-in that ignores SIGTERM:

```
spawned pid 5210 alive? true
fleet.kill returned true
after fleet.kill + 1.2s  -> child alive? true
slot 1 in fleet.agents  -> null
after killAll+hardKillAll -> child alive? true
final (after our own SIGKILL) -> child alive? false
```

**The orphan then survives Mission Control's own exit.** Exercised separately —
launch, press `K`, then let Mission Control shut down normally:

```
ROUTE=self     mc reaped · claude-killed-with-K  ORPHAN, STILL ALIVE
ROUTE=sigterm  mc reaped · claude-killed-with-K  ORPHAN, STILL ALIVE
```

Compare that with the exit-route table above, where a wedged `claude` **still in
the slot table** was reaped on every route except SIGKILL. Pressing `K` first
makes it strictly worse: it removes the only handle the escalation had, and the
terminal hang-up cannot finish the job because this is precisely the kind of
`claude` that ignores SIGHUP.

This needs no crash and no force-close. It is one keystroke in normal use
(`App.jsx:1648`, and three more call sites at `:770`, `:848`, `:963`). The
orphan then holds that session's lock, which is exactly what makes a session
un-resumable later — and the user has no way of knowing, because the card is
gone from the screen.

### 3. The same session can be run twice, in two slots, at once

`server/fleet.mjs:218-227` (no guard), `tui/App.jsx:1047` (guards the wrong
thing), `tui/lib/sessionStore.js:327-341` (de-duplicates by folder, not by
session)

Exercised: two `fleet.resume()` calls with one session id produced two live
agents holding `11111111-2222-3333-4444-555555555555`. See the section above
for what the user sees — a card blaming a background agent that does not exist.

### 4. Un-pausing always claims the session is working

`server/ptyAgent.mjs:844`

`resume()` assigns `'working'` no matter what the session was doing before it
was frozen. Exercised: an idle agent, paused, then resumed, reported `working`
with nothing running.

The card then shows a spinner and an elapsed-time counter for a session that is
sitting at its prompt. On a session with no hook feed it will also start
accruing the `STUCK` warning, because in that case `STUCK` keys off exactly this
stored value (`ptyAgent.mjs:1288`). On a hooked session `STUCK` reads the hook
channel instead (`ptyAgent.mjs:1287`), so only the spinner is wrong there.

### 5. A resume that quietly is not a resume still says "resumed"

`server/ptyAgent.mjs:419-424`, toast at `tui/App.jsx:1809`

When the transcript file is not where Mission Control expects it,
`--resume <id>` silently becomes `--session-id <id>` and `this.resuming` is set
back to false. `claude` then starts a **brand-new empty conversation** under
that id. The toast still says `resumed slot N · <name>` and the card looks
normal. The only trace is one word in the fleet log line — `spawn` rather than
`resume` (`ptyAgent.mjs:445`).

Exercised: constructed with `resume: true` and no transcript on disk, the
captured argv was `--session-id`, not `--resume`.

The file path is derived from the working directory
(`claudeSessionPath({cwd, sessionId})`), so a moved repository, a pruned
transcript, or a cloud-sync delay all land here.

### 6. Changing model or permission mode runs two `claude`s on one session

`server/ptyAgent.mjs:928-930`, `:941-943`, `:950-994`

`#teardownForRestart()` sends SIGTERM, which is asynchronous, and `start()` runs
on the very next line of the same tick. Exercised, real processes:

```
immediately after changeModel(): old pid=27237 alive=true  new pid=27273 alive=true
two claude processes on one sessionId at the same instant: true
```

For a `claude` that exits promptly on SIGTERM the overlap is milliseconds. For
one wedged on a permission prompt it lasts as long as the wedge. During the
overlap two processes hold the same session.

What I could not check without a real `claude`: whether its session lock rejects
the new process during that window. If it does, the refusal arrives well inside
the classifier's 20-second window (`ledgerOwner.mjs:45`), so **Shift+Tab — a
routine permission-mode cycle — would surface as "held by a background agent."**
Treat this as a check to run against a real `claude`, not a confirmed
user-visible failure. The mechanism is confirmed; the consequence is not.

### 7. `killShellSession()` does not kill the shell

`server/shellSession.mjs:247-249`, called from `tui/main.jsx:214`, `:294`,
`:310`

It sends SIGTERM only. An interactive shell ignores SIGTERM. There is no SIGKILL
escalation for the overlay shell anywhere — `hardKillAll()` covers fleet agents
only.

Exercised:

```
overlay shell pid=12825 alive=true; process inside it pid=12873 alive=true
after killShellSession -> shell=true inner=true
```

In practice nothing is orphaned, because when the Mission Control process exits
the terminal hangs up and the shell honours it — confirmed on all four exit
routes. So the function does not cause an orphan; it simply does not do what its
name and its three call sites claim. Anything that calls it expecting the shell
to be gone — and anything that relies on it while the process keeps running —
is relying on a no-op.

This also matters for what is inside the shell. On this machine the overlay
shell has its own bare `claude` running inside it, which the fleet view cannot
see. That `claude` is a grandchild: `killShellSession()` never signals it, and
`hardKillAll()` never reaches it, because node-pty signals a single process
(`node_modules/node-pty/lib/unixTerminal.js:226-230`). It survives until the
terminal hang-up, and it survives that too if it ignores SIGHUP.

### 8. Mock mode's promise of "no real claude" is not kept in zoom

`server/mockAgent.mjs` (no `attachZoomView`), `tui/zoom/PtyPane.jsx:172-174`,
`server/zoomSession.mjs:136`, banner at `tui/main.jsx:44`

Boot in mock mode prints:

> `[mc] MOCK MODE: fixture=… (no real claude subprocess will spawn)`

`PtyPane` picks its zoom strategy by asking whether the agent has
`attachZoomView`. Exercised: `MockAgent.attachZoomView is undefined`, and it has
a session id. Traced from there: the ternary at `PtyPane.jsx:172-174` takes the
legacy branch, which spawns `CLAUDE_BIN` for real (`zoomSession.mjs:136`). I
stopped at the precondition rather than let a spawn happen.

Severity: this is the mode used for UI work without spending money, and the
banner is the reason a developer trusts it.

### 9. Weekly cost is always zero

`server/ptyAgent.mjs:1326`

`toJSON()` ships `costWeek: 0` as a literal. Every card, on every slot, for
every session, reports no weekly spend. A **hardcoded value going into the UI as
though it were data** — the exact pattern the stabilisation task is about. The
per-session figure beside it (`costSession`) is real.

### 10. The emergency fallback path is behind on three safety fixes

`server/agent.mjs` — reachable only with `FLEET_USE_PTY=0`

The legacy stream-json agent is kept as an emergency rollback, and it never
received three fixes the main path has:

- **No early-exit classifier** (`agent.mjs:573-615`). It burns its whole restart
  budget against a session `claude` already holds — the exact crm-helper
  failure, still live on this path.
- **`kill()` does not wake a frozen process** (`agent.mjs:763-779`). Killing a
  paused slot leaves the process frozen with an unreceived request to stop, and
  the slot is then dropped from the table, so nothing can ever reach it. This is
  the stranding that `ptyAgent.mjs:885-894` was fixed for.
- **Same clean-exit hole as BROKEN #1** (`agent.mjs:585`) — an exit code of zero
  or a death by signal leaves the card reporting a healthy session.

Rolling back to this path to escape a problem would reintroduce three known
ones.

---

## Not checked (stated so nobody assumes otherwise)

- Anything requiring a real `claude`: whether `approve()`'s sentence actually
  answers a permission prompt; whether the session lock rejects the overlapping
  process in BROKEN #6; whether `--session-id` on an id `claude` already knows
  fails or silently forks.
- The clean-quit route (`q` → save) end to end. It shares its escalation with
  the signal routes, which were exercised, but the Ink teardown between them was
  not.
- `attachZoomView()`'s normal path, the zoom quiet-hold timing, `cd`-on-focus,
  the instance lock's live behaviour, and the SIGTSTP swallow.
- The three file watchers each agent starts. They are started and stopped on
  every lifecycle path I traced, but I did not confirm no watcher leaks across a
  full launch → relaunch → kill cycle.
