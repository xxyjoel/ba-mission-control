# Feature register — the fleet view and its cards

Area: `tui/App.jsx` (grid rendering only), `tui/Card.jsx`, `tui/Header.jsx`,
`tui/Aggregate.jsx`, `tui/StatusBar.jsx`, `tui/FleetLog.jsx`,
`tui/lib/gridLayout.js`, `tui/lib/format.js`, `tui/lib/themes.js`,
`tui/lib/projectHealth.js`.

Written 2026-09-19.

## How to read the "Does it?" column

Every screen value has two hops: the **source hop** (does the right number
reach the component) and the **display hop** (does the component draw it
correctly). A row says which hop the evidence covers.

| Word | Meaning |
| --- | --- |
| **Yes** | Both hops checked. I rendered it and I traced the value to where it is set. |
| **Display only** | I rendered it and the drawing is right. I did not confirm the number reaching it is true. |
| **Partly** | Does some of what it claims. The gap is named. |
| **No** | Broken. It does not do what it says. |
| **Unverified** | I did not check. No guess offered. |

Everything marked "rendered" was produced by mounting the real component
against a terminal of an exact size (`tests/lib/render-size.js`) and reading
the frame back. Frames are quoted verbatim.

No unit test is counted as proof on its own. Where a test is the only
evidence the row says "test only — pins behaviour, not correctness".

---

## 1. The grid and its layout

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Card grid | Lay live cards out in rows of `gridCols`, empty slots hidden | Yes | Traced: `tui/App.jsx:1884` filters `status !== 'empty'`; `:1902` chunks into rows; `:2143-2159` renders each. Each child gets an explicit `width={cardW}` at `:2144`, matching the project's Ink layout rule. |
| Column auto-reduce | Drop to fewer columns rather than let cards spill past the right edge | Yes | Ran `computeGridLayout` directly. At 100 columns with `gridCols: 5` it returns `effectiveCols: 4, cardW: 24`. At 60 columns with `gridCols: 2` it returns `effectiveCols: 2, cardW: 29`. `tui/lib/gridLayout.js:74-76`. |
| Minimum card width | Never draw a card narrower than 20 columns | Yes, and that is the problem | `MIN_CARD_W = 20` at `tui/lib/gridLayout.js:16`. It is a floor, not a guard — see the narrow-card row in section 2. |
| Pagination into panes | At most `windowsPerPane` cards per pane; overflow pages instead of clipping | Yes | Ran it. 10 cards, `windowsPerPane: 9`, 180x50 terminal → `perPage: 9, pageCount: 2, rowsInPage: 2`. With `windowsPerPane: 0` on 200x60 → `perPage: 15, pageCount: 1`. `tui/lib/gridLayout.js:86-93`. |
| Active pane follows focus | The pane shown is the one holding the focused card | Display only | Traced: `focusedIndex` at `tui/App.jsx:1890` feeds `pageIndex = clamp(floor(fIdx / perPage), …)` at `gridLayout.js:91`. Ran the function with varying `focusedIndex` and the page index moved as expected. I did not drive the real keyboard. |
| Vertical row budget | Reserve chrome (header, aggregate, toast strip, status bar, log) so the frame never exceeds the terminal height | Yes, in the cases I checked | Replayed the arithmetic for six terminal sizes against the render conditions in `App.jsx`. 80x24 → exactly 24 rows used. 120x24 → exactly 24. 60x20 → exactly 20. 180x50 → 44 of 50. None overflowed. This is arithmetic replay, not a full-app render. |
| Toast strip reserved at worst case | Budget 5 rows (header + 4 toasts) so the layout does not shift when toasts arrive | Yes | `FEEDBACK_H = 1 + MAX_TOAST_ROWS` at `gridLayout.js:35`, `MAX_TOAST_ROWS = 4` at `:22`. The constant is exported so the strip and the budget cannot drift. |
| Fleet-log clamp | Give the log exactly the Settings line count, less only when the terminal is too short | Yes | Ran it. 180x50 with setting 12 → `dynamicFleetLogLines: 12`. 80x24 with setting 8 → `3`. 60x20 with setting 8 → `0`. `gridLayout.js:111`. No floor, so a short terminal drops the log entirely — `App.jsx:2186` then omits the header row too. |
| Non-TTY fallback | A stdout with no rows/columns must not poison the maths | Yes | Ran `computeGridLayout` with both dimensions `undefined`. Returns `{effectiveCols: 5, cardW: 35, perPage: 9, pageCount: 2, dynamicFleetLogLines: 12}` — the 180x50 fallback at `gridLayout.js:66-67`, no `NaN`. |
| Pager strip | Show `pane 2/3 · [ ] to switch` only when more than one pane exists | Display unverified | Traced: `App.jsx:2161-2175`, gated on `pageCount > 1`. The strings are literals. I did not render `App.jsx` itself — it needs a live Fleet. |
| Card height constant typed twice | `CARD_H` and Card's own `height` must agree | Yes today, unguarded | `CARD_H = 11` at `gridLayout.js:15` with the comment "must match Card.jsx height={11}"; `height={11}` at `Card.jsx:95` and `:310`. Three hand-typed copies of one number, bound only by a comment. Nothing fails if one changes. |
| Empty-state panel | "no sessions running" plus launch hints when nothing is live | Display unverified | Traced: `App.jsx:2124-2139`. Literal strings, no data. Not rendered. |
| **Filter dimming** | Dim cards that do not match an active `/` filter; do not reflow the grid | Partly — the cards that most need dimming do not dim | Rendered, keeping the colour codes. `App.jsx:2154` overrides only `fg`, `accent`, `cyan` and `white`. Passing that exact override into `Card` and comparing the raw frames: a **working** card dims (border cyan → grey, status word likewise), and an **idle** card is already grey. A **waiting** card's yellow border and yellow status word are byte-identical dimmed and undimmed, and so are an **errored** card's red ones. Those colours come from `theme.yellow` / `theme.red` (`Card.jsx:35-41`, `:69-78`), which are not in the override list. So a filter dims the quiet cards and leaves the loud ones at full strength. |

---

## 2. The card — shape and title row

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Fixed card height | Every card is exactly 11 terminal rows, whatever the content | Yes | Rendered at nine widths from 20 to 56 columns. Every frame came back as exactly 11 lines. |
| Card content at normal width | Rows sit on one line each, nothing wraps | Yes, at 38 columns and wider | Rendered at 56: `tok/min 3.2k  ▂▃▅▃▇█▄▆▆▃▅█▃▄                    37% 182M` — one clean line, labels intact. |
| **Card content at narrow width** | Same, at any width the grid can produce | **No** | Rendered. At `cardWidth` 30 the tok/min row loses its trailing space and splits across two lines: `tok/mi3.2k ▂▃▅▃▇█▄▆▆▃▅█37%` then `▄           182M`. At 24 the context percentage is pushed onto its own line and the label reads `tok/m3.2k`. At 20, four rows are mangled: `4.8`, `ct█········· 142.0k`, `tok/3.2▂▃▅▃▇█▄▆37%`, `in     ▃▅█▃▄   182M` — the word "tok/min" is split across two rows. The card keeps its 11-line height, so it eats the flex spacer instead of overflowing. Reachable: a 100-column terminal with the default `gridCols: 5` produces `cardW: 24` (measured). Cause: only the name and branch are width-budgeted (`Card.jsx:291-301`); the context, tok/min and CPU rows are not. |
| Slot tag `[N]` | Show the slot number, bright when focused | Display only | Rendered: `│ [3] ba-mission-control                   ● WORKING · 14% │`. `Card.jsx:320`. Source is `agent.slot`, set by the Fleet; not traced further. |
| Session name | Show the session name, truncated to fit on one line | Yes | Rendered at 56 (`ba-mission-control`) and at 30 (`ba-mi…`). The budget at `Card.jsx:297` subtracts the slot tag, the status tag, the background chip and the stuck chip, so the name shrinks as those grow. |
| Status word | One of the six states, upper-cased | Display only | Rendered all six: `● WORKING`, `◉ INPUT?`, `○ IDLE`, `⏸ PAUSED`, `✕ ERROR`, and `EMPTY` on the empty tile. The six words and glyphs are hand-typed at `Card.jsx:33` and `:146-149`, mirroring the enum in `server/agent.mjs`. An unknown seventh state degrades safely: glyph falls back to `·`, word to the upper-cased string. |
| Status glyph | A distinct mark per state, repeated beside the time-in-state | Yes | Rendered. The same glyph appears top-right and bottom-right on every frame — `● WORKING` … `●3m`, `⏸ PAUSED` … `⏸3m`. `Card.jsx:149`, `:433`. |
| Approval override | A `waiting` card with a pending permission prompt says `APPROVE?` in red | Yes | Rendered with `tail: [{awaitingPrompt:{kind:'approval'}}]`: `◉ APPROVE? · 14%` and the triage row reads `needs approval · answer to proceed`. `Card.jsx:44-56`, `:146`. |
| Context-pressure chip | Append `· NN%` to the status when near or over the threshold | Yes | Rendered with `threshold: 160000` and `warnPct: 85`. At 142k of 1M the chip shows `· 14%` (the warn band is measured against the threshold, not the window, so it fires early); at 900k it shows `· 90%`. `Card.jsx:139-140`, `:328-330`. |
| `STUCK Nm` chip | A red chip when the server has flagged the slot silent past its threshold | Display only | Rendered with `stuckMin: 9`: `✕ ERROR · 14% · STUCK 9m`. `Card.jsx:331-335`. The minute count comes from the server (`server/ptyAgent.mjs:1285-1291`); I did not verify the clock behind it. |
| **Background chip, liveness** | Show background work whenever the server says it is live | Yes | Rendered with `bgStatus: 'working', bgCount: null`: `○ IDLE · ?bg WORKING · 14%`. The chip reads liveness and count separately (`Card.jsx:168-172`), so "live, count unknown" prints `?bg` rather than inventing a number. |
| **Background chip, count** | Print a real tally, never a stand-in | Yes | Rendered with `bgCount: 3`: `○ IDLE · 3bg WORKING · 14%`. Traced to source: `server/ptyAgent.mjs:1241-1260` counts live sub-agent files and sets `bgCount = null` (not `1`) when only a hook clock says work is live. The literal-`1` defect this app was reported for is fixed on both hops. |
| Background chip suppressed under approval | Do not share the title row with an approval prompt | Yes | `Card.jsx:170` gates on `!approval`. Rendered the approval case: no background chip on the row even though the agent object carried one. |

---

## 3. The card — model, branch and git

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Model label | Show the model claude is currently on, not the one it launched with | Yes | Rendered: `OPUS 4.8` for `resolvedModel: 'claude-opus-4-8'`. `Card.jsx:126-128` prefers the resolved catalogue entry over the launch model, and `server/ptyAgent.mjs:1314` ships `resolvedModel` from the stream. |
| Model label on an unknown model | Show the sanitised model id rather than a bare dash | Yes | Rendered with `resolvedModel: 'claude-opus-9-9-20270101'`: the row reads `claude-opus-9-9-2…  ⎇ feat/fleet-register`. `Card.jsx:180-182` routes it through the escape stripper then truncates to 18. |
| Model colour | Colour the label by model family | Unverified | `modelColor(modelId, theme)` at `Card.jsx:183`. Colour is stripped from my captured frames, so I saw the text, not the colour. Not traced into `tui/lib/models.js`. |
| Model catalogue | Model facts (label, context window, prices) come from a live source, not hand-typing | Partly | Read `tui/lib/models.js:66-74`: eight models are hand-typed with label, `maxCtx` and four price fields each. The file says new models are discovered through `tui/lib/modelProbe.js` and flagged `estimatedPricing`, but the eight in the table, and `fable-5.1` explicitly, are typed. `maxCtx` is the denominator for every context percentage on every card. Read only; I did not run the probe. |
| Branch name | Show the session's git branch, truncated to fit | Yes | Rendered: `⎇ feat/fleet-register` at 56 columns, `⎇ feat…` at 30. Budget at `Card.jsx:301` subtracts the model label and the git chips. |
| **Git clean marker** | A green dot means the working tree is clean | **No** | Rendered, then traced. With `dirty: 0` the meta row draws `OPUS 4.8  ⎇ feat/fleet-register` and a right-aligned `●`, and the row's colour codes contain green (`Card.jsx:336-338`). With `branch: null, dirty: 0` — the shape a non-repo directory produces — it renders `OPUS 4.8  ⎇ —` with the same green dot. Source: `server/git.mjs:43-48` returns `0` when git fails, times out or is missing from PATH **and** when the tree is genuinely clean; `:65` returns `dirty: 0` for a directory that is not a repository. Three different situations, one green dot. |
| Dirty count `+N` | Number of changed files | Display only | Rendered: `+4 ↑2 ↓1`. `Card.jsx:338`. Source is one `git status --porcelain` line count (`server/git.mjs:43-48`); I did not run it. |
| **Ahead / behind markers** | Show commits ahead of and behind upstream | Partly | Rendered: `↑2 ↓1`, hidden when zero (`Card.jsx:339-340`). But `server/git.mjs:57-59` returns `{ahead: 0, behind: 0}` when the rev-list call fails or the output does not parse. A branch with no upstream and a branch perfectly in sync render identically — both show nothing. |

---

## 4. The card — context, throughput and process

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Context token count | Show the live main-thread token count | Display only | Rendered: `ctx █·│··········· 142.0k 14%`. `Card.jsx:368`. Source is the connector; not traced. |
| Context bar | 14 cells filled in proportion to the window used | Yes | Rendered at 142k of 1M: `█·│···········` (one full cell). At 900k of 1M: `██│█████████▋·`. `Card.jsx:190-192`. |
| Context threshold marker | A `│` at the warning threshold's position on the bar | Yes | Rendered. With `threshold: 160000` against a 1M window the marker sits in cell 2: `█·│···········`. `Card.jsx:191`, drawn by `format.js:75-77`. |
| **Context bar when the window size is unknown** | Say so, do not draw an empty bar | Yes | Rendered with a model outside the catalogue: the whole row becomes `ctx limit ? 142.0k ?%`. The bar is suppressed, the percentage is `?`, and the measured token count stays. `Card.jsx:134-136`, `:192`, `:360-368`. This is the pattern the rest of the card should follow. |
| Context percentage | Percent of the model's window in use | Yes | Rendered. `14%` at 142k of 1M, `90%` at 900k, `?%` on an unknown model. |
| tok/min number | The true last-sample rate while working, 0 otherwise | Yes, by design | Rendered. Working with `lastTokRate: 3210` → `tok/min 3.2k`. The same agent set to `idle`, `paused`, `waiting` or `error` → `tok/min 0`, even with the rate still on the object. `Card.jsx:205`. |
| tok/min freshness | Reflect current throughput | **Partly — known stale** | `Card.jsx:203-204` carries its own note: the rate freezes at the last sample, so a long-running Bash tool with no token flow keeps showing the last rate while the card still says working. The note asks for decay by elapsed time; it is not implemented. Read, not rendered — a frozen value renders identically to a live one. |
| Sparkline | Fourteen history bars; blank at zero throughput | Yes | Rendered. `spark: [1,3,5,…]` → `▂▃▅▃▇█▄▆▆▃▅█▃▄`. `spark: [0,0,0,0]` → nothing at all. `format.js:83-91` returns `''` when every sample is zero. |
| Sparkline on an idle card | — | Works as built, reads oddly | Rendered an idle card with history still in the array: `tok/min 0  ▂▃▅▃▇█▄▆▆▃▅█▃▄`. The bars are decorative history (`Card.jsx:196`), so a resting card still shows a wall of activity beside a zero rate. Not a wrong number; it is a confusing pairing. |
| CPU percentage | The claude subprocess's share of one core | Display only | Rendered: `37% 182M`. `Card.jsx:379`. Source is one shared `ps` sample per fleet tick (`server/fleet.mjs:103-124`); I did not run it. |
| Memory | The claude subprocess's resident memory | Display only | Rendered: `182M` from `procMemKb: 186000`. Checked `fmtMem` directly: `186000 → "182M"`, `2100000 → "2.0G"`, `500 → "0M"`. |
| CPU/memory hidden before first sample | Do not show `0% 0M` before `ps` has run | Partly | `Card.jsx:378` gates the whole readout on `procMemKb > 0`. But the gate is on **memory**, so if memory sampled and CPU did not, `Math.round(agent.procCpu || 0)` prints a confident `0%`. Rendered with `procCpu: undefined, procMemKb: 186000` → `0% 182M`. |

---

## 5. The card — triage row and current item

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Todo burndown `N/M` | Completed over total from the session's live checklist | Yes | Rendered with 7 todos, 3 completed: `▸ 3/7 ███▍···· check back`. `Card.jsx:214-215`, `:395-403`. |
| Burndown bar | Eight cells filled by proportion done | Yes | Rendered. 3 of 7 → `███▍····`. All 7 → `████████` in green. |
| Burndown shown only when useful | Bar for working/idle-with-a-plan; a full-width imperative otherwise | Yes | Rendered all branches. `waiting` → `▸ needs input · answer to continue` (no bar). `paused` → `▸ paused`. `error` → `▸ errored · see log`. `Card.jsx:254`. |
| Next-action verb | A short imperative matching the card's whole truth | Yes | Rendered every branch: `check back` (working with a plan), `ready to review →` (idle, all done), `needs a nudge →` (idle, plan unfinished), `needs input · answer to continue` (waiting), `needs approval · answer to proceed` (approval), `errored · see log`, `paused`. All seven strings are literals at `Card.jsx:255-282`. |
| Verb agrees with the background chip | An idle card with live background work must not say "needs a nudge" | Yes | Rendered `status: 'idle', bgStatus: 'working'` → the row reads `check back`, not `needs a nudge →`. `Card.jsx:263-272` reads the same liveness flag the chip reads, so the two cannot disagree. |
| Blank triage row | Say nothing rather than restate the status | Yes | Rendered an idle card with no todos: the `▸` marker is absent and the row is blank, but the line is kept so the card height holds. `Card.jsx:393`. |
| Current item | The in-progress todo's active description | Yes | Rendered: `↳ Wiring the adapter` from `activeForm: 'Wiring the adapter'`. With nothing in progress: `↳ —`. `Card.jsx:216-219`, `:416-423`. |
| Current item is sanitised | Strip terminal escapes before the text reaches the terminal | Display verified for the plain case only | The sanitiser runs before truncation at `Card.jsx:218`. I rendered normal text, not hostile text. The stripper itself I verified separately (section 9). |
| Sub-agent indicator | When parallel sub-agents are in flight, show them instead of the todo | Yes | Rendered with three entries: `↳ ⋔3 agents running`. `Card.jsx:228-231`, `:420`. With one entry the row shows that agent's label instead. |

---

## 6. The card — vitals and foot

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Health dot score | Show the latest session-health composite for the project | Yes — traced end to end | Wrote a real `.project-health/history.jsonl` with two readings, pointed a card's `cwd` at it, rendered. `readProjectHealth` returned `{score: 78.4, verdictWord: "HEALTHY", arrow: "↑"}` and the card row came back as `│ ●78↑  ⟳12  340✉  ⧗2h13m                              ●3m │`. |
| Health trend arrow | Up, down or flat, only once two readings exist | Yes | Same run. Two readings 71.2 → 78.4 gave `↑`. `projectHealth.js:79-84` leaves the arrow empty with one reading, so `·` means "measured and flat", never "we have no second reading". |
| **Health score when unmeasured** | Print `?`, not a zero | Yes | Rewrote the file with a reading carrying no composite. Reading came back `{score: null, arrow: ""}` and the card rendered `│ ●?  ⟳12 …`. `projectHealth.js:73-75`, `healthScoreText` at `:120`. |
| Health colour | Green healthy, cyan stable, red degraded, neutral when unmeasured | Yes | Called `healthColor` directly. The two-reading file returned `green`. The no-composite file falls through the verdict words to `Number.isFinite(score)` and returns `dim`. `projectHealth.js:102-116`. |
| Health dot omitted with no file | No dot at all until the project has a scored turn | Yes | Rendered every other card in this register against a cwd with no health file. No dot appears on any of those frames. `Card.jsx:425`. |
| Health caching | Re-read cheaply on every fleet tick | Display unverified | Read `projectHealth.js:16-17, 44-52`: a 2.5-second TTL plus an mtime check, tailing the last 16 KB rather than the whole file. I exercised the cache-reset helper but did not measure read cost. |
| **Turn count** | Count of user → claude round trips | Partly — a missing count reads as zero | Rendered: `⟳12`. But `Card.jsx:431` is `⟳{agent.turnCount || 0}`. Rendered with the field absent: `⟳0`. A live agent always stamps it (`server/ptyAgent.mjs:1339`), so this only bites on a snapshot that lost the field — but nothing on screen would say so. |
| **Message count** | Count of assistant messages | Partly — same | Rendered `340✉`; with the field absent, `0✉`. `Card.jsx:432`. |
| Message count hidden on narrow cards | Drop it before the row can wrap | Yes | Rendered. At `cardWidth: 30` (inner width 26) the vitals row is `⟳12` alone. At 56 it is `⟳12  340✉  ⧗2h14m`. `Card.jsx:432` gates at inner width 30, `:433` at 40. |
| **Session age** | How long this session has been alive | Yes | Rendered: `⧗2h14m`. Rendered with `spawnedAt` absent: `⧗?`, not `0s`. `Card.jsx:240`. |
| **Time in current state** | How long the card has held its status | Yes | Rendered: `●3m`. With `stateSince` absent: `●?`. `Card.jsx:241`. |
| Duration formatting edge cases | — | Partly | Called `fmtDurShort` directly: `null → "0s"`, `NaN → "0s"`, `-1000 → "0s"`. The card guards on the field being **present**, not on it being a number, so a corrupt truthy timestamp would render `0s` rather than `?`. `format.js:266-273`. |
| **Session cost** | The billed session cost | Partly — a missing cost reads as `$0.00` | Rendered `$0.42 ses`; with the field absent, `$0.00 ses`. `Card.jsx:453`. `fmtMoney(null)` returns `"$0.00"` (checked directly), so "no cost data" and "cost is zero" are the same string. |
| Estimated-pricing marker | A `~` when the cost was priced from an inherited rate | Yes | Rendered a `fable-5.1` card: `~$0.42 ses`. A catalogue-priced model shows no tilde. `Card.jsx:453`. |
| Estimated marker uses the shared constant | One spelling of the marker across the app | **No** | `format.js:30` exports `ESTIMATED = '~'` specifically so the spelling cannot drift. `Card.jsx:453` and `tui/modals/Zoom.jsx:236` both hard-code `'~'` instead. The constant has no callers. |
| **Tokens in / out** | Cumulative session tokens | Partly — missing reads as zero | Rendered `38.0k↓ 9.4k↑`; with the fields absent, `0↓ 0↑`. `Card.jsx:455`. |
| Border colour by state | Focus wins, then approval, then error, then over-context, then waiting, then near-context, then working | Yes, for the branches I drove | Rendered with the colour codes kept. Below the warning band: working → cyan, waiting → yellow, error → red, idle → grey. With the context inside the warning band, a working card's border turns yellow, confirming near-context outranks working. `Card.jsx:69-78`. I did not drive the focused or approval branches. |
| Border style setting | rounded / sharp / double, bold when focused | Display only | Rendered with `borderStyle: 'rounded'` → `╭──╮`. `Card.jsx:59-64` maps the three names to Ink presets. I did not render the other two. |
| Empty-slot tile | Offer "+ NEW SESSION" with the keys to press | Yes, but unreachable from the fleet view | Rendered it directly: `[7] EMPTY`, `+ NEW SESSION`, `press n or ↵`, `slot [7]`. `Card.jsx:87-113`. The fleet grid filters every empty slot out at `App.jsx:1884`, and `Card` has exactly one call site (`App.jsx:2146`). So this branch cannot appear in the fleet view. |
| **`showTools` prop** | Settings says: "Card tail: show tool events. Off (default): cards show user/asst/note only." | **No — the setting does nothing** | `Card.jsx:83` accepts `showTools` and the body never reads it; the card's own note at `:80-82` says the tail it gated was removed. `App.jsx:2153` still passes `settings.cardShowTools`. The setting is offered to the user at `tui/lib/settings.js:133` with a description of behaviour that no longer exists. |

---

## 7. Header

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Product name and version | Show the running version, nothing if unknown | Yes | Rendered: `▶ claude-mission-control v1.1.14 │ …`. Rendered with no version prop: `▶ claude-mission-control  │ …` — blank, not a stale number. `Header.jsx:24`. Source is `package.json` via `tui/lib/version.js:13-20`, falling back to the string `unknown`. |
| Live session count | Number of non-empty slots | Yes | Rendered six agents of which one is empty: `█ 5 sessions`. `Header.jsx:27`. |
| Per-state counts | work / wait / paused / idle / err | Yes | Rendered a fleet with one of each: `work 1 │ wait 1 │ paused 1 │ idle 1 │ err 1`. `Header.jsx:28-33`. |
| API-retrying chip | Count sessions that hit a transient API error in the last 5 minutes | Yes | Rendered with `lastApiErrorTs` one minute old: `api ⚠1 retrying`. Absent when no agent carries one. `Header.jsx:37-39`. The 5-minute window is a literal at `:37`. |
| Over-threshold count | How many live sessions exceed the context threshold | Yes | Rendered: `over 160.0k 1/5`. `Header.jsx:35`, `:81-83`. The threshold comes from the user's setting (`App.jsx:587` reads `settings.ctxThreshold`), not a literal. |
| Aggregate status pill | NOMINAL / AWAITING / DEGRADED | Yes | Rendered a fleet with one errored agent: `status DEGRADED`. `Header.jsx:40`. Note it ignores `paused` and `stuck` entirely — a fleet of stuck sessions still reads NOMINAL. |
| Auth chip | Who is signed in, and the plan | Display only | Rendered: `◆ joel@example.com · Max`. Rendered with no auth object: the segment is absent. `Header.jsx:91-103`. I passed the object by hand; the live probe is not in my area. |
| Session timer | How long this Mission Control process has been up | Display only | Rendered: `session 01:22:03`. `App.jsx:606` computes it from `snapshot.sessionStart`. Not traced further. |
| Clock | Current time, honouring the 24-hour setting | Yes for the setting, always UTC | Rendered: `UTC 12:34:56`. `App.jsx:607` passes `settings.clock24` into `fmtClock`. The label says UTC and `format.js:161-168` does use UTC in both modes, so the label is honest. |
| **Header clipping** | README says the header shows the per-state counts "plus the over-context-threshold count and an aggregate NOMINAL / AWAITING / DEGRADED pill" | **No, below 122 columns** | Swept terminal widths from 60 to 240 in steps of 2. With an auth chip present, the status pill first becomes visible at **122 columns** and the UTC clock at **182 columns**. With no auth chip, the clock needs **154**. Below those widths the segments are silently clipped — `Header.jsx:45` sets `flexWrap="nowrap" overflow="hidden"` and every segment is `flexShrink={0}`, so overflow falls off the right edge with no indication. At 100 columns the frame ends mid-word: `… │ err 1 │ api`. |

---

## 8. Aggregate bar, status bar and fleet log

### Aggregate

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Fleet tokens in / out | Sum across live sessions | Yes | Rendered five live agents at 38000 / 9400 each: `tok·in 190.0k↓ │ tok·out 47.0k↑`. `Aggregate.jsx:34-35`. Each term is `(a.tokensIn \|\| 0)`, so a missing part is silently counted as zero with no marker on the total. |
| Fleet session cost | Sum of per-session costs | Yes | Rendered five agents at $0.42: `cost·session $2.10`. `Aggregate.jsx:36`. |
| Weekly cost | The authoritative fleet total, not a per-card sum | Yes | Rendered: `cost·week $212.50/$250`. `Aggregate.jsx:40` uses the passed-in total from the cost store (`App.jsx:181`), with a note at `:37-39` explaining that summing per-agent weekly cost gave N times the real spend. |
| **Weekly budget cap** | The denominator the bar is drawn against | Works, but hard-coded | `WEEK_CAP = 250` at `Aggregate.jsx:10`, with the file's own note "matches the design — should be a setting later". Rendered: `/$250`. A `dailyBudgetUSD` setting exists (`tui/lib/settings.js:148`) and does not feed this. Every user sees $250. |
| Weekly budget bar | 24 cells showing spend against the cap | Yes, saturates silently | Rendered at $212.50: `[████████████████████▍···]`. Rendered at $900 — nearly four times the cap: `[████████████████████████]`, a full bar with no over-cap marker. The printed number `$900.00/$250` is the only signal. `Aggregate.jsx:41-42`. |
| Plan usage cells | claude's own 5-hour and 7-day quota percentages | Display only | Rendered: `plan 5h 63%↻2h  · 7d 91%↻2h`. `Aggregate.jsx:73-81`. Source is claude's `~/.claude/abtop-rate-limits.json` (`tui/lib/usage.js:26-40`) — a real file, read on an 8-second poll. Note `usage.js:38` coerces a missing percentage with `\|\| 0`, so an unreadable quota would render as a confident `0%`. |
| Plan cells omitted when absent | Skip the cell when claude has not written the file | Yes | Rendered with no usage object: the plan cell is absent entirely. `Aggregate.jsx:72`. |
| Reset times | When each quota window resets | Display only | Rendered `↻2h` from a stub formatter. The `\|\| '?'` fallback at `Aggregate.jsx:77` is the house unknown marker. |
| Fleet tok/min | Sum of each working agent's last-sample rate | Display only | Rendered: `fleet 5.4k t/min`. `App.jsx:602` sums `lastTokRate` across working agents only. Rendered with zero: `fleet 0 t/min`. |
| Fleet sparkline | 22 samples of aggregate throughput | Yes | Rendered: `▂▄▃▇█▃`. Rendered with an empty array: nothing. `Aggregate.jsx:43`. `App.jsx:167` seeds the array with zeros rather than ones, so an idle fleet draws a blank sparkline, not a full block. |

### Status bar

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Mode chip | Name the current mode | Yes | Rendered: `─ NORMAL ─` and, in command mode, `─ : ─`. Six modes listed at `StatusBar.jsx:26-33`. |
| Focused slot and name | Show which card has focus | Yes | Rendered: `[3] ba-mission-control`. Rendered with no focus: `[-] empty`. `StatusBar.jsx:105-108`. |
| Filter chip | Show an active filter even when not typing | Yes | Rendered: `filter /mission (/ to clear)`. `StatusBar.jsx:131-136`. |
| Command buffer and caret | Show what is being typed, end of buffer nearest the caret | Yes | Rendered: `─ : ─   [-] empty  ::model refresh█  ↵ run · esc cancel`. (The doubled colon is my test input, which included its own colon — the app stores the buffer without one.) `StatusBar.jsx:120-128`. |
| Caret blink only while typing | No idle repaints | Yes | `StatusBar.jsx:40-49`: the interval is created only when enabled and torn down otherwise. Read, not measured. |
| Hints hidden while typing | Free the width for the buffer | Yes | Rendered both. In normal mode the row ends `← ↑ ↓ → move  ↵ open  n new  b bcast  esc settings`; in command mode those are gone. `StatusBar.jsx:148-153`. |
| One-row clamp | The bar can never grow and push the frame off-screen | Yes | Rendered at 100 and 200 columns; always exactly one line. At 100 columns the hints truncate mid-word rather than wrapping: `… b bcas← ↑ ↓ → move  ↵ open  n new  b b…`. `StatusBar.jsx:72`. |
| "NOT SAVING" chip | Warn when the session store is read-only | Display unverified | `StatusBar.jsx:75-81`, gated on `isStoreReadOnly()`. I did not force that state. |
| "DEV · SANDBOXED" chip | Warn when running against a sandboxed config directory | Display unverified | `StatusBar.jsx:83-89`. Computed once at import from the environment (`:15`), so it cannot change mid-process. Not forced. |
| "● REC keys" chip | Show when key recording is on, and appear immediately | Display unverified | `StatusBar.jsx:90-96` with a subscription at `:20-24` so the chip flips live. Not forced. |

### Fleet log

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| Merge all agents' tails | One chronological stream across the fleet | Yes | Ran `deriveFleetLog` over two agents with six entries between them. Output: 6 rows, and the rendered frame interleaves them by time — slot 4's entry sits between two of slot 3's. `FleetLog.jsx:45-64`. |
| Stable ordering | Equal timestamps must not reshuffle between frames | Yes | `FleetLog.jsx:62` sorts by timestamp then by an explicit insertion sequence. Read; the rendered order matched the timestamps I set. |
| Row prefix | clock, slot, name, glyph | Yes | Rendered: `16:55:56 [ 3] ba-mission-control   ▸ Bash git status --porcelain`. `FleetLog.jsx:136-143`. |
| Name column alignment | Fixed 20 cells so a wide name cannot shift the columns | Yes | Rendered a 39-character name: `[ 4] a-very-long-project- ▸ Grep …` — cut at exactly 20, columns still aligned. `FleetLog.jsx:131`. Checked `padCol` directly on a CJK string: `"項目管理システム"` padded to 20 cells, measured in terminal cells not characters. |
| Kind glyphs | A distinct mark per event kind | Yes | Rendered all five: `▸` tool, `●` assistant, `✕` error, `›` user, `⌘` broadcast. `FleetLog.jsx:19-25`. |
| Tool name prefix | Show the tool for tool and error rows | Yes | Rendered: `▸ Bash git status…` and `✕ Read ENOENT: no such file`. `FleetLog.jsx:146-147`. |
| Event count in the header | Say how many events are shown | Yes, with a caveat | Rendered: `▸ FLEET LOG · 6 events`. The number is rows **drawn**, not events available — with the budget set to 3 the header said `3 events` while 6 existed. The adjacent tag explains it (below). |
| "history" tag | Say when fewer events exist than the log is allowed to draw | Yes | Rendered with 6 events and a 32-line setting: `▸ FLEET LOG · 6 events · 6/32 history`. `FleetLog.jsx:91`, `:114-115`. |
| "height" tag | Say when the terminal cannot give the log its setting | Yes | Rendered with budget 3 and setting 12: `▸ FLEET LOG · 3 events · 3/12 height`. `FleetLog.jsx:92`, `:116-117`. |
| Narrative mode | Assistant text, errors and broadcasts only | Yes | Ran `deriveFleetLog` in both modes on the same input: `all` → `tool,tool,asst,err,user,bcast`; `narrative` → `asst,err,bcast`. Rendered: `▸ FLEET LOG · 3 events · 3/6 history · narrative`. `FleetLog.jsx:39`, `:51-54`. |
| Respect the caller's row budget | Draw exactly the rows allocated, never more | Yes | Rendered with `maxLines: 3` against 6 available events → exactly 3 rows, the newest 3. `FleetLog.jsx:81`. |
| Empty state | Say so rather than draw nothing | Yes | Rendered with an empty log: `(no events yet — launch a session with N)`. `FleetLog.jsx:158`. |
| Focused-agent highlight | Mark rows from the focused card | Unverified | `FleetLog.jsx:127-129` changes only the colour, which my captured frames strip. |
| One-row rows | A multi-line preview must clip, not grow the frame | Yes | Every rendered log row came back as exactly one line, including a 90-character preview. `FleetLog.jsx:136`. |
| **Row text budget** | Reserve the fixed prefix columns so the message text fits | Partly — the budget is wrong | `fleetLogTextBudget` returns `width - 40` (`FleetLog.jsx:70-72`) and its note itemises clock 9 + slot 5 + name 21 + glyph 2 = 37. It does **not** reserve the tool prefix, which is up to 29 cells (`:147`). Rendered a long tool name plus a long preview at 120 columns: the row is 119 characters and the end of the message is gone — Ink's own truncation did the cutting, not the budget. Effect is clipping, not layout breakage, so the row stays one line. |
| **Log timestamps** | Show the event time | Works, ignores the clock setting | Rendered `16:55:56` while local time was `11:57`. `FleetLog.jsx:137` calls `fmtClock(ts)` with no second argument, so it always uses the 24-hour UTC form regardless of the user's `clock24` setting. The header labels its clock "UTC"; these rows carry no label. |
| Escape stripping on log text | Untrusted session text must not reach the real terminal | Partly verified | Every kind routes through the sanitiser (`FleetLog.jsx:146`, `:150`), and the tool name does too. I rendered benign text only. The sanitiser itself is covered in section 9, also without hostile input. |

---

## 9. Shared helpers

| Feature | Expected to do | Does it? | How I know |
| --- | --- | --- | --- |
| **`fmtK` compact numbers** | Render a token count short | Yes, and it hides missing data | Called it directly across a range: `999 → "999"`, `1000 → "1.0k"`, `142000 → "142.0k"`, `1000000 → "1.0M"`, `224001600 → "224.0M"`, `-5 → "-5"`. But also `null → "0"`, `undefined → "0"`, `NaN → "0"`, `Infinity → "0"` (`format.js:93-98`). Any arithmetic that goes wrong upstream prints a confident zero. This is the single largest unknown-as-zero surface in the fleet view — it feeds the context count, tok/min, the token foot, and the header's threshold. |
| `fmtMoney` | Format a dollar figure | Yes, same caveat | Called directly: `0.42 → "$0.42"`, `212.5 → "$212.50"`, `null → "$0.00"`, `undefined → "$0.00"`. `format.js:102`. |
| `fmtMem` | Memory in MiB or GiB | Yes | Called directly: `186000 → "182M"`, `2100000 → "2.0G"`, `500 → "0M"`, `null → "0M"`. `format.js:107-110`. |
| `fmtDurShort` | Compact duration | Yes, same caveat | Called directly: `45000 → "45s"`, `720000 → "12m"`, `8040000 → "2h14m"`, and `null`/`NaN`/negative all → `"0s"`. `format.js:266-273`. |
| `barCells` | Build a colourable progress bar with an optional threshold marker | Yes | Called directly. A value above 1 clamps to a full bar (`████████`). `NaN` returns all-empty cells (`········`) — an unmeasured ratio draws as zero, which is why the card gates the context bar separately rather than passing an unknown through. `format.js:56-79`. |
| `sparkLine` | Eight-level bars; nothing when there is no activity | Yes | Called directly: `[] → ""`, `[0,0,0] → ""`, `[1,2,3] → "▃▆█"`. `format.js:83-91`. |
| `trunc` | Cut to a width measured in terminal cells, never mid-character | Yes | Called directly on a CJK string: `trunc('項目管理システムの設定', 10)` → `"項目管理…"` — four double-width characters plus an ellipsis is 9 cells, correctly under budget. `format.js:118-143` measures with Ink's own width library. |
| `padCol` | Fit a fixed column in cells | Yes | Called directly: `padCol('項目管理システム', 20)` returned the 8 characters (16 cells) plus 4 spaces. `format.js:145-159`. |
| `fmtClock` | Wall clock, 24- or 12-hour | Yes, always UTC | Called directly at a known instant: returned `16:57:00` while local time was `11:57:00`. `format.js:161-168` uses UTC in both branches. |
| `humanize` sanitiser | Strip terminal escapes, collapse home paths, UUIDs and long payloads | Unverified against hostile input | Read `format.js:170-253`. It covers 7-bit and 8-bit escape forms, collapses newlines and tabs to a space, and shortens paths and UUIDs. I rendered only benign text. The escape-stripping claim is the security-relevant one and I did not test it. |
| **`UNKNOWN` marker** | One spelling of "we do not know" across the whole UI | Partly | `format.js:29` exports `UNKNOWN = '?'` and `Card.jsx` uses it for context, background count, session age and time-in-state. It is **not** used for the turn count, message count, cost or token foot, which still print `0`. The `unknownIf` helper at `format.js:35-37` has no callers in this area. |
| Themes | Named colour tokens per palette | Yes, and hard-coding is correct here | Read `tui/lib/themes.js:7-53`: seven palettes, each with the same 15 token names. The hex values are literals, and they should be — the app owns its own colours; this is not the hard-coded-data defect. |
| `projectHealth` reader | Read a project's latest health reading cheaply and safely | Yes | Covered end to end in section 6. It reads a real file written by someone else and never computes a score. |

---

## Summary

**135 features examined.**

| Verdict | Count |
| --- | --- |
| Verified — rendered, or traced source to screen | 83 |
| Partly — works, with a named gap | 24 |
| Display only — drawing verified, source hop not | 14 |
| Unverified — not checked | 9 |
| Broken | 5 |
| Test only — pins behaviour, not correctness | 0 |

Against the four buckets asked for: **83 verified**, **0 test-only**,
**23 unverified** (the 14 display-only rows plus the 9 unchecked), **5
broken**, and 24 that work with a named gap.

No row in this register rests on a passing test. Every "yes" was either
rendered and read back, or traced from the value's assignment to the line
that draws it. Where I could not do either, the row says unverified.

### Broken

1. **Card content garbles below 38 columns wide.**
   `tui/Card.jsx:370-381` (tok/min row) and `:360-369` (context row).
   Rendered at `cardWidth` 30: `tok/mi3.2k ▂▃▅▃▇█▄▆▆▃▅█37%` on one line and
   `▄           182M` on the next. At 20: the label itself splits across two
   rows as `tok/` and `in`. Only the name and branch are width-budgeted
   (`:291-301`); the other rows are not. A 100-column terminal at the default
   5 columns produces a 24-wide card, so this is reachable on ordinary
   hardware. `tui/lib/gridLayout.js:16` permits widths down to 20.

2. **The header silently loses its right-hand segments.**
   `tui/Header.jsx:45` — `flexWrap="nowrap" overflow="hidden"` with every
   segment `flexShrink={0}`. Measured by sweeping widths: the status pill
   first appears at 122 columns and the clock at 182 (154 with no auth chip).
   Below that the content falls off the right edge with no indication. The
   README states the pill is part of the header.

3. **A green "clean" git dot can mean git failed.**
   `server/git.mjs:43-48` returns `0` for a timeout, a missing binary and a
   genuinely clean tree alike; `tui/Card.jsx:336-338` draws the green dot for
   `0`. `server/git.mjs:65` likewise returns `dirty: 0` for a directory that is
   not a repository at all. Rendered both: `dirty: 0` and `branch: null,
   dirty: 0` produce the same green `●`, the second alongside a `⎇ —` branch.

4. **The "Card tail: show tool events" setting does nothing.**
   `tui/lib/settings.js:133` describes behaviour the card no longer has.
   `tui/Card.jsx:83` accepts the prop and never reads it; `tui/App.jsx:2153`
   still passes it. The card's own note at `Card.jsx:80-82` says so.

5. **The estimated-cost marker bypasses its own constant.**
   `tui/lib/format.js:30` exports `ESTIMATED = '~'` so the marker cannot be
   spelled two ways. `tui/Card.jsx:453` and `tui/modals/Zoom.jsx:236` both
   hard-code `'~'`. Grepped `tui/`, `server/`, `bin/` and `scripts/` for the
   name: the only two hits are its own definition and the comment above it.
   The constant has no callers anywhere.

### Hard-coded values feeding this view

Not defects on their own, but each is a number typed here rather than read
from a source, and each is the kind that drifts:

- `WEEK_CAP = 250` — `tui/Aggregate.jsx:10`. Every user's weekly budget bar is
  drawn against $250. The file's own note says it should be a setting. A
  `dailyBudgetUSD` setting exists and does not feed it.
- `CARD_H = 11` — `tui/lib/gridLayout.js:15`, repeated as `height={11}` at
  `tui/Card.jsx:95` and `:310`. One number, three copies, joined by a comment.
- `MIN_CARD_W = 20` — `tui/lib/gridLayout.js:16`. A floor, not a guard; see
  broken item 1.
- `RECENT_API_MS = 5 * 60 * 1000` — `tui/Header.jsx:37`, the API-retrying window.
- `BAR_W = 24`, `SPARK_W = 22` — `tui/Aggregate.jsx:11-12`.
- `ctxBarW = 14` and the sparkline width `14` — `tui/Card.jsx:190`, `:196`.
- The fleet-log prefix reservation `40` — `tui/FleetLog.jsx:71`, and the name
  column `20` at `:131`. The two disagree by one, and neither reserves the
  29-cell tool prefix.
- `TTL_MS = 2500`, `TAIL_BYTES = 16384` — `tui/lib/projectHealth.js:16-17`.
- Eight models with their labels, context windows and four prices each —
  `tui/lib/models.js:66-74`. `maxCtx` is the denominator of every context
  percentage on every card.
- The six status words and glyphs — `tui/Card.jsx:33`, `:146-149` — a second
  hand-typed copy of the enum in `server/agent.mjs`. This one degrades
  gracefully: an unrecognised state falls back to `·` and the upper-cased
  string.
- Ten triage verb strings — `tui/Card.jsx:255-282`.

### Where "unknown" still renders as a confident zero

The 2026-09 pass fixed the context percentage, the background count, the
health score and the two card timestamps: all now print `?`. These were not
included and still print `0`:

- turn count — `tui/Card.jsx:431`
- message count — `tui/Card.jsx:432`
- session cost — `tui/Card.jsx:453`
- tokens in and out — `tui/Card.jsx:455`
- CPU percentage when only memory sampled — `tui/Card.jsx:379`
- fleet token totals and session cost — `tui/Aggregate.jsx:34-36`
- plan quota percentages — `tui/lib/usage.js:38`
- git ahead/behind on a branch with no upstream — `server/git.mjs:57-59`

`fmtK`, `fmtMoney` and `fmtDurShort` all return a zero-shaped string for
`null`, `undefined` and `NaN` (verified by calling them directly), so these
are silent by construction rather than by a `|| 0` at each call site.

For a live agent the server stamps all of these fields, so a confident zero
on screen means either a real zero or a snapshot that lost a field — and
nothing on the card distinguishes the two.

### What I could not verify

- Most colours. I kept the colour codes for the border, the status word and
  the filter-dimming comparison, so those are observed. Model colours and the
  fleet-log focus highlight are still logic-read only.
- The escape-stripping sanitiser against hostile input. It is the
  security-relevant claim in this area and I tested it with benign text only.
- The pager strip, the empty-state panel and the three status-bar warning
  chips, which need either a live Fleet or a forced runtime state.
- Whether tok/min is current. A frozen rate renders identically to a live one,
  and the code says it freezes (`tui/Card.jsx:203-204`).
