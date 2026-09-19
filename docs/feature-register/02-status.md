# Feature register 02 — status

What the status area is expected to do, whether it does it, and how I know.
Written 2026-09-19 against the working tree — commit `f2fda14` plus the
uncommitted additions to `server/ptyAgent.mjs` and `server/ledgerOwner.mjs`
(25 added lines between them), and the untracked `server/claudeSessions.mjs`.

**Terms used below.** *Hook feed* — the file claude appends one line to every
time it starts a tool, finishes one, stops, or shows a notification; Mission
Control owns these under `~/.local/state/claude-mc/status/<session>.ndjson`.
*Transcript* — claude's own conversation log,
`~/.claude/projects/<encoded-cwd>/<session>.jsonl`; Mission Control calls its
reader the *connector*. *Scraper* — a regular expression run over the rendered
terminal picture, used where neither file carries the fact.

**How the evidence was gathered.** Three harnesses, run on this machine against
the user's live data, none of them tests and none of them spawning a `claude`:

- **R1** — replayed every line of the hook feeds through the shipped
  `mapEventToStatus`, reproducing `doRead()`'s gates exactly, and printed the
  resulting status next to the age of the event it came from. Run over the
  eight most recently written feeds in detail, and over all 133 for the
  abandoned-prompt count.
- **R2** — constructed a real `PtyAgent` (constructor only — no process), set
  its clocks to values measured in R1, and called the real `toJSON()`.
- **R3** — ran the real `startSubagentUsageTailer` with `autoStart:false`
  against a real session's `subagents/` directory and called `scan()` then
  `liveAgents()`.

Two facts are taken as given from the task file and not re-derived: the
seven-of-seven slot cross-check, and the measurement that this conversation
moved to session `f7f1a6de` while Mission Control watched `aae20e51`.

---

## Part 1 — every status a card can show

| Feature | Expected to do | Does it? | How I know |
|---|---|---|---|
| **WORKING** | Show claude is mid-turn. | **No — it is the state a silent source freezes into.** The hook feed is sticky: a tool-start with no matching stop leaves `working` standing forever, because nothing ever compares the event's own age against the clock. | Ran R2 on the shape R1 measured from `aae20e51`: hook feed's newest tool-start is **64 minutes old**, `toJSON()` returns `status=working`. `server/ptyAgent.mjs:1172-1189` — the sticky-working branch reads only `hookStatus`, never a timestamp. |
| **IDLE** | Show the turn is over and claude is at the prompt. | **No — it is also what an unknown slot renders as.** A slot whose hook feed never spoke and whose connector never fired returns `idle`, identical to a genuinely finished session. | Ran R2: `hookStatus=null`, connector never set, every clock cold → `status=idle`. `server/ptyAgent.mjs:1151` (`this.status` getter → `_statusValue \|\| 'idle'`) and `:381`. There is no `unknown` value anywhere in the merge. |
| **INPUT?** (`waiting`) | Show claude is blocked on the user. | **Partly — it misses the notification claude now sends for exactly this.** claude emits `Notification: agent_needs_input`; the mapper knows only `permission_prompt` and `idle_prompt` and returns null for the rest, so the card keeps whatever it had. | Counted across every live hook feed: `agent_needs_input` ×8, `agent_completed` ×5, `auth_success` ×3 — none mapped. `server/statusHookTailer.mjs:277-281`. The last two lines of `aae20e51`'s feed are both `agent_needs_input`; R1 still derives `working` from the 64-minute-old tool-start before them. |
| **INPUT?** from a blocking tool | A plan approval or a question tool outranks sticky-working. | **Yes.** Requires the pending prompt to carry a `.tool` field, so it fires only on protocol facts, not on text guesses. | Ran R2: hook `working` + `awaitingPrompt={kind:'approval',tool:'ExitPlanMode'}` → `waiting`; the same with no `.tool` → `working`. `server/ptyAgent.mjs:1158-1171`. |
| **INPUT?** from a text question | A question in claude's final message flips the card. | **Only when the hook feed happens to be quieter than the transcript.** Under the hook path a text-sourced prompt is deliberately excluded from the override and survives only via the idle-arbitration fall-through. | Ran R2: hook `idle` stamped 1 min ago + connector `waiting` stamped now → `waiting`; hook `working` + the same connector state → `working`, the prompt discarded. `server/ptyAgent.mjs:1196`, `:1158`. |
| **INPUT?** when nobody ever answers | Stop claiming a prompt is pending once it is plainly abandoned. | **No — it stands forever, and the stuck warning is structurally barred from firing on it.** Only a `working` mapping is eligible for stuck minutes under the hook path, so a prompt nobody answered never warns. The project states the opposite rule in its own dead code: "a prompt nobody answered for six days is abandoned, not pending." | Ran R2: hook `waiting` with the activity clock 3 hours stale → `status=waiting`, `stuckMin=0`. Ran R1 across **every** live hook feed: **6 of them stand on `waiting`**, the oldest **1621 hours** (67 days) stale. `server/ptyAgent.mjs:1156-1157` (no age check) and `:1286-1288` (hooked path admits only `working`; the un-hooked path at the same line admits `waiting` too, so the two branches disagree). The rule that is missing here is applied at `server/bgSessions.mjs:173-181`. |
| **APPROVE?** | Show the terminal's permission box before the slow notification arrives. | **Unverified.** The scraper is gated on the terminal having gone quiet and on a triple anchor. I did not render a real permission box, so I cannot say whether it fires. | Read only: `server/ptyAgent.mjs:1172-1189` (`!ptyFresh && this.#scanApprovalPrompt()`), anchors at `:118-120`. The comment says the anchors were widened after a session blocked on an edit sat on `working`; the value `WORKING_FRESH_MS = 2500` at `:151` has no measurement behind it. |
| **ERROR** | Show a slot whose claude is gone and will not come back. | **Yes — but the fix is not committed.** A dead process with the stored error survives the merge. | Ran R2: `pty=null`, stored `error` → `status=error`, including when the hook feed still says `working`. `server/ptyAgent.mjs:1274`; `pty` is nulled at `:608` before the error branch at `:661`. **That line is one of the 14 uncommitted additions to `ptyAgent.mjs`** — on `main` this row reads *broken*, and its comment records the case: a slot with no claude process showing IDLE while the header counted zero errors. |
| **PAUSED** | Show a slot the user froze with a signal. | **No.** Under the hook path `paused` is discarded. A paused agent emits no hook events, so its last mapping stands — a slot paused mid-tool reads WORKING and starts counting stuck minutes. | Ran R2: `_statusValue='paused'` + `hookStatus='working'` → `status=working`. The word `paused` appears in the merge only at `server/ptyAgent.mjs:1115`, inside `#collectSignals()`, which nothing consumes. `pause()` sets it at `:829`. |
| **EMPTY** | Mark a slot with no agent in it. | **Yes.** Not produced by the merge at all — the fleet substitutes a fixed object for an unoccupied slot. | Traced: `server/fleet.mjs:52` emits `status:'empty'`; consumed at `tui/App.jsx:349,469,491,516,552` and `tui/Card.jsx:84`. Never reaches `toJSON()`. |
| **STUCK {n}m** chip | Warn that claude is alive but wedged. | **No — it measures the wrong silence.** The clock it reads is bumped by every byte the terminal paints, including cosmetic repaints the code names itself. A session whose hook feed has been silent for hours, with claude still redrawing, never accrues a minute. | Ran R2: hook `working`, terminal clock fresh → `stuckMin=0`; the same with the terminal clock stale → `stuckMin=31`. `stuckMin` reads `lastEventTs` (`:1290`), which `onData` bumps at `:518-519`; the comment at `:345-351` lists the cosmetic writers. |
| **STUCK** suppression | Do not cry wedged while sub-agents are running. | **No — an abandoned entry suppresses it for half an hour.** Suppression asks only whether the pending map is non-empty; the thirty-minute abandonment cutoff is applied to the count, not to this gate. | Ran R2: one pending sub-agent aged 31 min → `stuckMin=0` while the same shape with none → `stuckMin=31`. Gate at `server/ptyAgent.mjs:1285`; the cutoff that does not apply to it is at `:1242`. |
| **`{n}bg WORKING`** chip | Report how many background agents are live, counted for real. | **No — it counts every sub-agent the session has ever run, for the first ~30 s after it attaches.** The priming pass records a byte offset and skips the growth bookkeeping; the next pass then sees no recorded size, calls the file "grown", and stamps it live. | Ran R3 against the real `aae20e51/subagents/` directory, whose newest file was last written **13.8 hours ago**: scan 1 → 0 live; scan 2 → **67 live, every one stamped 0.0 s old**. The skip is `server/subagentUsageTailer.mjs:188-192` (`continue` before the `lastGrowTs` write at `:195`); `liveAgents()` at `:240-248`; consumed at `server/ptyAgent.mjs:1238`. |
| **`?bg WORKING`** chip | Say "live but uncountable" rather than inventing a number. | **Yes.** This is the part of the background work that is honest. | Ran R2: sub-hook clock 10 s old with nothing countable → `bgCount=null`, `bgStatus='working'`; at 90 s → `0`/`null`. `server/ptyAgent.mjs:1259-1260`, rendered at `tui/Card.jsx:168-171`. |
| **Background forks** (a conversation moved into the background under a new id) | Summarise them beside the parent's status. | **No — the code that would do it is unreachable.** `bgStatusFromEvents` and `aggregateBg` have no caller outside their own module and one test file. The chip therefore sees only sub-agents of the session being watched; a fork under a new id is invisible. | Grepped the whole tree excluding `node_modules`: the only cross-module imports from `server/bgSessions.mjs` are `classifyTranscript` (`server/sessionFileTailer.mjs:35`) and `BG_SUB_ACTIVE_MS` (`server/ptyAgent.mjs:25`). `aggregateBg` (`:198`), `bgStatusFromEvents` (`:146`), `BG_STALE_MS` (`:45`) and `STATUS_TAIL_BYTES` (`:41`) appear only in `tests/bgSessions.test.mjs`. |
| **`activeSubagents`** list (Zoom, `⋔` indicator) | Name the fan-out currently running. | **No — it disagrees with the chip beside it.** The list is built from the pending map without the abandonment cutoff the count applies, and falls back to the same 67-strong file list. | Ran R2: one pending sub-agent aged 40 min → `bgCount=0`, `bgStatus=null`, and `activeSubagents.length=1`. Chip and list contradict each other on the same render. `server/ptyAgent.mjs:1294-1305` vs `:1242-1244`. |

---

## Part 2 — the mechanisms behind those states

| Feature | Expected to do | Does it? | How I know |
|---|---|---|---|
| Hook event → status mapping (`mapEventToStatus`) | Turn one hook line into `working` / `waiting` / `idle` / nothing. | **Partly.** The five event names it knows are the only five the emitter writes, so no event name is missed. Three of the five notification types in the wild are unmapped (row 3 of Part 1). | Counted every line of every live hook feed: events are `PreToolUse` 86 452, `PostToolUse` 26 003, `Stop` 3 028, `UserPromptSubmit` 2 745, `Notification` 2 489 — and the emitter writes exactly those (`server/hookSettings.mjs:36-51`). Mapper at `server/statusHookTailer.mjs:262-292`. |
| Freshness stamp (`hookStatusTs`) | Record when the status became true, so a stale feed can be told from a live one. | **No — it records when Mission Control read the line, not when claude wrote it.** Every record carries its own `ts` and nothing reads it. The reader starts at byte 0, so the entire back-history is ingested at attach and the last line of a fourteen-hour-old file is stamped "now". | Ran R1 across the eight newest feeds: every one derives `hookStatusTs = now` while the event behind it is 1.4 min to 867.6 min old. `agent.hookStatusTs = Date.now()` at `server/statusHookTailer.mjs:114` (and `:103`); `offset = 0` at `:219`. The dead `bgStatusFromEvents` applies exactly the missing check at `server/bgSessions.mjs:179`. |
| Idle arbitration (hook stop vs transcript) | Let a stop win only when it is newer than the last transcript event. | **Yes as written, but it compares a read-time against an event-time**, so it is only correct while both feeds are live. | Ran R2 both ways: hook `idle` newer → `idle`; hook `idle` older → the connector's `working`. `server/ptyAgent.mjs:1196`. The left side of that comparison is the read-time above; the right side is a genuine event time (`server/jsonlConnector.mjs:235`). |
| Sub-agent hook gate | Stop a background agent's tool traffic from overwriting the main thread's status. | **Yes.** Sub-tagged tool events feed a liveness clock only; notifications and stops from a sub still flow through. | Traced and exercised in R1, which reproduces the gate: `server/statusHookTailer.mjs:73-86`; the tag is written by the emitter at `server/hooks/emit-status.mjs:57` when claude's payload carries an agent id. |
| Lifting a stale INPUT? on the answer | When an approved tool runs, stop showing NEEDS INPUT. | **Unverified.** The branch is unambiguous but I did not observe a real permission prompt being answered. | Read only: `server/statusHookTailer.mjs:99-107`. The comment cites 368 recorded prompts with a median 15.1 s stall; I did not reproduce that measurement. |
| Clearing a resolved question | When a question tool finishes, drop the pending prompt. | **Unverified.** | Read only: `server/statusHookTailer.mjs:88-96`. |
| NDJSON tailing (`createReadCore`) | Read only what is new, survive partial lines and truncation. | **Yes.** Offsets advance past complete lines, a trailing fragment is held, a shrunken file resets. | Exercised through R1, which parsed 366 to 12 452 real lines per file with no loss. `server/statusHookTailer.mjs:198-260`. Correct as a tailer — its `offset = 0` start is what makes the freshness row above wrong, not this. |
| Re-pointing the hook feed after the session id changes | Follow the feed when the session rotates. | **Yes.** Re-resolved on every read pass, with the watcher rebuilt. | Traced: `server/statusHookTailer.mjs:51-61`, called first thing in `doRead()` at `:66`. Whether the session id it follows is the *right* one is the rotation row below. |
| Transcript event parsing (`parseEvent`) | Derive status, activity, tokens, cost, context, todos from claude's own log. | **Yes for the shapes it handles**, and the two noise gates are real: metadata writes and locally-handled slash commands return before the clock bumps, so they cannot out-fresh a stop. | Traced end to end: `server/jsonlConnector.mjs:186-238` (gates at `:217`, `:218-226`; clock at `:228-235`), handlers at `:240`, `:336`, `:491`, `:568`. |
| Interrupt detection | Treat an Escape interrupt as the end of the turn, since claude sends no stop for it. | **Test only — pins behaviour, not correctness.** The pattern matches the opening of the recorded tool result, and it writes the missing idle into the hook channel itself. | `server/jsonlConnector.mjs:260`, `:279-290`. Evidence is `tests/jsonlConnector.test.mjs`; I did not interrupt a real session. |
| Sub-agent tool tracking | Recognise the tool that launches a sub-agent. | **Yes, and the rename is covered.** The set is `Task`, `Agent`, `Workflow`. | `server/eventShapes.mjs:18`. Given from the task file: claude renamed the tool to `Agent`; the set now carries all three. The set is a hand-typed list with no check against the live tool catalogue — see the hardcoded-values list. |
| Cost derivation (`deriveCost`) | Price a turn from the token block and the model's rates. | **Yes arithmetically**, including the cache-creation and cache-read multipliers and the unknown-model fallback. | Ran it directly on a realistic token block for four model names: `claude-opus-4-7` → $0.2112 (catalogue rate), `claude-fable-6-0` → $0.4225 (Fable 5.1 rate), unknown → $0.2112 (newest Opus). `server/jsonlConnector.mjs:155-169`. |
| Telling an estimated price from a real one | Mark a cost that came from a guessed rate. | **No — the mark is computed from the wrong thing.** The estimate flag lives on the rate table entry that priced the turn, but the card looks the model up again by name and falls back to the slot's configured model, which is not flagged. Any unrecognised model name also silently inherits Opus rates. | Ran the lookup the card runs: `estimatedPricingFor('totally-unknown-model')` → `OPUS 4.8, estimatedPricing=true`, while `tui/Card.jsx:126` resolves `modelByCli(resolvedModel) \|\| MODELS[agent.model]` → the unflagged slot model, so the `~` at `tui/Card.jsx:453` never prints. Fallback rule at `tui/lib/models.js:134-140`. |
| Token de-duplication | Count each message's tokens once despite repeated log lines. | **Test only — pins behaviour, not correctness.** The delta-by-message-id scheme is sound on inspection and the comment cites a 3.5× over-count it removed; I did not re-measure against a real transcript. | `server/jsonlConnector.mjs:410-437`. |
| Context gauge | Show the live conversation window, excluding sub-agents. | **Unverified.** The sidechain guard is explicit; I did not compare the rendered figure against a transcript. | Read only: `server/jsonlConnector.mjs:452`. |
| API-error handling | Stay working through retries, error only when they are exhausted. | **Test only — pins behaviour, not correctness.** | `server/jsonlConnector.mjs:493-531`. |
| Sub-agent token folding | Add a sub-agent's spend to its parent without double-counting on resume. | **Yes.** Files present at attach start at end-of-file, so nothing historical is re-counted. | Ran R3 against 67 real, fully-written sub-agent files: `tokensIn` folded = 0, cost = $0.0000. `server/subagentUsageTailer.mjs:188-191`. The same `continue` that makes this correct is what breaks the live count above. |
| Text-question classifier (`detectPrompt`) | Recognise a numbered, lettered, checkbox or yes/no question in claude's prose. | **Test only — pins behaviour, not correctness.** It is a guess by construction and the merge treats it as one. | `server/detectPrompt.mjs:46-121`, excluded from the hook override at `server/ptyAgent.mjs:1158`. |
| Blocking-tool classifier (`promptFromToolUse`) | Recognise the two tools that block on a human. | **Yes as a mapping**, and it is the signal the merge trusts. The tool names are hand-typed with no check against the live catalogue. | `server/detectPrompt.mjs:134-157`; consumed at `server/jsonlConnector.mjs:381-382` and `server/ptyAgent.mjs:1158`. Exercised in R2 (row 4 of Part 1). |
| Session-locked refusal matcher | Recognise claude refusing to resume a session another process holds, and stop retrying. | **Yes — verified against the shipped binary, but the fix is not committed.** | Ran `strings` over the real `claude` at `/opt/homebrew/Caskroom/claude-code/2.1.267/claude`: `"belongs to another running Claude Code session"` → 2 hits, `"locked by another process"` → 6 hits. Both are in the pattern at `server/ledgerOwner.mjs:29-51`. Consumed at `server/ptyAgent.mjs:651`. **Both phrases are among the 11 uncommitted additions to `ledgerOwner.mjs`** — on `main` the matcher knows only the four older phrasings and this row reads *broken*. |
| Naming the holder (`findLedgerOwner`) | Turn an opaque refusal into "what is holding it and what it is doing". | **Unverified.** The lookup is keyed on the first eight characters of the session id matching a directory name under `~/.claude/jobs/`; I did not reproduce a refusal. | Read only: `server/ledgerOwner.mjs:58-69`, consumed at `server/ptyAgent.mjs:652-655`. |
| Background-fork recognition (`classifyTail` / `classifyTranscript`) | Stop the rotation hunt from adopting a background fork as the slot's session. | **Unverified.** The design is careful and its negative verdicts are deliberately provisional. I did not run it against a known fork transcript. | Read only: `server/bgSessions.mjs:81-140`, consumed at `server/sessionFileTailer.mjs:154`. This is the one part of `bgSessions.mjs` that is actually wired. |
| Session identity and rotation | Keep the card pointed at the conversation the user is having. | **No — this is the root cause named in the task file.** Identity is guessed by listing transcript files and taking the newest one written after a floor, which is why a conversation that moves into the background is left behind. | Given, measured 2026-09-19: this conversation moved to `f7f1a6de` while Mission Control watched `aae20e51`. Mechanism: `server/sessionFileTailer.mjs:130-158` (`readdir` + `mtimeMs` sort) driven from `:379-420`. The hunt runs only once the watched file is already dead (`:386-387`), so a slot whose old file is still being touched never looks. |
| Priming status on attach | Recover the session's current status from the tail of the transcript. | **Unverified.** The scratch-object replay that protects the additive counters is clear on inspection; I did not attach to a live session. | Read only: `server/sessionFileTailer.mjs:262-323`. |
| `costWeek` in the status payload | Report the week's spend. | **It is the literal `0`**, overlaid later by the interface from a separate store. Harmless as wired, but it is a measurement slot filled with a constant inside the status object. | `server/ptyAgent.mjs:1326`; overlay at `tui/App.jsx:393`. The same literal is in `server/agent.mjs:888` and `server/mockAgent.mjs:331`. |
| Process cost (`procCpu`, `procMemKb`) | Report real CPU and memory for the slot's process. | **Yes — real samples**, taken from one `ps` covering every live process id. | Traced: written at `server/fleet.mjs:103-124`, passed through at `server/ptyAgent.mjs:1328-1329`. |

---

## Summary

Every row is counted in exactly one bucket. A row is **broken** when the thing
it names does not do what it is expected to do — the cells reading "No", plus
the one "Partly" that hides a real gap (unmapped notification types). The other
"Partly" row — the event-name mapping — is counted **verified**, because the
names themselves are complete and its gap is already counted once, above.

| Verdict | Count |
|---|---|
| Verified — ran it against real data, or traced every hop | 18 |
| Test only — pins behaviour, not correctness | 4 |
| Unverified — say so plainly | 7 |
| **Broken** | **13** |
| **Total rows** | **42** |

Thirteen of the forty-two items in this area do not do what they are expected
to do. **Eleven of the thirteen were established by running code on this
machine against the user's own data**, not by reading it. The other two are the
unreachable background-fork summary, found by grepping the whole tree for
callers, and the session-identity defect, which the task file already measured.

### Broken, with locations

1. **A status with no source renders as `idle`.** A slot whose hook feed never
   spoke and whose transcript never fired is indistinguishable from a finished
   one. There is no `unknown` value in the merge.
   `server/ptyAgent.mjs:1151`, `:381`.

2. **The freshness stamp records the read, not the event.** Every hook record
   carries its own timestamp; nothing reads it. The reader starts at byte zero,
   so a fourteen-hour-old last line is stamped "now" the moment a slot attaches.
   This is the single line that makes silence indistinguishable from activity.
   `server/statusHookTailer.mjs:114`, `:103`, `:219`.

3. **Sticky WORKING never ages out.** A tool-start with no matching stop stands
   forever. Measured on `aae20e51`: 64 minutes and counting.
   `server/ptyAgent.mjs:1172-1189`.

4. **An unrecognised notification type is silently discarded rather than
   surfaced.** The mapper returns nothing for anything but the two types it was
   written against, so new vocabulary from claude vanishes without a trace —
   and three of the five types now in the wild are new: `agent_needs_input`
   (×8), `agent_completed` (×5), `auth_success` (×3). `agent_needs_input` is
   the newest event in the frozen session's feed, and it changed nothing. In
   **6 of its 8 occurrences it is the last line of the file** — never followed
   by a prompt submission or a stop, so nothing ever resolved it. I have no
   documentation for what claude means by these names; the reading that the
   first two matter is inferred from the names and that ending pattern. The
   defect stands either way: a signal Mission Control cannot interpret should
   be reported as uninterpreted, not dropped. `server/statusHookTailer.mjs:277-281`.

5. **PAUSED is discarded under the hook path.** A frozen slot reads WORKING —
   and, because it emits nothing, starts accruing stuck minutes.
   `server/ptyAgent.mjs:1155-1197`; the `paused` signal is collected at `:1115`
   and never consumed.

6. **STUCK measures the wrong silence.** It reads a clock the terminal bumps on
   every cosmetic repaint, so the exact scenario it exists for — hook feed
   silent for hours, claude still painting — scores zero.
   `server/ptyAgent.mjs:1290` reading the clock written at `:518-519`.

7. **STUCK is suppressed for thirty minutes by an abandoned sub-agent entry.**
   The suppression gate ignores the abandonment cutoff the count applies.
   `server/ptyAgent.mjs:1285` vs `:1242`.

8. **The background-agent count reports every sub-agent the session ever ran.**
   Measured: 67 files, none touched for 13.8 hours, all reported live and all
   stamped zero seconds old. The window is roughly thirty seconds after each
   attach — and it re-opens on every session-id rotation, which is the event
   this app handles most often. `server/subagentUsageTailer.mjs:188-192`
   (`continue` before `:195`), surfaced via `:240-248` into
   `server/ptyAgent.mjs:1238`.

9. **The background-fork summary is unreachable code.** `bgStatusFromEvents`
   and `aggregateBg` have no caller outside their own module and one test file,
   so a conversation that moved into the background under a new session id is
   invisible to the chip — the same root cause as the frozen card, in a fourth
   costume. `server/bgSessions.mjs:146`, `:198`; unused constants at `:41`,
   `:45`.

10. **The chip and the sub-agent list contradict each other on the same
    render.** The count drops an abandoned entry; the list still names it.
    `server/ptyAgent.mjs:1294-1305` vs `:1242-1244`.

11. **An estimated price is rendered as an exact one.** The card looks the model
    up again by name instead of reading the rate that actually priced the turn,
    so the `~` marker is decided by the slot's configured model, not by the
    estimate. `tui/Card.jsx:126` and `:453` vs `server/jsonlConnector.mjs:157`.

12. **Session identity is guessed from file timestamps** — the root cause the
    task file names. The card follows whichever transcript in the project
    directory was written most recently after a floor, and it only goes looking
    once the file it holds is already dead, so a conversation that moves into
    claude's background under a new session id is never followed.
    `server/sessionFileTailer.mjs:130-158`, driven from `:379-420`, gated at
    `:386-387`. The replacement already exists and is unwired:
    `server/claudeSessions.mjs` asks claude for its own session list, and its
    only reference anywhere in the tree is `tests/claudeSessions.test.mjs:14`.

13. **A prompt nobody ever answers reads INPUT? forever, and cannot warn.**
    No age check is applied to a `waiting` mapping, and the stuck warning is
    barred from firing on one — the hooked path admits only `working` as
    stuck-eligible while the un-hooked path at the same line admits `waiting`
    too, so the two branches disagree. Six live hook feeds currently stand on
    `waiting`, the oldest stale by 67 days. `server/ptyAgent.mjs:1156-1157` and
    `:1286-1288`. The rule that is missing here is written out in the dead
    module at `server/bgSessions.mjs:173-181`.

### Hardcoded values standing in for a measurement

Two kinds. **Defensible** — a threshold whose comment cites the measurement it
came from: `BG_SUB_ACTIVE_MS = 60 s` (`server/bgSessions.mjs:46`, sub-agent
tool events measured 166 s apart), `KIND_TAIL_BYTES = 16 KiB`
(`server/bgSessions.mjs:40`, measured across five real transcripts),
`BG_STALE_MS = 10 min` (`server/bgSessions.mjs:45`, from forks listed as
awaiting input for six days — though nothing reads it), `REPLAY_BYTES`,
`DIR_HUNT_UNCONDITIONAL_EVERY` and the creation-poll schedule in
`server/sessionFileTailer.mjs:186`, `:118`, `:126`.

**Flagged — no measurement behind them:**

- `costWeek: 0` — `server/ptyAgent.mjs:1326`. A literal in a measurement slot.
- `STUCK_MIN_THRESHOLD = 5` — `server/ptyAgent.mjs:1121`.
- `WORKING_FRESH_MS = 2500` — `server/ptyAgent.mjs:151`. Gates both the
  terminal-scrape overlay and the permission-box scraper.
- `SUB_ACTIVE_MS = 15_000` — `server/ptyAgent.mjs:158`. **Dead.** Grepped: its
  only remaining mentions are two comments at `:1249` and `:1252`, and the
  second claims it "still serves its other, tighter callers" — there are none.
- `BG_ABANDON_MS = 30 min` — `server/ptyAgent.mjs:163`, mirroring
  `SUBAGENT_STALE_MS` at `server/jsonlConnector.mjs:37` by hand.
- `USAGE_BY_MSG_MAX = 512`, `PENDING_SUBAGENT_MAX = 256` —
  `server/jsonlConnector.mjs:34`, `:38`.
- `SETTLE_IDLE_MS = 30_000`, `ABSENT_GRACE = 20`, `ABSENT_BACKOFF = 8` —
  `server/subagentUsageTailer.mjs:84`, `:101-102`. The first of these is what
  bounds defect 8's false window.
- `MAX_OPTIONS = 9` and every phrase in the question classifier —
  `server/detectPrompt.mjs:21-33`, `:116`.
- Hand-typed vocabulary of claude's that has no check against a live source:
  the sub-agent tool names (`server/eventShapes.mjs:18`), the blocking-tool
  names (`server/detectPrompt.mjs:135`, `:140`), the notification types
  (`server/statusHookTailer.mjs:278-279`), the event names
  (`server/hookSettings.mjs:36-51`). The refusal phrases at
  `server/ledgerOwner.mjs:29-51` are the only ones I checked against the
  shipped binary, and they match.

### A note on the tests in this area

The task's warning holds. `tests/subagentCount.test.mjs:29-35` re-implements the
background-count decision in a local helper and asserts against the copy; it
calls the real `liveAgents()` only on an empty directory (`:18-22`). That is why
defect 8 — a count of 67 where the truth is 0 — passes its own test. Any test
cited above is labelled *test only — pins behaviour, not correctness*.

### Leaked test data (outside this area, worth knowing)

The test suite has written **602** directories named `mc-subusage-*` into the
user's real `~/.claude/projects/` tree. They are harmless to the rotation hunt,
which lists one project's own directory and never the root — they simply
clutter the root alongside the user's real projects.
