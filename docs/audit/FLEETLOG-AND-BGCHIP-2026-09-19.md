# Fleet log root cause + background chip audit — 2026-09-19

Method: two multi-agent audits. Every finding below was handed to an independent
reviewer told to refute it. Only findings the reviewer could NOT refute are listed
as confirmed. Six other candidate defects were rejected this way and are not here.

---

## 1. Fleet log: why four fixes did not fix it

**Confirmed. Reproduced by running the real module.**

Attaching to a session that already has a transcript replays the history into a
throwaway object and then throws the history away.

- `server/sessionFileTailer.mjs:280-285` — `primeStatusFromDisk()` builds a scratch
  object with `tail: []`, commented "absorb the additive side-effects".
- `:287-290` — the real `parseEvent` runs over the last 256 KiB, so the scratch
  really does fill with asst/user/tool/sys/err entries.
- `:301-321` — the copy-back assigns status, awaitingPrompt, activity, todos,
  tokens/cost/context and resolvedModel. **`scratch.tail` is never merged.**
- `:435-436` and `:415-417` — the read offset then jumps to the EOF the prime
  reached, so the forward tailer never re-reads those records.

`server/ptyAgent.mjs:543` is the only production caller and passes no `fromStart`,
so `fromStart = false` (`:193`). This is the ordinary path for every attach to an
existing transcript.

Proof from a live probe against a real 24-record transcript:

```
AFTER PRIME:          tail entries = 0   status = idle   kinds: []
AFTER 1 LIVE EVENT:   tail entries = 1   ["live one"]
```

### Why the earlier fixes could not work

`deriveFleetLog` reads nothing but `a.tail` (`tui/FleetLog.jsx:49-50`). The four
prior commits enlarged the ring (TAIL_SHIP 16 → 320), fixed the render budget and
added the history/height tag. The ring they enlarged is empty on every resume.

### Scope

- A **fresh launch** loses nothing. The transcript does not exist, prime returns
  null, offset = 0 (`:437-441`).
- The loss hits **resume, Mission Control restart, and transcript rotation**
  (`fleet.mjs:272`, `resumeAllSessions` / `launchFromRecord` / `autoResumeOnStart`,
  and the repoint at `:415-417`).

### The naive fix is wrong

Appending `scratch.tail` unconditionally duplicates the primed window. `PtyAgent.start()`
also runs on auto-restart (`ptyAgent.mjs:684-695`), `changeModel` (`:957`) and
`changePermissionMode` (`:944`), where `agent.tail` is already populated. The merge
needs a guard, and the rotation-repoint path needs one too.

### Test gap

All 28 fleet-log tests pass. `tests/FleetLog.supply.test.jsx` builds tails
synthetically; `tests/sessionFileTailer.integration.test.mjs:191` asserts status and
tokens after the prime but never `agent.tail`. No test covers attach → tail → fleet log.

---

## 2. Hiding the fleet log still costs its screen rows

**Confirmed.**

`showFleetLog` never reaches the layout math. Three hits in all product code: the
default (`tui/lib/settings.js:39`), the schema row (`:130`) and the render guard
(`tui/App.jsx:2217`).

`computeGridLayout` (`tui/lib/gridLayout.js:55-63`) has no `showFleetLog` parameter,
and `:80` adds `FLEETLOG_HEAD_H + fleetLogLines` into `chromeH` unconditionally.
Nothing zeroes `fleetLogLines` when the toggle is off, and the sanitizer clamps it to
the schema minimum of 4.

Both call sites omit it: `tui/App.jsx:1899-1907` (render) and `tui/App.jsx:1566-1573`
(the `[` / `]` pane-switch handler), so pane navigation also steps by the wrong
`perPage`. The suppressed rows are absorbed as blank screen by the spacer at
`App.jsx:2220`.

---

## 3. The `Nbg WORKING` chip is not redundant with `⋔N agents running`

Three adversarial reviewers, three different lenses, none could refute it.

In the common branch the digit IS a duplicate: `server/ptyAgent.mjs:1271` sets
`bgCount = liveSubFiles.length` and `:1312-1320` maps the same array into
`activeSubagents`, so `bgCount === activeSubagents.length` by construction.

The chip carries information the subline cannot in these cases:

| Case | Chip | `↳` row |
|---|---|---|
| A. Hook-clock only (`ptyAgent.mjs:1276-1277`) | `· ?bg WORKING` | `—` (activeSubagents is `[]`) |
| B. Pending Task older than 30 min (`:1259-1261` filters, `:1312-1316` does not) | suppressed or undercount | `⋔3 agents running` |
| C. Approval pending (`Card.jsx:170` gates on `!approval`) | suppressed | `⋔N agents running` |
| D. Exactly one task (`Card.jsx:247-249`) | `· 1bg WORKING` | `⋔ <label>` — no digit |

Case A is decisive and is the case the chip was built for. `status` does not cover
for it: 0403 superseded the 0398 override (`ptyAgent.mjs:1230-1244`), so the main
thread still reads IDLE while background work runs.

### Do not delete `bgLive`

`bgLive` (`Card.jsx:168`) also gates the triage verb at `Card.jsx:281`, turning
`needs a nudge →` into `check back`. Rewriting it as `subCount > 0` re-opens the
0409 / 0408-D2 bug on the hook-clock path.

### What shipped

The tally is gone; the label stays. `tui/Card.jsx` now renders ` · bg WORKING`
instead of ` · 3bg WORKING` and ` · ?bg WORKING`.

```
[13] stonks                     ○ IDLE · bg WORKING
▸ check back
↳ ⋔3 agents running
```

The digit was the redundant half and it is removed. The two letters stay because
on the hook-clock path the `↳` row reads `—` and the main status reads IDLE, so
`IDLE · WORKING` would put two contradictory status words on one row separated
only by colour.

```
[13] stonks                     ○ IDLE · bg WORKING
▸ check back
↳ —
```

`bgLive` is untouched, so the triage verb at `Card.jsx:281` still reads
`check back` rather than `needs a nudge`.

Test updated: `tests/Card.triage.test.jsx:49` now asserts `/· bg WORKING/` and
adds `assert.doesNotMatch(f, /3bg/)`.

### Separate readout, not covered here

`tui/Aggregate.jsx:66-78` renders `bg N` in the fleet header. It counts claude
sessions running OUTSIDE the fleet, not sub-agents. Unrelated to the card chip.

---

## 4. Background agent counts read zero while workflows are running

**Confirmed. Measured live on the stonks slot, 2026-09-19 22:40.**

`server/subagentUsageTailer.mjs` scans one directory, not a tree.

- `:107-110` — `subagentsDir()` returns `<projectDir>/<sid>/subagents`.
- `:165` — `files = await fsp.readdir(dir)` is non-recursive and returns names only.
- `:174` — `if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue` — a
  directory entry named `workflows` is skipped like any other non-match.

Claude Code writes WORKFLOW sub-agents one level deeper, to
`<sid>/subagents/workflows/<runId>/agent-<id>.jsonl`. Task sub-agents still land
at the top level. So the scan sees the Task agents and none of the workflow ones.

Measured on `add052b8` (Mission Control slot 13, stonks):

| Where | Count |
|---|---|
| `agent-*.jsonl` directly in `subagents/` (scanned) | 20 |
| `agent-*.jsonl` under `subagents/workflows/` (skipped) | 60 |

In the 60-second window `liveAgents()` uses (`BG_SUB_ACTIVE_MS`,
`server/bgSessions.mjs:46`), at the moment of measurement:

| Window | Files the scan sees | Files it skips |
|---|---|---|
| 60s | 0 | 4 |
| 10m | 0 | 6 |
| 1h | 1 | 15 |

Five most recently written sub-agent files, all invisible:

```
INVISIBLE   75s ago  workflows/wf_38964223-ed2/agent-a05bf4a67c64db6be.jsonl
INVISIBLE   34s ago  workflows/wf_f7b2358e-5bb/agent-ab115c824f15dbb98.jsonl
INVISIBLE    6s ago  workflows/wf_38964223-ed2/agent-acf5ed032f78bd96f.jsonl
INVISIBLE    5s ago  workflows/wf_38964223-ed2/agent-aff0307ddbde9c36f.jsonl
INVISIBLE    1s ago  workflows/wf_38964223-ed2/agent-aeff640758b7118c6.jsonl
```

Two consequences.

1. `liveAgents()` returns `[]`, so `server/ptyAgent.mjs:1271` leaves `bgCount` at 0
   and the chip vanishes while a workflow fan-out is running.
2. The module's stated job is to fold each file's usage into the parent
   (`:51-52`). Sixty files of token spend are never folded, so the session's cost
   and token totals under-report.

The `fs.watch` at `:245` watches the same directory non-recursively, so nested
files do not wake it either.

---

## 5. Scroll

Six findings survived adversarial review. Three were rejected.

### 5.1 A restart destroys the scrollback (task 0402, still open, still present)

`server/ptyAgent.mjs:457-465`. `start()` unconditionally disposes the old
`Terminal` and constructs a new one with `scrollback: TERM_SCROLLBACK` (5000,
`:60`). There is no `if (!this.term)` guard, no reuse branch, no
resize-instead path. Every restart, resume, model change and permission change
throws the whole 5000-line history away, so the zoom view has nothing to scroll.

### 5.2 PageUp and PageDown no longer reach the shell child — a regression

`tui/modals/ShellOverlay.jsx:160-166`. The branch added by d9b2fd7 returns
unconditionally, so the key never reaches `keyToBytes` at `:189`. Before that
commit it fell through and was written to the pty as `CSI 5~` / `CSI 6~`
(`tui/zoom/ptyKeys.js:42-43`).

Measured with a spy on the real `pty.write`:

```
HEAD        normal buffer -> pty writes []            (emulator scrolls, scrollBack=11)
HEAD        alt buffer    -> pty writes []            (scrollLines is a no-op, scrollBack=0)
d9b2fd7^    normal buffer -> pty writes ESC[5~
d9b2fd7^    alt buffer    -> pty writes ESC[5~ ESC[6~
control 'q' -> pty writes ["q"] in every run
```

So inside `less`, `man`, `vim` or `htop` the key does nothing at all. The pager
never receives it, and the alternate buffer has no scrollback to move.

### 5.3 Neither view detects the alternate screen

`ShellOverlay.jsx:160-168` scrolls the emulator and reads
`baseY - viewportY`, which is identically 0 on the alternate buffer, so the
`▲ n back` indicator never appears. Nothing checks `buffer.active.type`.

### 5.4 A resize snaps a scrolled-back reader to the bottom

`tui/zoom/PtyPane.jsx:361-370`. The effect keyed `[cols, rows]` calls
`term.scrollToBottom()` at `:368` with no `scrollMode` guard and without
resetting `skipBackRef` or `scrollOffset`. Compare `toBottom()` at `:423-428`,
which resets all three. `rows` is volatile: `tui/modals/Zoom.jsx:207` recomputes
`bodyRows` from the terminal size and from optional panels.

### 5.5 The shell overlay paints the cursor on the wrong row when scrolled

`tui/modals/ShellOverlay.jsx:213-219`. `y` indexes the rendered window, whose
buffer row is `viewportY + y`, but `cursorY` (`:206`) is `buf.cursorY`, which
xterm reports relative to `baseY`. Two coordinate systems compared directly.

### 5.6 The shell-overlay scroll test never renders the component

`tests/shellOverlay.scroll.test.jsx:8-12` imports only `node:test`,
`node:assert/strict` and `@xterm/headless`. It drives a bare emulator and never
mounts `ShellOverlay`, never writes a byte to stdin. Proven by mutation: the
tests still pass with the component's scroll binding removed. That is why 5.2
shipped green.

### Rejected

- Mouse wheel cannot scroll anything. The alt-screen switch at
  `tui/main.jsx:176` is deliberate and documented.
- An empty buffer shows a non-zero offset that never moves.
- Entering scroll mode immediately jumps the view.

### What is NOT broken

40 of 40 zoom, scroll and geometry tests pass. The bug d9b2fd7 set out to fix is
genuinely fixed: a parked reader is no longer dragged down by new output,
measured at 40 lines. Key routing is fine; nothing swallows the scroll keys.
Task 0405 is stale and can be closed. Task 0357 is half fixed.

---

## 6. The card's two clocks

**Confirmed.** Both are anchored to the moment Mission Control constructed the
agent object, not to the conversation.

- `spawnedAt` has exactly two assignment sites, both constructors:
  `server/agent.mjs:113` and `server/ptyAgent.mjs:287`.
- It correctly survives auto-restart, `changeModel` and `changePermissionMode`,
  which reuse the instance (`ptyAgent.mjs:692-695`, `:940-962`). That much works
  as the comment at `agent.mjs:110-112` claims.
- It does NOT survive a resume or a Mission Control restart.
  `server/fleet.mjs:272` `resume()` calls `launch()` which does
  `new PtyAgent(...)` at `:242`, minting a fresh timestamp.

Observed consequence: seven slots launched within one second all read the same
hourglass value, and a conversation whose first transcript record is dated
2026-08-30 renders as `46m`.

`stateSince` is correct. It measures time in the current state and is guarded
against no-op writes (`ptyAgent.mjs:383`).

### There is no existing source for true conversation age

- `tui/lib/sessionStore.js` writes `lastSeen` into every `bySlot` record and
  nothing else time-shaped. `firstSeen` exists only on `history[]` entries, which
  are reference-only and trimmed to `sessionHistoryLimit` (live value 20).
- `claude agents --json` reports `startedAt` as PROCESS start, not conversation
  start. Session `9ca62749` appears twice in that list with different ages.
  Wiring it to the card would reproduce the same defect.
- The tailer has never read the head of a transcript.
  `primeStatusFromDisk` (`server/sessionFileTailer.mjs:262-266`) reads
  `size - REPLAY_BYTES` to EOF and drops the partial first line.

The cheapest correct source is the first record's timestamp in
`<sid>.jsonl`, read once on attach and persisted per slot.
