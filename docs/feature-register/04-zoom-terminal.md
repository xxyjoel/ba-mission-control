# Feature register 04 — the zoom view and the terminal inside it

Area: `tui/modals/Zoom.jsx`, `tui/zoom/PtyPane.jsx`, `tui/zoom/ptyKeys.js`,
`tui/zoom/zoomKeys.js`, `tui/zoom/claudeBanner.js`, `tui/lib/zoomGeometry.js`,
and the shell overlay surface in `tui/App.jsx` + `server/shellSession.mjs`.

Written 2026-09-19 against commit `f2fda14`, working tree clean.

## Terms

- **Emulator** — a headless copy of a terminal (`@xterm/headless`) that reads
  every byte claude prints and keeps the resulting grid of characters in
  memory. Mission Control never shows claude's output directly; it reads this
  grid and redraws it.
- **Scrollback** — the rows that have scrolled off the top of the emulator's
  screen but are still held in memory. 5000 rows per session
  (`server/ptyAgent.mjs:61`).
- **baseY** — how many rows of scrollback exist. `baseY` of 80 means 80 rows
  have scrolled off the top. It is the ceiling on how far back you can scroll.
- **The window** — the slice of the emulator that the zoom modal actually
  draws. The emulator can be taller than the box the modal has room for.
- **Alternate screen** — a second, blank grid a program can switch to for a
  full-screen menu. It has no scrollback at all.

## How the evidence was gathered

Six harnesses, all under the scratchpad, none of them tests, none of them
spawning a real `claude`. Each mounts the real component against a terminal of
an exact size (`tests/lib/render-size.js`) with a real `@xterm/headless` buffer
behind it (`tests/lib/zoom-stub.js`), writes real bytes into the emulator, and
drives real keystrokes through Ink's real parser. Frames are quoted verbatim.

No passing test is counted as proof on its own. Where a test is the only
evidence, the row says "test only — pins behaviour, not correctness".

Words in the "Does it?" column:

| Word | Meaning |
| --- | --- |
| **Yes** | I drove it and watched it work, or traced every hop. |
| **Partly** | Does some of what it claims. The gap is named. |
| **No** | Broken. It does not do what it says. |
| **Unverified** | I did not establish it. No guess offered. |

---

## 1. Scroll — the reported defect

**What scroll is supposed to do.** `README.md:371-375` and `docs/HOTKEYS.md:198-206`
both promise the same thing: `Ctrl+Y` enters scroll mode; `w`/`s` scroll one
line back/forward **through history**; `f`/`b` half a page; `g`/`G` jump to the
oldest/newest line; `Esc` or any other key leaves. `docs/HOTKEYS.md:208-210`
states the original goal plainly: "scroll the PTY viewport up/down
(xterm-headless has 5000 lines of scrollback enabled but PtyPane never reads
above the visible viewport)".

**The short answer.** The mechanism works. Every key does what the README says,
and it does reach real scrollback. But the scroll position is measured from
claude's *live* cursor rather than from a fixed row of history, so the moment
claude prints anything the view slides forward by exactly as many lines as it
printed. Park 20 lines back, let claude print 20 lines, and you are at the
bottom again — while the on-screen counter still says you are parked. For a
user who scrolls up during or just after a response, scroll does not work.

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| `Ctrl+Y` enters scroll mode | Show the `▲ SCROLL` hint row and stop sending keys to claude | Yes | Rendered. 100 rows written into a 20-row emulator, pane 20 rows. Frame after `\x19`: the hint row reads `▲ SCROLL 0 · w/s line · f/b half-page up/down · g/G top/bottom · Esc resume claude`. |
| `w` / `s` — one line back / forward | Move the window one row per press | Yes | Rendered. `Ctrl+Y` → window `L082…L100`; `w`×10 → `L072…L090`, counter 10; `s`×4 → `L076…L094`, counter 6. |
| `f` / `b` — half a page up / down | `f` up, `b` down (swapped from the less convention on purpose, `PtyPane.jsx:382-384`) | Yes | Rendered. From counter 6: `f` → counter 15, window `L067…L085`; `b` → counter 6, window `L076…L094`. Half-page is 9 for a 19-row window, which matches `Math.floor(viewRows / 2)` at `PtyPane.jsx:378`. |
| `g` / `G` — oldest / newest | Jump to the top of history and back to live | Yes | Rendered. `g` → `L001…L019` (the very first row written); `G` → `L082…L100` (live). |
| Any other key leaves scroll mode | Drop the keystroke, return input to claude | Yes | Rendered. `x` → hint gone, window snapped back to `L081…L100`. |
| Nothing leaks to claude while scrolling | The PTY must receive no bytes during scroll mode | Yes | Rendered. After `Ctrl+Y`, `w`×10, `s`×4, `f`, `b`, `x`, the stub PTY's write log is `[]`. |
| Scroll reaches real scrollback, not just the visible screen | Read rows that have scrolled off the top | Yes | Rendered, and this is the case the repo's own test never covers. 100 rows into a 20-row emulator gives `baseY=80`. `g` reached `L001`. The existing test (`tests/zoom/ptyPane.geometry.test.jsx:147`) writes exactly 20 rows into a 20-row emulator, so `baseY=0` — it only ever scrolls inside the visible screen. |
| Works at every pane/emulator shape | Pane shorter, equal, and taller than the emulator | Yes | Rendered, four shapes. Pane 20 vs emulator 20: `g` → `L001…L019`. Pane 12 vs 20: `g` → `L001…L011`. Pane 21 vs 20: `g` → `L001…L020`. No scrollback at all: `g` → `L001…L011`. |
| Scroll survives the app's re-render cadence | App re-renders roughly ten times a second while claude works (`App.jsx:114`), each time with a fresh agent object out of `fleet.snapshot()` | Yes | Rendered. Scrolled to counter 8, window `L074…L092`; then five re-renders with a newly spread agent object carrying the same id — window and counter unchanged at `L074…L092`, `▲ SCROLL 8`. |
| **Hold position while claude keeps printing** | "Scroll one line back … through history" (`README.md:372`) — a position in history, not a moving window | **No** | Rendered. Parked at counter 20 reading `L062 … L080`, then claude printed 5 lines at a time:<br>`▲ SCROLL 20  window = L067 … L085`<br>`▲ SCROLL 20  window = L072 … L090`<br>`▲ SCROLL 20  window = L077 … L095`<br>`▲ SCROLL 20  window = L082 … L100`<br>Twenty lines of output and the user is back at the bottom, with the counter still claiming 20. Cause: `PtyPane.jsx:515` computes `startY = buf.viewportY + skip - offset`. `buf.viewportY` is the live viewport, which moves down one row per printed line, so the offset is subtracted from a moving origin. |
| Entering scroll mode should not move the view | Pressing `Ctrl+Y` alone should change nothing but add the hint | **No** | Rendered. Before `Ctrl+Y` the window is `L081…L100`; after, `L082…L100`. The hint row is charged against the same row budget as the terminal rows (`PtyPane.jsx:156-157`), so the window shrinks by one and, being bottom-anchored, drops its top line. You lose a line of what you were reading at the instant you ask to scroll. |
| Scroll while claude shows a full-screen menu | Unstated. `tui/zoom/CAPABILITIES.md:16` claims the alternate screen is "✓ Transparent … any full-screen claude UI Just Works" | **Unverified** — hypothesis with a measurement attached | I cannot observe claude switching screens without spawning it, so I will not claim it does. What I did measure: driving `\x1b[?1049h` into the emulator switches `buffer.active` from `type=normal baseY=80 length=100` to `type=alternate baseY=0 length=20`. With `baseY=0` the scroll ceiling at `PtyPane.jsx:377` collapses, and `w`×10 moved the counter from 0 to 1 and stopped. **If** claude ever uses the alternate screen, scroll is dead for as long as it is there, and `CAPABILITIES.md:16` is wrong for scroll even though it is right for drawing. Settle it by capturing one real session's PTY bytes and grepping for `?1049h`. |
| Scroll after claude clears the screen | Unstated | **Unverified** — hypothesis with a measurement attached | Measured on the emulator only: writing `\x1b[3J` (erase saved lines) took `baseY` from 80 to 0. Any sequence claude emits that clears saved lines empties the history scroll can reach. Whether claude emits it is not established here. |
| Mouse wheel / trackpad scroll | Nothing — mouse support is a stated non-goal (`CLAUDE.md`, "Non-goals") | Yes, by design | Traced. `tui/zoom/CAPABILITIES.md:28` records mouse tracking as dropped. Worth stating plainly in the register because "scroll does not work" is what a trackpad gesture feels like. |
| `Shift+PageUp`, `PageUp`, arrows | Forwarded to claude, not handled by Mission Control | Yes | Driven. `keyToBytes` returns `\x1b[5~` for PageUp and `\x1b[A` for Up; `classifyZoomKey` returns null for both, so `PtyPane.jsx:448` forwards them. `docs/HOTKEYS.md:221` notes claude itself currently does nothing with plain PageUp. So the most instinctive scroll gestures on a terminal all do nothing visible. |

---

## 2. The PTY pane — reading the emulator and drawing it

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Draw the emulator cell for cell | Colours, bold, italic, underline, inverse preserved through `ptyCells.rowToRuns` | Yes, for the text path | Rendered — every probe above reads its rows back out of a real emulator through the real `rowToRuns`. Colour fidelity itself is traced only (`tui/zoom/CAPABILITIES.md:17`), not measured against a reference image. |
| Anchor the window on claude's last written row | Not on the emulator's last row — claude leaves blank rows below its composer, and bottom-anchoring would push real content off the top | Yes | Rendered. 8 rows written into a 20-row emulator, pane 12 rows: all of `L01`…`L08` visible. The anchor logic is `PtyPane.jsx:493-503`. The comment there quotes a real measurement ("Measured on a real session at 40 rows: 9 trailing blanks") — a measurement, not a guess, but one nothing re-checks. |
| Pane taller than the emulator | Draw the emulator and pad, never read past the end | Yes | Rendered. Pane 21 rows against a 20-row emulator drew `L081…L100` plus one blank row. `buf.getLine()` past the end returns undefined and `rowToRuns` yields an empty row. |
| Never resize the agent's PTY when the box changes | A resize makes claude reprint its whole frame and leaves the old copy in scrollback — the "text prints twice" bug | Yes | Test only for the no-resize assertion (`tests/zoom/ptyPane.geometry.test.jsx:91`) — but the test checks a stub's call log, which is the right check, and I re-ran it green. The window-follows-the-box half I rendered directly. |
| Cursor block | Paint a solid accent block at claude's cursor, and only when the live view is on screen | Yes | Rendered, reading the raw frame rather than the stripped one. Emulator reports `cursorY=11 cursorX=4`; the drawn row 11 is `L060<ESC>[1m<ESC>[46m<ESC>[30m <ESC>[39m<ESC>[49m<ESC>[22m` — cyan background, black foreground, exactly one cell, at the right row. After scrolling back 5 rows no cyan-background cell renders anywhere, so the cursor is correctly hidden in history (`PtyPane.jsx:518-521`). |
| "(claude exited)" notice | When claude's process ends, show the notice and close zoom | Yes | Rendered. Firing the stub PTY's exit handler: the pane stayed at its 10 allotted rows and the last two rows read `L010` then `(claude exited)`; `onClose` was called exactly once. |
| Reserve a row for the hint / notice | Rendering `rows` rows plus a footer inside a `height={rows}` box makes Ink drop lines from the *middle* of the view | Yes | Rendered. Entering scroll mode on a 12-row pane kept the frame at 12 rows with 11 contiguous terminal rows and no gaps. Also pinned by `tests/zoom/ptyPane.geometry.test.jsx:169`. |
| Repaint throttling | Coalesce bursts to about 30 frames a second so a streaming response does not pin a CPU core | Unverified | Traced only: `RENDER_INTERVAL_MS = 33` at `PtyPane.jsx:62`, leading-edge scheduling at `:209-217`. **Hardcoded value standing in for a measurement** — 33ms is asserted in the comment to be indistinguishable from 60fps; nothing measures it. |
| Legacy fallback path | When an agent has no `attachZoomView`, spawn a sibling claude via `startZoomSession` and build a throwaway emulator | Unverified | I did not exercise it. It is the only path that still calls `pty.resize` (`PtyPane.jsx:343-346`) and the only one with its own hardcoded `scrollback: 5000` (`PtyPane.jsx:188`), duplicating `TERM_SCROLLBACK` in `server/ptyAgent.mjs:61`. |
| "PTY failed" error banner | Show the message and tell the user to press Ctrl+Q | Yes | Rendered. An agent whose `attachZoomView` throws gives, inside its 8-row box:<br>`PTY failed: attachZoomView: agent.pty`<br>`not running`<br>`press Ctrl+Q to close`<br>The advice is reachable because `Zoom.jsx:86-95` handles Ctrl+Q whether or not the pane mounted. One caveat: the message wraps freely (`PtyPane.jsx:554`), so a long error on a 6-row pane would be clipped by the box rather than truncated to fit. |

---

## 3. Key forwarding — what reaches claude and what Mission Control keeps

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| The five intercepts: `Ctrl+Q` exit, `Ctrl+Y` scroll, `Ctrl+K` tools, `Ctrl+U` stats, `Ctrl+J` newline | Be caught by Mission Control and never reach claude | Yes | `Ctrl+Y`, `Ctrl+K`, `Ctrl+U`, `Ctrl+J` I drove end to end and saw the effect on screen (scroll mode, both panels opening, the wrapped newline). `Ctrl+Q` is test only (`tests/zoom/zoomKeys.realparser.test.jsx`, re-run green) — it drives the real byte through Ink's real parser, which is the right shape of test, but I did not watch a real modal close. |
| Everything else reaches claude | Esc, Ctrl+C, Ctrl+T, Ctrl+S, Shift+Tab, Tab, plain letters | Yes | Test only for the routing assertion (7 forwarding cases in `tests/zoom/zoomKeys.realparser.test.jsx`, re-run green), plus I drove Enter and a text run through to the PTY write log myself. |
| Arrow, page, home/end, backspace, tab, escape, Ctrl+letter, Meta+letter to bytes | Emit what a vt220/xterm terminal would | Yes | Driven byte-exact through `keyToBytes`: Up `1b 5b 41`; Shift+Up `1b 5b 31 3b 32 41`; PageUp `1b 5b 35 7e`; Home `1b 5b 48`; End `1b 5b 46`; Backspace `7f`; Shift+Tab `1b 5b 5a`; Tab `09`; Return `0d`; Escape `1b`; Ctrl+A `01`; Ctrl+C `03`; Meta+b `1b 62`; plain `a` → `a`; empty input → null. |
| Forward Delete | Delete the character to the right | **No** | Driven. `key.delete` returns `7f` — the same byte as Backspace, so forward Delete deletes backwards. Known and documented at `tui/zoom/ptyKeys.js:50-54`: Ink 5 cannot tell the two apart on macOS. A real gap, carrying its own TODO. |
| `Ctrl+]` / `Ctrl+\` not used as bindings | Ink delivers bytes above `0x1a` with `ctrl:false`, so a `key.ctrl && input===']'` test can never fire | Yes | Traced (`tui/zoom/zoomKeys.js:13-17`) and consistent with my own call: `keyToBytes(']', {ctrl:false})` returns `]`. This is documented history, not something I re-derived from Ink's parser. |
| Bracketed paste | When claude has paste mode on, wrap a multi-character chunk in `CSI 200~ … 201~` so a pasted newline is content, not a submit | Yes | Rendered. With paste mode off the PTY log is `["hello world paste","\n","\r"]`. After driving `\x1b[?2004h` into the emulator it is `["\x1b[200~hello world paste\x1b[201~","\x1b[200~\n\x1b[201~","\r"]` — the text and the Ctrl+J newline wrapped, the Enter left bare so claude still sees a submit. |
| Enter marks the card working immediately | Do not wait for claude to commit the event | Yes | Rendered. One `\r` produced exactly one `markUserSubmitted` call. |
| The stub helper's paste recipe | `tests/lib/zoom-stub.js:26-27` tells authors to set `term.modes.bracketedPasteMode = true` before pressing keys | **No** | Driven. `@xterm/headless` returns a **fresh** `modes` object on every access (`t.modes === t.modes` is `false`), so the assignment is silently discarded and the flag stays `false`. Any test written to that recipe exercises the *unwrapped* branch while claiming to test the wrapped one. Only `term.write('\x1b[?2004h')` sets it. Not product code, but it is how a future paste defect would get pinned backwards. |

---

## 4. claude's own "update available" notice

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Recognise claude's update notice | Match the banner claude prints into the body | Yes | Driven. `matchUpdateBanner('Update available: 2.1.180')` and `matchUpdateBanner('Updated to latest. Got 67 features, 394 bugfixes, and 145 other changes.')` both match; the second is the wording claude ≥2.1.267 uses (`claudeBanner.js:30-37`). |
| Blank it from the body and show a chip in the header | Keep it from encroaching on the conversation | Yes | Rendered. The matched row came back blank and `onClaudeUpdate` fired with `{"version":null,"text":"…"}`, which `Zoom.jsx:216-217` turns into the header's `⬆ update` chip. |
| Setting toggle | `hideClaudeUpdateBanner` off means no suppression | Yes | Rendered. Same buffer with `hideUpdateBanner={false}` renders every row intact. |
| **Never blank the user's own text** | The whole point of the 0366 fix (`claudeBanner.js:17-22`): a user's prose must survive | **No** | Rendered. Buffer written: `claude: here is the plan` / `we should ship the new version tomorrow` / `and then restart the worker to apply the config` / `done.`. Frame drawn:<br>`row0 \|claude: here is the plan\|`<br>`row1 \|\|`<br>`row2 \|\|`<br>`row3 \|done.\|`<br>Two ordinary sentences vanished, and the header chip reported "and then restart the worker to apply the config" as a claude update. Driving the matcher directly, all of these are blanked: "we should ship the new version tomorrow", "can you check whether the newer version of the parser is faster", "the update is available in the staging bucket", "restart the worker to apply the config", "rewrite the changelog for the new version bump". Causes: `claudeBanner.js:27` `/\b(new\|newer)\s+version\b/i` is a bare phrase with no context requirement, and `:25`/`:26` allow a cue-word gap that ordinary prose fits inside. The only protection is the cursor row (`PtyPane.jsx:532` skips the row holding the cursor), which does not cover a wrapped composer line, a quoted file, or claude's own prose. |

---

## 5. The modal — panels, and the rows each one is allowed

Rendered at 120×50 with a nine-item todo list, four tool calls and two
sub-agents, modal width 116, height budget 45.

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Header row | Slot, name, model, branch, git chips, permission mode, status — on exactly one row | Yes | Rendered: `[3] mission-control  [SONNET 4.6]  ⎇ feat/zoom +3 ↑1        perm: plan  · ● WORKING`. Frame stayed inside 45 rows. Long names and branches are pre-truncated at `Zoom.jsx:226-232`; the truncation widths (24 for name, 24 for a resolved model) are hardcoded. |
| Compact stats line | Context, tokens, cache, cost, usage windows, health — always visible, one row | Yes | Rendered: `ctx 142.0k/1.0M  14%  ·  in 12.0k↓  out 3.4k↑  cache 900.0k  ·  $1.23 (wk $9.50)  ·  5h 31%  7d 12%`. |
| Compact line with a model the catalog does not know | Show unknown, not a plausible number (the 0409 rule) | Yes | Rendered with `model: 'neptune-9'`: `ctx 142.0k/?  ?%  ·  in 1.0k↓ …`. |
| **Expanded stats panel with an unknown model** | Same rule, or at minimum not crash | **No — it crashes the whole view** | Rendered. With `model: 'neptune-9'` and `Ctrl+U`, the frame collapsed from 45 rows to empty. Wrapped in an error boundary the message is `Cannot read properties of null (reading 'map')`. `Zoom.jsx:142-144` sets `cells = null` when the model has no known context limit; `Zoom.jsx:426` calls `cells.map(...)` with no guard. The 0409 fix was applied to the compact line and not to the panel below it. |
| Expanded stats panel, unknown model, numbers | Show unknown | **No** (same defect, visible if the crash is fixed) | Traced: `Zoom.jsx:422` prints `fmtK(model ? model.maxCtx : 0)` and `:423` prints `(ctxPct * 100).toFixed(0)` — the exact `/0` and `0%` that 0409 removed from the line above. |
| Open tasks panel | claude's todo plan, always visible when todos exist, capped at 8 with a "+N more" tail | Yes | Rendered, 9 todos:<br>`▸ OPEN TASKS  · 1/9 done  · 1 in progress`<br>`✓ wire the adapter` / `▸ driving the scroll path` / `○ write the register` / … / `○ eight` / `  …+1 more`.<br>The in-progress item correctly shows its `activeForm` wording. The cap is a hardcoded `MAX_TODOS_CAP = 8` (`Zoom.jsx:195`). |
| Tools strip (`Ctrl+K`) | One clipped row of per-tool counts, MCP prefix dropped | Yes | Rendered: `tools · Read×2 · Bash×1 · bluearch_scan_aws×1` — the fully-qualified `mcp__bluearch-aws-steward__bluearch_scan_aws` shortened as `Zoom.jsx:61-63` intends. Cap of 8 tools and 24 characters per name are hardcoded (`Zoom.jsx:399,402`). |
| Expanded stats panel (`Ctrl+U`) | Context bar plus a usage column | Yes | Rendered: `CONTEXT` / `142.0k / 1.0M  · 14%` / `█████▋│·······…` / `threshold marker · │ at 150.0k`, beside `USAGE · SESSION` with tokens in/out, cache read, session and week cost, turns, time in state, session age. |
| Active agents list | Name and elapsed time per running sub-agent | Yes | Rendered: `ACTIVE AGENTS (2)` / `⋔ Explore  00:00:42` / `⋔ forge-test-runner  00:00:09`. The budget charges `2 + n` rows for it (`Zoom.jsx:184`) and the panel fitted exactly. |
| Footer hint row | The five keys, one row | Yes | Rendered: `⌃Q exit  ·  ⌃J newline  ·  ⌃Y scroll  ·  ⌃K tools (on)  ·  ⌃U stats (on)        Esc · ⇧⇥ → claude`. |
| Panel shedding and the row budget | Never render more rows than `height`; shed todos first, then tools, then stats | Yes, at usable sizes | Rendered. With todos + tools + stats + sub-agents all open, the frame was exactly 45 rows against a 45-row budget, and the PTY body shrank to 9 rows (`L072`…`L080`). Swept `termRows` 20/24/30/40/50 × 0 and 3 toasts × four panel combinations: no overflow at 20 rows or above with no toasts. |
| **Never render more rows than `height` — at small sizes** | The stated contract (`Zoom.jsx:153-154`): "NEVER render more rows than `height`. Ink cannot erase a frame taller than the terminal" | **No** | Rendered sweep. Given 9 rows the modal draws 15 (over by 6). Given 7 it draws 15 (over by 8). Given 13 it draws 15 (over by 2). The floor is structural: 9 rows of chrome (`CHROME_ROWS`, `Zoom.jsx:168`) plus a PTY body that can never be smaller than 6. `Zoom.jsx:207` floors `bodyRows` at 5 and its comment says "the floor is PtyPane's own minimum (5)" — but PtyPane re-clamps to `PTY_MIN_ROWS = 6` (`tui/lib/zoomGeometry.js:56`, applied at `PtyPane.jsx:147`). **A hardcoded 5 standing in for a value that is 6.** So the real minimum frame is 15 rows, and any budget below 15 is overrun. |
| Consequence at the screen level | The overrun must not tear the screen | Partly — it does not tear, it eats the status bar | Rendered against a faithful reproduction of App's zoom wrapper (`App.jsx:2066-2085`) with stub feedback and status rows, not the real App. The wrapper's `overflow="hidden"` clips, so the whole-screen frame never exceeded the terminal at 12, 14, 16, 18, 20, 22, 24, 30 or 40 rows. But below 20 rows (below 22 with two toasts) the status bar is pushed off the bottom and disappears: at 18 rows the modal is given 13 and takes 15, and `STATUSBAR` is absent from the frame. |

---

## 6. Geometry — how the modal and claude's terminal are sized

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| `zoomModalWidth` | Terminal width minus App's padding, clamped to 40…220 | Yes | Computed: 80→76, 100→96, 120→116, 200→196, 260→220 (the cap). |
| `zoomInnerWidth` | Modal width minus 6 columns of border and padding | Yes | Computed: 76→70, 96→90, 116→110, 196→190, 220→214. Both the modal's own inner width (`Zoom.jsx:133`) and the PTY's column count come from this one function, which is what stopped the double-truncation of 0408/R3. |
| `zoomBodyDims` matches what the modal actually gives the pane | The PTY is sized once, to the biggest body this terminal can ever show; the modal's `bodyRows` must equal it when no panels are open | Yes | Computed and cross-checked: at 200×50, `zoomBodyDims` says 190×36 and the modal's `bodyRows` is `overlayHeight(50,0) − 9 = 36`. Matches at 24, 30, 40, 50 and 60 rows too. Confirmed in a render: at 200×50 the pane drew 36 rows with `skip` 0. |
| `ZOOM_CHROME_ROWS = 14` | Mirror the modal's 9 chrome rows plus App's 5 | Yes today, kept by hand | **Hardcoded value standing in for a measurement** (`tui/lib/zoomGeometry.js:41-49`). It is a comment-maintained sum of `Zoom.jsx`'s `CHROME_ROWS = 9` and `App.jsx`'s `overlayHeight` subtraction. I verified the three agree at six terminal sizes; nothing in the code or the tests enforces that they keep agreeing. |
| `PTY_MIN_COLS = 20`, `PTY_MIN_ROWS = 6` | One floor, imported by every layer that clamps | Yes | Computed: `clampPtyDims(0,0)` returns `{cols: 20, rows: 6}`. The comment records that these used to be 6 in two places and 5 in three; `Zoom.jsx:207` is the one place still carrying the old 5 (see the row-budget defect above). |
| `ZOOM_MODAL_MIN = 40` on a terminal narrower than 44 columns | It is meant to be a floor for degenerate terminals only | **No — it reintroduces 0408/R3 at a smaller size** | Rendered. At 30 columns the modal asks for 40 and the PTY body for 34, but the widest line Ink actually draws is 28. Claude's lines are wrapped at 34 by the emulator and then clipped again at 28 by Ink — the same double-truncation the 104-column floor used to cause, now triggered below 44 columns instead of below 108. Narrow, but real: at 36 columns the body is 34 and the drawn width 34, so 44 is roughly where it stops mattering. |
| PTY geometry fixed for an agent's whole life | Never resize on zoom enter/exit, toasts, or panel toggles — only on a real terminal resize | Yes | Test only for the no-resize assertion (`tests/zoom/ptyPane.geometry.test.jsx:91`, re-run green), plus the rendered evidence that the window follows the box without a resize. The settle delay before a real resize is applied is a hardcoded `VIEWPORT_SETTLE_MS = 250` (`App.jsx:124`) — **a hardcoded value standing in for a measurement**; the comment asserts it is below the noticeable threshold and nothing measures it. |

---

## 7. The shell overlay (`!`)

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| **Scroll the overlay shell's history** | `.claude/plans/overlay-terminal.md:76` specifies "a minimal chrome — only a close key … plus optional `Ctrl+Y` scroll". 5000 rows of scrollback are captured (`server/shellSession.mjs:34`) | **No — there is no scroll at all** | Traced. `tui/modals/ShellOverlay.jsx:188` reads `const startY = buf.viewportY;` with no offset, and there is no scroll state, no scroll keys and no hint row anywhere in the file. The code says so itself at `:185-188`: "TODO(shell-scroll): `buf.viewportY` is pinned to the live viewport; the TERM_SCROLLBACK rows in the buffer are inaccessible to the user." Run a command that prints more than a screenful and the top of its output is unreachable. |
| Keep-warm singleton shell | One PTY at module level, surviving overlay open/close | Unverified | Traced: `server/shellSession.mjs:49-51` caches `_session`; `:228` kills it on shutdown. I did not drive it — it spawns a real `$SHELL`. |
| Spawn safely | `$SHELL` as argv[0] with an empty args array, never a command string | Yes | Traced: `server/shellSession.mjs:47-60`. Matches the project rule against interpolating user-controlled values into shell strings. |
| `cd` to the focused card's directory on open | Only when the shell is at a fresh prompt | Partly | Traced: `server/shellSession.mjs:202-211` refuses unless `atFreshPrompt`. That flag comes from a prompt-shape guess — `PROMPT_RE = /[$%#>]\s*$/` at `:27` — which the file's own TODO says will produce false negatives on a custom or coloured prompt. **A hardcoded pattern standing in for a signal** (OSC 7 / OSC 133 would be the real one, and `:105-114` already reads OSC 133 when the shell emits it). |
| Degrade when the shell cannot spawn | Return a session with `pty: null` so the TUI does not crash and the overlay stays closable | Unverified | Traced: `server/shellSession.mjs:68-71`. Pinned by tests elsewhere (commit `f181282`) — not re-run here. |
| `Ctrl+Q` closes it, with a second handler as a backstop | So a half-unmounted overlay cannot trap the user | Unverified | Traced: `ShellOverlay.jsx:136` owns it; `App.jsx:1463` repeats it. Not driven. |
| Overlay height mirrors zoom's | Same `overlayHeight` clamp so the frame never runs past the last screen row | Yes | Computed: `App.jsx:2098` calls the same `overlayHeight(termRows, toasts.length)` as the zoom branch at `:2060`. |

---

## 8. Claims in `tui/zoom/CAPABILITIES.md` that no longer match the code

The file asks to be updated whenever `PtyPane.jsx` behaviour changes. Three of
its rows are contradicted by the code today. A fourth is not contradicted — it
is incomplete, and is listed last so the distinction is not lost.

| Claim | Reality | How I know |
| --- | --- | --- |
| "Bell (`\x07`) — ✗ Dropped. `term.onBell` fires but we don't forward." (`CAPABILITIES.md:21`) | It is forwarded, and gated to the zoomed agent | Traced: `server/ptyAgent.mjs:494-497` and `tui/zoom/PtyPane.jsx:260-264`. |
| "Clipboard (`OSC 52`) — ✗ Dropped. the sequence dies in xterm-headless." (`CAPABILITIES.md:24`) | It is forwarded, gated to the zoomed agent, and a clipboard *read* request is refused | Traced: `server/ptyAgent.mjs:479-487`, `tui/zoom/PtyPane.jsx:254-259`. |
| "Resize (SIGWINCH) — ✓ Forwarded … PtyPane's `useEffect([cols,rows])` which calls `pty.resize` + `term.resize`" (`CAPABILITIES.md:19`) | Only on the legacy path. For an agent-owned emulator PtyPane deliberately does **not** resize (0404) | Traced: `tui/zoom/PtyPane.jsx:343-346`, guarded on `termOwnedByAgentRef`. |
| "Alt-screen (`CSI ?1049h`) — ✓ Transparent … any full-screen claude UI Just Works" (`CAPABILITIES.md:16`) | **Incomplete, not contradicted.** True for drawing. Silent about scrolling, where it would not hold | Measured on the emulator only: the alternate buffer reports `baseY=0`, so the scroll ceiling collapses to zero. Whether claude ever switches to that buffer is **unverified** — see the scroll table. |

---

## Summary

Sixty-four features checked, plus four claims in `CAPABILITIES.md` in section 8.
Counted by verdict, so nothing is counted twice:

| Verdict | Count |
| --- | --- |
| **Works — verified** (rendered, driven, or fully traced) | 41 |
| **Test only** — a passing test is the only evidence; pins behaviour, not correctness | 4 |
| **Unverified** — not established, no guess offered | 7 |
| **Broken or materially incomplete** | 12 |
| Total | 64 |

Of the 12 in the last row, 10 answer "No" outright and 2 answer "Partly" — the
status bar disappearing below a 20-row terminal, and the shell overlay's
`cd`-on-open guessing at what a shell prompt looks like. One of the 12 (the
stub helper's paste recipe) is test infrastructure rather than product code.

The four **test-only** rows are: `Ctrl+Q` exit; the "everything else reaches
claude" routing; "never resize the agent's PTY when the box changes"; and "PTY
geometry fixed for an agent's whole life". All four are pinned by tests that
drive real bytes through Ink's real parser or check a stub's call log, which is
the right shape of test — but I did not watch any of them in a rendered frame,
so they pin behaviour, not correctness.

The seven **unverified** rows are: scroll inside a full-screen claude menu;
scroll after claude clears its saved lines; repaint throttling; the legacy
fallback spawn path; the keep-warm shell singleton; the shell's spawn-failure
degradation; and the shell overlay's close key. Nothing was guessed at in any
of them. The first two carry an emulator measurement that says what *would*
happen; neither asserts that claude does it.

### Broken, in the order that matters

1. **Scroll does not hold its place while claude is printing.** `tui/zoom/PtyPane.jsx:515`
   — `startY = buf.viewportY + skip - offset` measures the offset from the live
   viewport, which moves down one row for every row claude prints. Measured:
   parked 20 rows back at `L062 … L080`, after 20 lines of output the window is
   `L082 … L100` — the bottom — while the hint still reads `▲ SCROLL 20`. What
   is needed is an anchor that does not move when the emulator scrolls:
   `buf.baseY` is no help, because it advances with `viewportY` once scrollback
   is full. The offset has to be resolved to an absolute row number at the
   moment the user presses a scroll key and then held as a constant across
   renders, clamped back into `[0, buf.baseY + skip]` when the pinned row
   eventually falls out of the 5000-row scrollback. This is the strongest
   candidate for the user's report.

2. **The shell overlay has no scroll at all.** `tui/modals/ShellOverlay.jsx:185-188`
   — `startY = buf.viewportY` with no offset, no keys, no hint, and the file's
   own TODO says the 5000 captured rows "are inaccessible to the user". If the
   user's report is about the `!` overlay rather than zoom, this is the whole
   answer.

3. **The zoom modal crashes when the model is unknown and you press `Ctrl+U`.**
   `tui/modals/Zoom.jsx:426` calls `cells.map(...)`; `tui/modals/Zoom.jsx:142-144`
   sets `cells` to `null` whenever the model has no known context limit.
   Rendered: `Cannot read properties of null (reading 'map')`, and the frame
   goes from 45 rows to nothing. The 0409 unknown-model fix reached the compact
   line and stopped one panel short.

4. **The update-banner suppressor blanks the user's own prose.**
   `tui/zoom/claudeBanner.js:27` (`/\b(new|newer)\s+version\b/i`) and `:25-26`.
   Rendered: "we should ship the new version tomorrow" and "and then restart the
   worker to apply the config" both vanished from the body, and the second was
   reported to the header as a claude update notice. The cursor-row exemption at
   `tui/zoom/PtyPane.jsx:532` does not protect a wrapped line or claude's own text.

5. **The modal renders more rows than it is given, below a 15-row budget.**
   `tui/modals/Zoom.jsx:207` floors the body at 5 while `tui/lib/zoomGeometry.js:56`
   re-clamps it to 6, so the smallest possible frame is 9 + 6 = 15. Measured:
   given 9 it draws 15, given 7 it draws 15, given 13 it draws 15. The comment
   at `tui/modals/Zoom.jsx:205-207` states PtyPane's minimum as 5; it is 6.

6. **Below a 20-row terminal the zoom view pushes the status bar off the screen.**
   Consequence of 5. Measured against a faithful reproduction of the wrapper at
   `tui/App.jsx:2066-2085`: at 18 rows the modal is given 13, takes 15, and
   `STATUSBAR` is absent from the frame. With two toasts the threshold moves to
   22 rows.

7. **The expanded stats panel still prints a fabricated context limit.**
   `tui/modals/Zoom.jsx:422-423` — `/0` and `0%` for a model the catalog does not
   know, which is exactly what 0409 removed from the compact line at `:116-118`.
   Hidden behind defect 3 today; it surfaces the moment that crash is fixed.

8. **Entering scroll mode loses the top line of what you are reading.**
   `tui/zoom/PtyPane.jsx:156-157` charges the hint row against the same budget as
   the terminal rows, and the window is bottom-anchored. Measured: `L081…L100`
   becomes `L082…L100` on `Ctrl+Y` alone.

9. **Forward Delete deletes backwards.** `tui/zoom/ptyKeys.js:54` returns `7f`
   for both `key.delete` and `key.backspace`. Driven. Documented as an Ink 5
   limitation at `:50-51` and carrying its own TODO.

10. **On a terminal narrower than about 44 columns the modal is wider than the
    screen.** `tui/lib/zoomGeometry.js:34` (`ZOOM_MODAL_MIN = 40`). Rendered at 30
    columns: the PTY body is 34 columns, the drawn width is 28, so every claude
    line is wrapped once by the emulator and clipped again by Ink. Same defect
    class as the 104-column floor removed in 0408/R3, at a smaller size.

11. **The shell overlay's `cd`-on-open guesses at the shell prompt.**
    `server/shellSession.mjs:27` — `PROMPT_RE = /[$%#>]\s*$/`. A coloured or
    multi-line `PS1` fails the match, `atFreshPrompt` stays false, and
    `server/shellSession.mjs:203` silently refuses the `cd`. The same file
    already reads the real signal (OSC 133 marks, `:105-114`) when a shell
    emits it. Traced, not driven.

12. **The test helper's bracketed-paste recipe is a no-op.**
    `tests/lib/zoom-stub.js:26-27` tells authors to set
    `term.modes.bracketedPasteMode = true`, but `@xterm/headless` rebuilds the
    `modes` object on every access, so the assignment is discarded. Driven:
    `t.modes === t.modes` is `false`, and the flag stayed `false` after a direct
    assignment but flipped to `true` after `term.write('\x1b[?2004h')`. Test
    infrastructure, not product code — but it is exactly how a paste defect
    would get pinned backwards.

### Hardcoded values standing in for a measurement

- `ZOOM_CHROME_ROWS = 14` (`tui/lib/zoomGeometry.js:49`) — a comment-maintained
  sum of `Zoom.jsx`'s `CHROME_ROWS = 9` and `App.jsx`'s `overlayHeight`. Agrees
  at every size I checked; nothing enforces that it keeps agreeing.
- `CHROME_ROWS = 9`, `MIN_BODY_ROWS = 6`, `MAX_TODOS_CAP = 8`, `statsRows = 1 + 9 + (2 + n)`
  (`tui/modals/Zoom.jsx:168,169,184,195`) — all hand-counted against the JSX
  below them. The previous count said "stats = 7" while the panel drew 10.
- `bodyRows` floor of 5 (`tui/modals/Zoom.jsx:207`) — stale; the real floor is 6.
- `RENDER_INTERVAL_MS = 33` (`tui/zoom/PtyPane.jsx:62`) and
  `VIEWPORT_SETTLE_MS = 250` (`tui/App.jsx:124`) — both asserted in comments to
  sit below a perceptual threshold; neither is measured.
- `scrollback: 5000` duplicated in `tui/zoom/PtyPane.jsx:188` against
  `TERM_SCROLLBACK` in `server/ptyAgent.mjs:61` and `server/shellSession.mjs:34`.
- Truncation widths 24 and tool cap 8 (`tui/modals/Zoom.jsx:226,399,402`).
- `PROMPT_RE = /[$%#>]\s*$/` (`server/shellSession.mjs:27`) — a guess at what a
  shell prompt looks like, standing in for the OSC 133 signal the same file
  already reads when a shell provides it.
- "Measured on a real session at 40 rows: 9 trailing blanks"
  (`tui/zoom/PtyPane.jsx:487-488`) — a real measurement, recorded only as a
  comment, with nothing re-checking it against a current claude.

### Not drawn by Mission Control

The diff panel the user sees inside zoom is claude's own output, rendered
cell-for-cell out of the emulator. Mission Control has no diff renderer in this
area, so nothing in this register covers it.
