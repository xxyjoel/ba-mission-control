# Single-pipeline rewrite — research notes

Each `R<n>` task from `.claude/plans/single-pipeline-rewrite.md` lands a
finding here. Empty section = "not yet investigated."

---

## R1 — claude interactive boot signal ✓ INVESTIGATED

**Probe:** `scripts/probe-pty.mjs`, results in `docs/notes/probe-pty.log`.

- **First stdout byte at +219ms** (cold spawn).
- Banner is fully drawn within ~500ms; the prompt position `❯` is
  visible by then.
- **No deterministic "ready" JSONL event** — claude does not write
  to the session file at all until the user submits their first
  prompt (see R2).
- **Safe minimum delay before first `pty.write()`**: 3 seconds.
  Lower (1-2s) might work but the banner sometimes redraws and
  could swallow early input. 3s gives a comfortable margin without
  feeling slow.

**Implication for PtyAgent:**
- Set status='idle' immediately on construct (no spinning).
- pendingSends queue absorbs any messages that arrive in the first
  ~3s before we let the PTY start receiving keystrokes.
- A ready timer of 3000ms after spawn drains the queue.

---

## R2 — JSONL existence at session start ✓ INVESTIGATED

**Answer: NO — JSONL is created only AFTER the first user message
commits.** In the probe, the file appeared at +4542ms, exactly when
the Enter (`\r`) hit, having sent the prompt at +3504ms.

This matches the documented "session is created on first turn"
behavior of claude code.

**Implication:** the tailer MUST use the poll-for-creation path. The
existing `sessionFileTailer.mjs:init()` already does this (falls back
to `setInterval(attemptAttach, 500)` if the initial watcher attach
fails). No code change required.

**Implication for the "claude minted a different sid" detection:**
also a non-issue at startup — claude doesn't write any file at all
until first commit, so the directory diff at +3s would still be
empty. The detection timer should fire AFTER the first user message
is sent, not before.

---

## R3 — claude-minted vs honored sids ✓ INVESTIGATED

**Probe finding:** `--session-id` was honored cleanly. The file
appeared at our specified path with no minted sid.

This contradicts what we saw earlier during the zoom-flow debugging.
Hypothesis for the discrepancy: claude only mints its own sid when
an EXISTING file at our sid is malformed or claude can't open it for
some reason. For brand-new sessions it just uses what we passed.

**Implication for PtyAgent:**
- Default path: trust `--session-id` is honored. No detection scan
  needed for the common case.
- Defensive fallback: keep the existing dir-scan detection (porting
  from zoomSession.mjs) as a safety net, but reduce its visibility
  in the logs since it should almost never fire for `--session-id`
  on a clean session.
- `--resume` is a different story: if the file we point at doesn't
  exist, fall back to `--session-id` (the existing existsSync guard
  at `agent.mjs:380` handles this).

---

## R4 — sending prompts via PTY stdin ✓ INVESTIGATED (single-line)

**Probe finding:** typing `"say only the word pong, nothing else"`
char-by-char (15ms per char) followed by `\r` landed cleanly as a
single user event with the expected content string.

**Recommendations:**
- For programmatic prompts (broadcast, /compact-restart, initial
  prompt on launch): type char-by-char with ~10-15ms inter-char
  delay. Avoids any input-buffering quirks.
- For multi-line content: NOT YET TESTED. Defer to a follow-up
  probe before B4 ships. Bracketed paste (`\x1b[200~ … \x1b[201~`)
  is the safest envelope per the keyboard-input docs claude itself
  recommends.

**TODO before B4:** quick probe of multi-line. Try:
1. Raw `\n` in the middle of typed text → does claude submit on \n
   or only on \r?
2. Bracketed paste with embedded newlines → does claude treat as
   one paste?

---

## R5 — slash command via PTY stdin

**Status:** PENDING

Targets:
- `/help\r` — does the help UI render?
- `/compact\r` — does claude's native compact trigger? If yes, mc's
  custom `/compact` shim at `tui/App.jsx:550` can be deleted.
- `/clear\r` — claude's UI-clear vs mc's kill-and-relaunch
  (DECISION-2).
- `/resume\r` — would surface claude's own session picker; we don't
  want it conflicting with mc's `:resume`.

---

## R6 — model pricing table completeness ✓ INVESTIGATED

**File checked:** `tui/lib/models.js`

Current fields per model:
```js
{ label, cliModel, kind, maxCtx, costPerMTokIn, costPerMTokOut }
```

**Missing for accurate JSONL cost derivation:**
- `costPerMTokCacheRead` — Anthropic pricing: 0.1× `costPerMTokIn`
- `costPerMTokCacheCreation` — Anthropic pricing: 1.25× `costPerMTokIn`

JSONL `assistant.message.usage` carries:
- `input_tokens` × `costPerMTokIn`
- `cache_creation_input_tokens` × `costPerMTokCacheCreation` (1.25×)
- `cache_read_input_tokens` × `costPerMTokCacheRead` (0.1×)
- `output_tokens` × `costPerMTokOut`

Without the missing fields, derived cost will systematically over- or
under-report by the cache fraction. For typical mc sessions with heavy
prompt-cache reuse, cache_read can dominate the input column — getting
this wrong would skew the daily/weekly budget tracking.

**Action:** Phase A2 must extend MODELS schema. Derive values as 0.1× /
1.25× of `costPerMTokIn` unless explicit values land. Document on the
model rows that these are derived rates per Anthropic's published table.

Also: Opus 4.8 still has TODO at line 27-30 — pricing is a placeholder
(mirrored from 4.7). Worth a one-line web check on Anthropic's pricing
page before shipping.

---

## R7 — JSONL event freshness + fs.watch on macOS ✓ INVESTIGATED

**Probe findings (single message, multiple appends):**

- File appeared at +4542ms (right when Enter was pressed). fsWatch
  attached at +4543ms.
- **First fsWatch fire at +4627ms** (+84ms after attach) — the
  initial commit (user event, permission-mode, file-history-snapshot,
  attachments) bundled into one ~24KB write.
- Second fire at +5829ms (+1.2s later) — the ai-title event.
- Third fire at +6947ms (+1.1s later) — the assistant response.

**Conclusions:**
- fs.watch fires reliably for appends on macOS (within this probe).
- Latency from "claude commits an event" to "tailer sees it" is
  about 80-100ms (the watcher debounce). Acceptable for UI feel.
- **No poll fallback needed for steady-state operation.** The
  existing init() poll for file-creation is sufficient.

**Caveat:** the probe was single-message. Heavy concurrent writes
(N tools running in parallel) weren't tested. If field reports show
missed events, fall back to a 200ms poll alongside fs.watch.

---

## R8 — PTY without controlling TTY

**Status:** PENDING

Does claude write JSONL even when there's no real terminal attached?
Relevant for test harness (R13).

---

## R9 — PTY child reaping on mc exit

**Status:** PENDING

node-pty default is to NOT kill children on parent exit unless
explicitly configured. After mc shuts down, do PTY claudes linger as
orphan processes?

Action if linger: register SIGINT/SIGTERM handler in `tui/main.jsx` that
kills all `fleet.agents[i].pty` before exiting.

---

## R10 — Broadcast under concurrency

**Status:** PENDING

When `agent.broadcast(text)` writes to all 10 PTY stdins in a tight
loop, does anything drop? Pipe buffers are typically 64K on macOS — even
a long markdown paste fits.

---

## R11 — Permission mode sync ✓ PARTIALLY INVESTIGATED

**Probe finding (startup):** claude wrote a `permission-mode` event
at session creation with `"permissionMode": "acceptEdits"` (what we
passed via `--permission-mode`). Confirms the event type fires.

**Not yet probed:** does claude write a NEW `permission-mode` event
when the user presses Shift+Tab to cycle modes mid-session? Need a
follow-up probe.

**Implication for jsonlConnector:** parse `permission-mode` events
and write to `agent.permissionMode`. The startup event ensures we
always have a baseline; runtime events (if they fire) keep mc in
sync with claude's cycled state.

**Follow-up probe:** spawn claude, type Shift+Tab a couple times,
inspect JSONL.

---

## R12 — PTY width/height for non-zoomed slots

**Status:** PENDING

Default: 80×24 for non-zoomed slots. When user zooms in to a 200×60
terminal, we `pty.resize(200, 60)`. When user zooms out, `pty.resize(80,
24)`. Does claude's UI reflow correctly on each resize, or does
mid-stream content get garbled?

Same concern: when terminal window itself resizes (user resizes their
iTerm window), does Ink re-render with new dims and does our PTY
follow?

---

## R13 — Test harness strategy ✓ DECIDED

**Status:** DECIDED — see chosen approach below.

**Options considered:**
1. Stub node-pty with a fake spawner emitting canned JSONL
2. Mock at jsonlConnector level (test the parser only, skip PTY)
3. Skip integration tests, rely on smoke tests

**Chosen: hybrid (2 + 1 partial).**

- `jsonlConnector.parseEvent()` and `deriveCost()` get comprehensive
  unit tests against recorded JSONL fixtures (Phase A4, A5). This
  catches 80%+ of regressions.
- PtyAgent gets a constructor option `spawn: (bin, args, opts) =>
  PTY-like object` that defaults to `node-pty.spawn` but is replaceable
  in tests. The "PTY-like" object only needs `.write()`, `.onData()`,
  `.onExit()`, `.kill()`, `.resize()`. Easy to stub.
- Integration: one opt-in test (`MC_INTEGRATION=1 npm test`) spawns a
  real `claude` and runs a single round-trip. Skipped by default to
  avoid API costs in CI.

This decision lets us delete the existing `MockAgent.replay.test.mjs`
(fixture-based replay against a stubbed binary). The new approach
tests the same things more directly.

DECISION-3 in plan resolves to: delete `server/mockAgent.mjs`. Update
tests to use the new spawn-stub pattern.

---

## R14 — Resume semantics on first launch ✓ DECIDED

**Status:** DECIDED via existing code.

Already implemented in `server/zoomSession.mjs:97-100` and
`server/agent.mjs:380-396`. Pattern:

```js
const sessionFile = claudeSessionPath({ cwd, sessionId });
const args = existsSync(sessionFile)
  ? ['--resume', sessionId]
  : ['--session-id', sessionId];
```

Port to PtyAgent.start() (B2). One flag set works for both new and
resumed sessions.

---

## R15 — Single PTY for stdin AND stdout ✓ INVESTIGATED

**Probe finding:** banner rendered correctly (model name, branch,
working dir, prompt indicator, suggestion bar). xterm rendering
worked. The probe was using node-pty which gives claude a real TTY
in both directions. No issues observed.

Already implicit in zoom-mode working visually for the past several
days. Confirmed.
