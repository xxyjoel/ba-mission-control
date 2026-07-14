# ba-mission-control — 500+ Improvement Backlog

Generated 2026-06-09 from the systematic audit. Each row is a discrete,
file-pinned action. Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

Read with `ARCHITECTURE.md` (state model) and `COMPONENTS.md` (per-component
inventory + orphan flags).

---

## STATUS — last updated 2026-06-10

Items shipped to `main` and covered by tests. Reference column points at
the commit short SHA. Re-run `git log --oneline` to verify.

| # | Task | Commit | Tests added |
|---|------|--------|-------------|
| 1-9 | TextField cursor positioning (←/→, Ctrl+A/E, backspace at cursor, insert at cursor) | `61225b7` | 11 unit + 4 PTY |
| 48-49 | Multi-line ↑/↓ within composer; Zoom history recall coordinated | `e5daaee` | 3 unit + 1 PTY |
| 57 | App.jsx tick interval no longer depends on `snapshot` → re-render loop killed | `c7d4e30` | 1 |
| 117-122 | (partial) — env allowlist still pending | — | — |
| 126 | Agent.send respawn race — pendingSends queue + respawning flag | `935a472` | 4 |
| 160 | sessionStore atomic write + `.bak` rollback | `935a472` | 5 |
| 161 | costStore + settings atomic write + `.bak` rollback | `efc9784` | 6 |
| 244-258 | App-level hotkey test coverage (q/n/p/r/?/,/b/d/:/, arrow nav, slot jumps) | `efc9784` | 15 |
| 321 | Verified orphan slash commands are wired through onSlashCommand → runCommand | `820e558` | 7 |
| 380-382 | `MC_CONFIG_DIR` routes all state through configDir; DEV banner; npm run dev:sandbox | `27be7dd` + `61225b7` + `820e558` | 2 PTY |
| 383 | Boot banner `[mc] <ver> · g<sha> · dirty?` + `:version` verb | `58e686a` + `c7d4e30` | 1 PTY |
| 425, 426, 427, 430 | Help modal docs `:cap` `:budget` `:cost` `:template` `:version` `:transcript` `:where` `:tasks` `q-confirm` | `4bce8b3` + `75afcab` | — |
| 616 | Composer at TOP of Zoom modal (cursor on first visible row) | `ecf7ff7` | 2 |
| 617 (MVP) | `:tasks` toasts GH Issues via gh CLI — full right-side panel still pending | `5782ac8` | 3 |
| 624 | Card overlap on narrow terminals — grid auto-reduces column count | `95801e5` | 2 |
| 625 | `:transcript` / `:tx` / `:log` + `:where` verbs surface persistent state | `95801e5` | — |
| (q-quit) | `q` opens `<QuitConfirm>` modal (replaces self-conflicting q+y arming) | `4e4df92` + `c7d4e30` | 3 PTY + 2 hotkey |

**Test count delta:** 6 → 216 tests · 0 fail. 14 new test files (4 real-PTY recipes).

**Top of the backlog still open** (in priority order):
1. #338-346 — App.jsx + Zoom.jsx hook extraction (architectural refactor)
2. #616 (full) — split-pane Zoom with right-side notes panel
3. #617 (full) — right-side persistent task panel in Zoom
4. #619-620 — Ctrl+T 3-state toggle + always-visible user-command panel
5. #621-622 — plugin slash commands (`/forge-goal` `/forge-init`)
6. #117-122 — security batch (env allowlist, path containment, API key redaction)
7. #58-65 — performance pass (memo dep stabilization, Agent stream throttling)
8. #259-280 — store + Fleet + Agent test backfill

---

## Index of buckets

| # | Bucket | Count |
|---|--------|-------|
| 1 | TEXTFIELD & COMPOSER EDITING — the "real text box" gap | 56 |
| 2 | PERFORMANCE — re-render storms, sync I/O, memo deps | 60 |
| 3 | SECURITY — env leaks, path escape, validation gaps | 42 |
| 4 | ROBUSTNESS — race conditions, silent failures, state leaks | 54 |
| 5 | TESTS — coverage gaps for commands, hooks, stores | 84 |
| 6 | DEAD-CODE REMOVAL — orphans flagged by the audit | 30 |
| 7 | ARCHITECTURE REFACTOR — App.jsx + Zoom.jsx splits | 42 |
| 8 | DEVELOPER EXPERIENCE — hot reload, lint, CI, types | 44 |
| 9 | DOCUMENTATION — Help, README, CONTRIBUTING, JSDoc | 38 |
| 10 | NEW FEATURES — safe dev workflow, sandbox, webhooks | 62 |
| 11 | ACCESSIBILITY & TUI UX | 32 |
| 12 | OBSERVABILITY & TELEMETRY | 24 |
| 13 | UI / UX POLISH | 36 |
| 14 | STRUCTURAL ASKS FROM 2026-06-09 USER FEEDBACK | 12 |
| **TOTAL** | | **616** |

---

## 1. TEXTFIELD & COMPOSER EDITING (56)

The composer is the highest-friction surface. The user's stated pain
("starts the cursor at the beginning of the line", "can't make newlines",
"5 attempts have failed") all live here. Make it a real text box.

1. **C** `TextField.jsx` — add `cursorPos` state so the caret is positionable; not always end-of-string
2. **C** `TextField.jsx` — handle `key.leftArrow` to move cursor one char left
3. **C** `TextField.jsx` — handle `key.rightArrow` to move cursor one char right
4. **C** `TextField.jsx` — handle `key.upArrow` to move cursor up one visual line (multi-line)
5. **C** `TextField.jsx` — handle `key.downArrow` to move cursor down one visual line
6. **C** `TextField.jsx` — `Home` → jump to column 0 of current line
7. **C** `TextField.jsx` — `End` → jump to end of current line
8. **C** `TextField.jsx` — backspace deletes the character BEFORE the cursor, not always the tail
9. **C** `TextField.jsx` — `Delete` key removes character AT the cursor
10. **H** `TextField.jsx` — `Ctrl+Left` / `Option+Left` → jump back one word
11. **H** `TextField.jsx` — `Ctrl+Right` / `Option+Right` → jump forward one word
12. **H** `TextField.jsx` — `Ctrl+A` → move cursor to start of line (Emacs/readline)
13. **H** `TextField.jsx` — `Ctrl+E` → move cursor to end of line (Emacs/readline)
14. **H** `TextField.jsx` — `Ctrl+U` → delete from cursor to start of line
15. **H** `TextField.jsx` — `Ctrl+K` → delete from cursor to end of line
16. **H** `TextField.jsx` — `Ctrl+W` → delete word before cursor
17. **H** `TextField.jsx` — paste handling: detect bracketed-paste sequence `\x1b[200~ ... \x1b[201~` and insert atomically
18. **H** `TextField.jsx` — render caret AT cursor position (not always at end)
19. **H** `TextField.jsx` — multi-line up/down should preserve column when possible (sticky cursor column)
20. **H** `TextField.jsx` — Backspace at start of a non-first line joins to end of previous line
21. **M** `TextField.jsx` — `Ctrl+Z` → undo last edit (ring buffer of up to 50 states)
22. **M** `TextField.jsx` — `Ctrl+Shift+Z` / `Ctrl+Y` → redo
23. **M** `TextField.jsx` — `Ctrl+T` is currently swallowed; document explicitly that it's reserved by Zoom (hide tools) so future contributors don't try to bind it
24. **M** `TextField.jsx` — visible character count in placeholder slot when multi-line (e.g. `· 3 lines · 142 chars`)
25. **M** `TextField.jsx` — show line/col indicator at composer right edge when in multi-line mode
26. **M** `TextField.jsx` — selection: shift+arrow extends selection; backspace/delete removes selected range
27. **M** `TextField.jsx` — `Ctrl+A` after selection should select all (so it has Emacs *and* select-all meaning by mode)
28. **M** `TextField.jsx` — visible blink-rate setting in `SETTINGS_SCHEMA` (currently hardcoded 530ms)
29. **M** `Zoom.jsx` — composer wrapping container should set `flexDirection="column"` explicitly so the multi-line render never collapses to a single row
30. **M** `Zoom.jsx` — when composer has >1 line, render a faint left-edge `┃` ruler so the box is visually grouped
31. **M** `TextField.jsx` — bracketed paste auto-detects multi-line and inserts; document the wire format
32. **L** `TextField.jsx` — bracketed paste mode toggle on focus (`\x1b[?2004h`) — enable explicitly
33. **L** `TextField.jsx` — `Tab` insertion (current behavior: swallowed) — add a mode for "tab = literal tab" vs "tab = autocomplete"
34. **L** `TextField.jsx` — emoji rendering: avoid splitting `string` mid-surrogate-pair on backspace
35. **L** `TextField.jsx` — combining-character handling (grapheme clusters) — backspace should remove the full cluster
36. **L** `TextField.jsx` — wide-glyph cursor positioning (CJK 2-cell chars)
37. **C** add `tests/TextField.cursor.test.jsx` — every cursor key + edit operation gets a unit test
38. **H** add `tests/recipes/textfield.cursor.recipes.test.jsx` — same operations under real-PTY
39. **H** add `tests/Zoom.composer.test.jsx` — multi-line composer behavior inside Zoom layout
40. **H** `Broadcast.jsx` — apply the same cursor/editing improvements (uses TextField too)
41. **H** `NewSession.jsx` — apply the same improvements (path input field)
42. **M** `TextField.jsx` — `Esc` flushes pending escape-merge immediately if a key follows within 5ms (tighter than 80ms)
43. **M** `TextField.jsx` — keypress diagnostic mode: render `[ctrl] [meta]` chips above the field while a debug env is set
44. **L** `TextField.jsx` — visible "insert mode" indicator (vs hypothetical future overwrite mode)
45. **L** `Zoom.jsx` — `Ctrl+J` newline should trigger a brief flash on the new line so the user knows it landed
46. **M** `TextField.jsx` — feed `MC_DEBUG_KEYS` log into a `:debug-textfield` toggle that prints in-UI
47. **L** `TextField.jsx` — settings entry: `composerHistoryLimit` (currently uses `agent.tail` userHistory unbounded)
48. **M** `Zoom.jsx` — `↑↓` history recall in composer should put the cursor at END of recalled prompt, not auto-advance
49. **M** `Zoom.jsx` — when composer is multi-line, `↑↓` should navigate within the composer FIRST and only walk history once cursor is at top/bottom
50. **H** `TextField.jsx` — confirm with PTY test that `Ctrl+H` (some terminals' backspace) is handled
51. **H** `TextField.jsx` — confirm `Backspace` arrives as `\x7f` (DEL) on macOS and is handled
52. **M** `Zoom.jsx` — show a `[Ctrl+J newline · Enter send]` hint below the composer when it has focus
53. **L** `TextField.jsx` — `Ctrl+L` clears the field (Emacs convention)
54. **M** `TextField.jsx` — `mc-test-textfield` standalone runner CLI so users can interactively verify their terminal's keys
55. **C** wire `MC_DEBUG_KEYS=1` outputs into the failing-test artifacts so contributors can attach their wire-level log
56. **M** add a section in `README.md` explaining the composer keymap explicitly — currently buried in `Help.jsx`

---

## 2. PERFORMANCE (60)

Re-render storms, unstable memo deps, sync I/O in the event loop.

57. **C** `App.jsx:122-135` — tick interval calls `setSnapshot(fleet.snapshot())` AND depends on `snapshot` → re-render loop; remove snapshot from deps
58. **C** `App.jsx:345-347` — `agents` useMemo depends on `agentsRaw` which is recreated every `setSnapshot()`; stabilize by reference
59. **C** `App.jsx:211` — `useEffect(..., [settings.repoParents.join(':')])` creates a new string every render → effect always runs
60. **C** `App.jsx:268-282` — `stuckAlertRef` effect has no dep array; eslint-disable is unjustified
61. **C** `App.jsx:290-324` — `ctxAlertRef` effect same; document why or add deps
62. **C** `App.jsx:888-900` — arrow-nav recomputes `agents.filter(a=>a.status!=='empty')` per keypress; memoize at top
63. **C** `Zoom.jsx` — `allRows` memo lists every line — measure cost on long sessions; cap or virtualize
64. **C** `Agent#updateSpark` — `[...this.spark.slice(1), ...]` allocates per turn; use circular buffer with index
65. **C** `Agent#handle` (stream_event) — string `.slice(-160)` on every delta; accumulate in a buffer and slice on newline
66. **C** `Agent.send` — `proc.stdin.write(line)` is sync; switch to `write(line, cb)` with backpressure
67. **H** `Fleet.snapshot()` — called on every tick AND every change emit; debounce or compute on demand
68. **H** `App.jsx` — `fleetLog` useMemo depends on `agents` (unstable); split into log-event-derived state
69. **H** `App.jsx` — `fleetTpm` useMemo depends on `agents` (unstable); compute from agent.spark direct
70. **H** `Card.jsx:150+` — tail filtering inline; memoize per agent
71. **H** `FleetLog.jsx:36` — `deriveFleetLog()` sorts on every render; cache by tail length + last ts
72. **H** `Zoom.jsx:158+` — `listMentionTargets()` runs on every keystroke; debounce 100ms
73. **H** `Agent.tail.push` + `shift` — O(n) per event; use ring buffer
74. **H** `App.jsx:184` — `refreshRepos()` on every modal change instead of only on `open`
75. **H** modals — wrap inputs in `React.memo` so parent re-render doesn't re-mount them
76. **H** `Aggregate.jsx` — sparkline recompute on every render; memoize on agg array
77. **H** `Card.jsx` — chip color computation per render; memoize statusColor by status
78. **H** `Zoom.jsx` — topLine effect depends on logHeight + log → re-fires on every snapshot
79. **H** `App.jsx` — `cmdBuffer` setState fires on every keystroke; batch via `useReducer`
80. **H** `App.jsx` — `toasts` array recreated on every push; switch to ordered map + immutable adds
81. **M** `App.jsx` — `costStoreRef.current.update()` syncs to disk every snapshot; debounce to 1Hz
82. **M** `sessionStore.syncFromSnapshot()` — writes JSON on every snapshot; debounce to 5s
83. **M** `costStore` — switch from `writeFileSync` to async with queue
84. **M** `sessionStore` — same
85. **M** `Agent#scheduleChange` — 50ms throttle window probably too tight; bench 100ms
86. **M** `Agent#flushChange` newline-trigger — fires synchronously every newline; coalesce within 16ms frame
87. **M** `App.jsx` — `now` clock state ticks every 700ms; consider tying to header-only useMemo
88. **M** `App.jsx` — re-resolve theme on settings change re-renders entire tree; memoize theme by name
89. **M** `Card.jsx` — sparkline character lookup per cell; pre-compute as a constant table
90. **M** `format.js:sparkLine` — re-creates char array per call; cache by level
91. **M** `humanize()` regex compiled per call; module-scope it
92. **M** `Zoom.jsx` line wrapping — recomputed per render; cache by (line, width)
93. **M** `Agent#writeTranscript` — opens stream lazily on first send; ok, but flush on every event creates many syscalls; batch
94. **M** `costStore` — `lastSeen` map grows; GC every 30s already exists (App.jsx:245) — confirm bounds
95. **M** `App.jsx` `useEffect([snapshot])` — fires for every micro-change; coalesce
96. **M** `App.jsx` — toast auto-dismiss timers leak refs when component unmounts; clear on unmount
97. **M** `Zoom.jsx` — composer reflow on multi-line growth jitters; lock height min
98. **M** `FleetLog.jsx` — line truncation at col 90 is hardcoded; should read terminal width
99. **L** `App.jsx` — `useInput` callback recreated every render; useCallback
100. **L** `Agent` — `proc.on('exit')` listener allocated per start; reuse arrow ref
101. **L** `Zoom.jsx` — re-renders fully when stats expand; isolate stats panel
102. **L** `Card.jsx` — context-bar cells recomputed; memoize by (context, max)
103. **L** `Aggregate.jsx` — usage % recomputed; memoize on `usage`
104. **L** `Header.jsx` — clock formatting per tick; memoize ((nowMs/1000)|0)
105. **L** `App.jsx` — `weekCost`/`dayCost` stored separately; one object reduces renders
106. **L** `App.jsx` — `aggSpark` mutated then setState'd; use immer or copy-on-write
107. **L** `Zoom.jsx` — slashOpen recomputed on every render; gate by `msg.startsWith('/')`
108. **L** `Zoom.jsx` — fileMatches array stored in state but produced by async effect; race condition under fast typing
109. **L** `App.jsx` — stale-snapshot warning: snapshot.agents mutates after publish; clone or freeze
110. **L** `Agent` — `tail` array mutated in place by callers (Zoom slices it); structurally clone before exposing
111. **C** add perf-budget test: render 1000 agent events / 60s, assert <200 renders
112. **H** add perf-budget test: keypress→frame latency < 30ms on Card grid
113. **H** add perf-budget test: Zoom composer keypress latency < 16ms
114. **H** add perf-budget test: boot-to-first-frame < 1.5s
115. **M** add perf budget for `Fleet.snapshot()` size — warn if > 100KB
116. **M** Profile with `--cpu-prof` and commit a baseline trace as fixture

---

## 3. SECURITY (42)

117. **H** `main.jsx:preflight` — validate `claude --version` output is a semver-like string before logging
118. **H** `auth.js` — `ANTHROPIC_API_KEY` fallback exposes key shape in `authSummary`; redact
119. **H** `agent.mjs:spawn` — `env: process.env` passes EVERYTHING; build allowlist (`HOME`, `PATH`, `CLAUDE_*`, `LANG`, terminal-related)
120. **H** `git.mjs:spawn` — same env leak; allowlist
121. **H** `Zoom.jsx:listMentionTargets` — `prefix` can contain `..`; resolve and check that resolved path stays under `cwd`
122. **H** `repos.mjs:listRecentRepos` — symlinks can escape `parents`; `fs.realpathSync` before parent check
123. **H** `sessionStore.js` — silent reset on JSON parse error → data loss; backup `.bak` before write, restore from .bak on parse fail
124. **H** `costStore.js` — same backup pattern
125. **H** `settings.js` — same backup pattern
126. **H** `agent.mjs:send` race — respawn is not awaited; guard with `respawning` flag
127. **H** `Agent.respawn` exhaustion → infinite restart if init events succeed but turn-handle fails; cap absolute restarts (e.g. 20 / hour)
128. **H** `settings.js` — accept-Slack-url validation only checks https prefix; restrict to `hooks.slack.com`
129. **H** `App.jsx:launchSession` — `expandTilde` then no existsSync check; validate the path exists and is a directory
130. **M** `Agent#onStdout` — JSON parse can fail; if a line >1MB without `\n`, drop with warning instead of unbounded buffer
131. **M** `templateStore` silent failures; surface via `:template` listing
132. **M** `main.jsx:shutdown` — order: unmount first, then killAll (so the UI is gone before processes exit)
133. **M** `Zoom.jsx` — composer paste accepts ANY ANSI escape; strip control bytes other than `\n`/`\t`
134. **M** `slack.js:postSlack` — should use timeout (currently could hang indefinitely)
135. **M** `auth.js:probeAuth` — `execFileSync` blocks boot 3s if claude misbehaves; switch to `execFile` with promise + timeout
136. **M** `agent.mjs` — transcript file in `~/.local/state/...` is mode 0644; should be 0600 (may contain prompts)
137. **M** `sessionStore` writes are mode 0644; should be 0600
138. **M** `costStore` writes mode 0644; ok to leave but document
139. **M** `agent.mjs` — `proc.stdin.write` doesn't handle EPIPE → uncaught; wrap
140. **M** `agent.mjs` — `proc.stderr` is currently ignored; capture last N lines and surface on error status
141. **M** `App.jsx` — `:feedback` / `:request` send arbitrary user text to a webhook; warn first
142. **M** `App.jsx` — `:repos clear` is destructive of settings.repoParents; require confirm
143. **L** `format.js:humanize` — path sanitization could leak user home; ensure tilde-replacement applies before display
144. **L** `mockAgent` — `fixture` filename is concatenated into path; validate it's `[a-z0-9-]+`
145. **L** `agent.mjs` — `sessionId` injected via CLI arg; validate UUID shape before spawn
146. **L** `agent.mjs` — `model` arg validation — restrict to known IDs from `MODELS`
147. **L** `agent.mjs` — `cwd` validation — exists + is dir + isn't `/`
148. **L** `agent.mjs` — `permissionMode` validation — enum check
149. **H** add `tests/security/` directory with regression tests for each of the above
150. **M** wire `npm audit` as a pre-push gate (with `--production` if needed)
151. **M** add a `:security-report` slash command for the user that runs `npm audit` and reports
152. **M** dependabot or renovate config to keep ink/node-pty patched
153. **M** rotate Slack webhook docs — warn users that webhook URL is sensitive
154. **L** `App.jsx` — `:slack <url>` should mask the URL in subsequent `:settings` displays
155. **L** consider adding a `:wipe` verb that clears all on-disk state (audited delete)
156. **M** add `npm run audit:secrets` script using `trufflehog` to flag accidental commits
157. **H** add `SECURITY.md` with disclosure process + supported versions
158. **L** confirm `node-pty` minimum version doesn't have known CVEs (current 1.1.0)

---

## 4. ROBUSTNESS (54)

159. **C** `Agent.send` respawn race (line 641-646) — set `respawning` flag, queue messages
160. **C** `sessionStore` silent persist failure → data loss; emit error, fall back to `.bak`
161. **C** `costStore` silent persist failure → cost-tracking loss; same
162. **H** `Agent.cost cap` only enforced on `result` event — add a "soft cap" based on streaming usage projections
163. **H** `Agent#onExit` restart loop — track restart count over rolling 1-min window; refuse to restart if > 5
164. **H** `Fleet.killAll` — sequential `agent.kill()`; some may throw — wrap each
165. **H** `App.jsx:resumeAllSessions` — failure aggregation; one toast `resumed X/Y · failed Z` instead of N toasts
166. **H** `Zoom.jsx` topLine — invalidate on agent change (resume / kill)
167. **H** `Agent.tail` shared mutable — Zoom slices it directly; clone or freeze
168. **H** `App.jsx` — kill-arm and quit-arm refs share no consistent lifecycle reset on modal open
169. **M** `Agent.changePermissionMode` — must await prior proc exit before respawn
170. **M** `Agent.kill` — second call should be no-op, not throw
171. **M** `Agent#onExit` — restart counter resets on any `init`, even from failing turn → unconditional reset is too generous
172. **M** `App.jsx` shutdown — two killAll calls; consolidate to one with lock
173. **M** `App.jsx:368-373` — focusedSlot auto-slide can jump unexpectedly; only slide when current is `empty`
174. **M** `Broadcast` — verify all target slots are non-empty before send; report mismatches
175. **M** `Agent.proc` listeners — `proc.removeAllListeners` only in one path; centralize teardown
176. **M** `MockAgent` — if fixture missing, hang silently; surface `error` status
177. **M** `Zoom.jsx` composer — `setMsg('')` after submit but `historyIdx` not reset → ↑ recall starts wrong
178. **M** `Zoom.jsx` — slashOpen + fileOpen can both be true; only the more recent token should be visible
179. **M** `App.jsx` cmdMode → on modal open, cmdMode should reset to 'normal'
180. **M** `TextField` escape-defer — pending timer fires after unmount in race window <80ms
181. **M** `Agent#flushChange` — calls `this.emit('change')` even when subscribers are gone (after kill)
182. **M** `Fleet.launch` — `slot already occupied` error currently throws; toast cleanly
183. **M** `Agent.start` — refreshGit failure swallowed → branch/dirty become stale; surface
184. **M** `App.jsx` `auth` boot toast — fires on probe success/fail, but :auth re-probe also toasts; gate by event source
185. **M** `costStore.update` — negative delta auto re-anchors silently; warn (it's a real signal)
186. **M** `sessionStore.syncFromSnapshot` — does not validate slot range; can produce bad records
187. **M** `App.jsx` — `setSnapshot` from interval can race with `setSnapshot` from event emit; useReducer would be safer
188. **M** `Zoom.jsx` — typing in composer while agent is in `'paused'` is allowed; queue or refuse with toast
189. **M** `App.jsx` — `cmdBuffer` keeps text across mode changes — clear on cmdMode reset
190. **M** `Settings.jsx` — saving on every keypress can produce many writes; debounce
191. **L** `Card.jsx` — empty-slot placeholder may flash during launch transition
192. **L** `Agent#scheduleChange` — clearTimeout call when no timer
193. **L** `App.jsx` — `setNow(Date.now())` clock not monotonic; use performance.now for derived durations
194. **L** `App.jsx` — `pushToast` accepts arbitrary text; clamp length
195. **L** `humanize` — long paths can blow Help row width
196. **L** `App.jsx` — :resume with bad slot toasts repeatedly; aggregate
197. **L** `Fleet.snapshot` — agents that died between snapshots vs are kept in slot until kill; document
198. **L** `Agent#parseSession` — UUID generation collision-resistant? Confirm
199. **L** `Agent#refreshGit` — runs on every result; throttle to 1Hz
200. **M** `Agent#writeTranscript` — open file errors not retried
201. **M** `MockAgent` — replay timing doesn't honor backpressure
202. **M** `Fleet.broadcast` — partial broadcast no atomic guarantee; toast each failure
203. **M** `Zoom.jsx` line scroll — `topLine: null` (live) vs number ambiguity; sentinel enum
204. **M** `Zoom.jsx` slash dropdown — items array filtered + sliced; out-of-bounds idx possible
205. **M** `Zoom.jsx` file mention — fileMatches cleared async, idx not reset
206. **L** `MockAgent` — replay supports send? Document
207. **L** `Card.jsx` border style cycles; document `inkBorderStyle` cases
208. **L** `App.jsx` — `:kill!` shortcut bypass too easy to mistype
209. **L** `templateStore` — saveTemplates() not exported; writes hand-edit only
210. **L** `Agent` — no test for SIGSTOP/SIGCONT actually pausing
211. **L** `App.jsx` — `:slack clear` should require confirm
212. **M** add `try/finally` around proc.stdin.write to surface EPIPE

---

## 5. TESTS (84)

### 5.1 App.runCommand verbs — one test each (30)

213. **H** `:quit` (already tested via app.exit signal? confirm)
214. **H** `:theme valid` → settings.theme updated; toast info
215. **H** `:theme invalid` → toast warn; settings unchanged
216. **H** `:cols 3` / `:cols 4` / `:cols 5` / `:cols 6` (invalid)
217. **H** `:perm plan` on focused
218. **H** `:perm default acceptEdits` updates fleet default
219. **H** `:perm bogus` → toast warn
220. **H** `:kill` arms; second `:kill` confirms
221. **H** `:kill!` skips confirm
222. **H** `:pause` on focused → SIGSTOP, status paused
223. **H** `:resume` on focused → SIGCONT, status idle
224. **H** `:resume 1 3 5` multi-arg
225. **H** `:resume-all` with N saved records
226. **H** `:history 5` lists 5 entries from sessions.history
227. **H** `:forget 2` clears bySlot[2]
228. **H** `:sessions` / `:ls` lists current saved records
229. **H** `:note <text>` appends to focused agent.tail
230. **H** `:approve` sends generic continue
231. **H** `:help` opens help modal
232. **H** `:whoami` / `:auth` re-probes auth
233. **H** `:dash` / `:dashboard` opens dashboard
234. **H** `:template` lists templates; `:template review` launches bundle
235. **H** `:cap 5` sets default cap to $5
236. **H** `:cap 2 10` sets slot-2 cap to $10
237. **H** `:budget 50` sets daily budget
238. **H** `:cost` toasts current session cost
239. **H** `:usage` toasts plan rate-limit usage
240. **H** `:repos` lists, `:repos clear` resets
241. **H** `:slack <url>` sets webhook; `:slack clear` clears
242. **H** `:feedback <msg>` posts to slack (mocked fetch)
243. **H** `:request <msg>` posts to slack (mocked fetch)

### 5.2 Hotkey tests (15)

244. **H** `q` arms quit; `y` confirms; any other key cancels
245. **H** `Q` (uppercase) same as `q`
246. **H** `K` arms kill; second `K` confirms
247. **H** `K` then non-`K` key → toast "kill cancelled"
248. **H** arrow-nav grid: ←→↑↓ + hjkl mapping
249. **H** `0..9` slot jump (0 = slot 10)
250. **H** `↵` on filled slot → zoom; on empty → launch
251. **H** `n` / `ctrl+n` → new-session modal
252. **H** `p` pause focused; `r` resume
253. **H** `a` approve pending action
254. **H** `shift+tab` cycles permission mode
255. **H** `/` enters filter; second `/` clears
256. **H** `:` enters command bar
257. **H** `?` opens help
258. **H** `b` opens broadcast, `d` opens dashboard, `,`/`esc` opens settings

### 5.3 Store tests (12)

259. **H** `sessionStore` — load empty; persist; re-load
260. **H** `sessionStore` — schema v1 → v2 migration
261. **H** `sessionStore` — history trim at limit
262. **H** `sessionStore` — dedupe by sessionId
263. **H** `sessionStore` — corrupt JSON → backup + empty store (not silent loss)
264. **H** `costStore` — daily rollover at UTC midnight
265. **H** `costStore` — weekly rollover at Monday 00:00 UTC
266. **H** `costStore` — negative delta re-anchors with warning
267. **H** `costStore` — GC stale agent ids
268. **H** `settingsStore` — load default; save; merge with new defaults
269. **H** `settingsStore` — schema enforcement (reject unknown key)
270. **H** `templateStore` — missing file returns bundled defaults

### 5.4 Fleet + Agent (10)

271. **H** `Fleet.launch` happy path → snapshot reflects new agent
272. **H** `Fleet.launch` on occupied slot → throws
273. **H** `Fleet.resume` round-trips sessionId
274. **H** `Fleet.kill` removes slot
275. **H** `Fleet.broadcast` to subset
276. **H** `Fleet.setCostCap` propagates to all agents
277. **H** `Agent.send` enforces cost cap
278. **H** `Agent.send` respawns dead proc safely (race)
279. **H** `Agent.changePermissionMode` round-trips
280. **H** `Agent#onExit` exponential backoff caps at N restarts

### 5.5 UI components (15)

281. **M** `Header` renders auth status colors
282. **M** `Aggregate` shows fleet tpm + usage %
283. **M** `Card` renders status glyph correctly per status
284. **M** `Card` shows pending approval indicator
285. **M** `Card` tail truncation honors maxLines
286. **M** `FleetLog` sorts by ts desc
287. **M** `FleetLog` truncates lines to width
288. **M** `StatusBar` shows cmd buffer with mode chip
289. **M** `Help` renders all sections
290. **M** `Settings` cycles tabs with `1..N`
291. **M** `Settings` toggles boolean rows with `↵`/`space`
292. **M** `Broadcast` chip toggle + send
293. **M** `Dashboard` sort cycles on `s`
294. **M** `NewSession` model selector cycles
295. **M** `RepoPicker` enter descends into dir; ← ascends

### 5.6 Zoom interactions (12)

296. **H** typing builds composer; `↵` sends; calls onSendMessage
297. **H** `Ctrl+J` newline; PTY-level via recipe
298. **H** `↑` recalls last user prompt
299. **H** `↑↑↓` walks history
300. **H** `Ctrl+S` toggles stats panel
301. **H** `Ctrl+T` toggles tool visibility
302. **H** `PgUp/PgDn` scrolls log; `↓N` indicator
303. **H** `Ctrl+G`/`End` snaps back to live tail
304. **H** `Shift+↑/↓` one-line scroll
305. **H** `/` opens slash dropdown; arrow nav; `↵` dispatches
306. **H** `@` opens mention dropdown; selection inserts path
307. **H** binary awaiting prompt: `a/y/1` approves, `r/n/2` rejects

---

## 6. DEAD-CODE REMOVAL (30)

308. **M** `slashCommands.js` — drop unwired entries (`/perm`, `/note`, `/approve`, `/pause`, `/resume`, `/kill`) — see #321 to wire instead
309. **L** `templateStore.loadTemplates` — unused export; remove
310. **L** `format.js:bar()` — superseded by `barCells`; remove (or document why both)
311. **L** `git.mjs` — de-export internal helpers (`isGitRepo`, `currentBranch`, `dirtyCount`, `aheadBehind`); keep only `fullStatus`
312. **L** `agent.mjs:448` `sawConfirmation` — unused; remove
313. **L** `App.jsx` — `zoomedAgent` is computed without empty-check; either validate or remove if dead
314. **L** `App.jsx` — `helpView` state appears unused after Help simplification; remove
315. **L** check `Dashboard.jsx` — `r/R` reverse sort handler exists but no UI cue; either wire visible indicator or remove
316. **L** `Dashboard.jsx` `s/S` sort cycler — same
317. **L** `RepoPicker.jsx` `.` to pick current — wire visible hint or remove
318. **L** `Broadcast.jsx` chip `space`/`←/→` — wire or remove
319. **L** `Help.jsx` `view` prop accepted; verify all callsites use it; else simplify
320. **L** `App.jsx` — unused imports (re-run an unused-import lint)
321. **M** **wire** the orphan slash commands (`/perm <mode>`, `/note <text>`, `/approve`, `/pause`, `/resume`, `/kill`) by routing them through the existing `:verb` dispatchers — DON'T duplicate logic
322. **L** `agent.mjs` — `MC_NO_TRANSCRIPT` env check at top — leave (test infrastructure) but document
323. **L** `auth.js` — `ANTHROPIC_API_KEY` fallback path — separately addressed in SECURITY; if removed there, remove here
324. **L** `tui/lib/format.js` — drop unused `trunc` if `humanize` already truncates
325. **L** `Card.jsx` — duplicate `TIER2_KINDS` constant; centralize in `tui/lib/tail.js`
326. **L** `FleetLog.jsx` — duplicate `TIER2_KINDS`
327. **L** `Zoom.jsx` — duplicate `TIER2_KINDS`
328. **L** scripts/fix-node-pty.mjs — fix-or-fail mode + clear log
329. **L** `bin/mc.mjs` — extra-args handling — confirm what we do if user passes flags
330. **L** `mockAgent.mjs` — orphan helpers in fixtures dir if any
331. **L** `tests/recipes/` — orphan fixtures (any without callers)
332. **L** unused exports in tests/lib/recipe.js — audit
333. **L** unused MODELS entries — confirm every ID is launchable
334. **L** confirm `themes.js:DEFAULT_THEME` is used; if not, remove
335. **L** `usage.js:fmtReset` — exported but only used by Zoom + Aggregate; ok
336. **L** `slack.js` — confirm all branches used (`feedback`, `request`); else remove kinds
337. **L** `App.jsx` — `setHelpView` state if Help no longer uses views

---

## 7. ARCHITECTURE REFACTOR (42)

338. **C** `App.jsx` — extract `useFleetSnapshot(fleet)` hook (subscription + tick interval)
339. **C** `App.jsx` — extract `useToasts({maxAge})` hook (queue + auto-dismiss)
340. **C** `App.jsx` — extract `useCommandDispatch({fleet, settings, ...})` hook returning `runCommand`
341. **C** `App.jsx` — extract `useSessionManager({fleet, settings})` hook with `resumeAllSessions`, `launchSession`, `kill`
342. **C** `App.jsx` — extract `useAuthProbe()` hook
343. **C** `App.jsx` — extract `useFleetCost(snapshot)` hook
344. **C** `App.jsx` — extract `useFocusManager()` hook
345. **C** `App.jsx` — `<ModalRouter modal={...} props={...}/>` to replace big if/else block
346. **C** `App.jsx` — `<HotkeysProvider>` to encapsulate `useInput` dispatch into named bindings
347. **H** `Zoom.jsx` — extract `useZoomScroll({log, height})` hook (topLine, hiddenAbove/Below)
348. **H** `Zoom.jsx` — extract `useZoomComposer({onSubmit})` hook (msg, history, draft cache)
349. **H** `Zoom.jsx` — extract `useZoomAwait(agent)` hook (binary/single/multi handlers)
350. **H** `Zoom.jsx` — extract `useSlashAutocomplete(msg)` hook
351. **H** `Zoom.jsx` — extract `useMentionAutocomplete({msg, cwd})` hook with debounce
352. **H** `Zoom.jsx` — split into `<ZoomLayout>`, `<ZoomLog>`, `<ZoomComposer>` components
353. **H** `Zoom.jsx` — move `wrapText` + `pctColor` to `tui/lib/format.js`
354. **H** `Zoom.jsx` — move `listMentionTargets` to `server/fs-helpers.mjs`
355. **H** `NewSession.jsx` — extract `useRepoSearch(query, repos)` hook
356. **H** `RepoPicker.jsx` — extract `useFsNav(start)` + `useListScroll(idx)` hooks
357. **M** `Settings.jsx` — render rows from `SETTINGS_SCHEMA` so adding a setting is one edit
358. **M** `Help.jsx` — derive rows from a `KEYBINDINGS` registry (single source for help + handlers)
359. **M** introduce `tui/lib/keybindings.js` — central registry; useInput + Help both consume it
360. **M** introduce `tui/lib/dispatcher.js` — central command dispatch (used by `:verb` + `/slash` + future API)
361. **M** introduce `tui/lib/types.js` — JSDoc typedefs for Agent, Snapshot, ResumeRecord, etc.
362. **M** move `TIER2_KINDS` to `tui/lib/tail.js` and import from Card/FleetLog/Zoom
363. **M** introduce `tui/lib/persist.js` — generic load/save with .bak rotation; used by sessionStore/costStore/settings
364. **M** `Agent` — split spawn logic to `server/claudeProcess.mjs`; Agent becomes a façade
365. **M** `Agent` — split tail/cost/usage state into `server/agentState.mjs`
366. **M** `Fleet` — slot allocation strategy injectable; today hardcoded `agents[slot-1]`
367. **M** introduce `server/snapshot.mjs` — single function that produces `Fleet.snapshot()` (currently inlined)
368. **L** `App.jsx` — move FeedbackStrip to its own file
369. **L** `App.jsx` — move `Toaster` rendering to its own component
370. **L** `Header.jsx` — split `Seg` into shared `tui/lib/Seg.jsx`
371. **L** `Aggregate.jsx` — split `Cell` into shared `tui/lib/Cell.jsx`
372. **L** `Help.jsx` — split `Row` and `Section` into shared
373. **L** `Zoom.jsx:TurnHeader` — move to shared
374. **L** `tui/main.jsx` — extract `wireSignals(fleet, app)` helper
375. **M** introduce `tests/lib/test-fleet.mjs` — factory for Fleet + N MockAgents for tests
376. **M** consider `useReducer` for App.jsx — collapses many setState calls
377. **L** consider switching to TypeScript for `server/` only — biggest type-debt area
378. **L** consider Zustand or Jotai for cross-cutting state (toasts, settings) — evaluate weight
379. **L** consider colocating storybook-style examples for each component

---

## 8. DEVELOPER EXPERIENCE (44)

380. **C** **safe dev-on-mc workflow** — add `scripts/dev-sandbox.mjs` that boots mc with isolated config dir + alternate CLAUDE_BIN so editing this repo doesn't kill the user's own running mc
381. **C** add `npm run dev:sandbox` that exports `MC_CONFIG_DIR=/tmp/mc-dev` (requires settings.js / sessionStore / costStore to honor that var)
382. **C** make `loadSettings` / `loadSessions` / `costStore` honor `MC_CONFIG_DIR` env var
383. **H** add a startup banner: print `mc · v0.2.0-alpha.1 · ${gitShort}` so the user always knows what version is running
384. **H** add `:version` command that toasts version + git short SHA
385. **H** `npm test` should split into `test:unit` (fast) and `test:pty` (slow) so the watch loop is tight
386. **H** add `eslint` + `eslint-config-react-hooks` to catch missing deps + stale closures
387. **H** add `prettier` config so formatting doesn't bikeshed
388. **H** add `tsconfig.json` with `checkJs: true` for IDE hints without converting to TS
389. **H** add JSDoc to every exported function in `server/`
390. **H** add `CONTRIBUTING.md` with "how to add a slash command", "how to add a setting", "how to add a modal"
391. **H** GitHub Actions: `node20-test` + `node22-test` matrix
392. **H** GitHub Actions: lint job
393. **H** add issue templates: `bug.md`, `feature.md`, `forge-bug.md` (forge already added some — verify)
394. **H** add PR template with checkbox for HANDOFF update
395. **M** `pre-push` hook: also lint, not just test
396. **M** `pre-commit` hook: prettier --check on staged files
397. **M** `npm run repl` — drop into a REPL with fleet pre-constructed for interactive poking
398. **M** add `scripts/probe-keys.mjs` — standalone tool that prints raw input/key flags so users can debug their terminal
399. **M** add `scripts/check-renderer.mjs` — sanity-check Ink/React versions + node compat
400. **M** add a code-tour comment block at the top of `App.jsx` walking through file structure
401. **M** add tasks/_template comments to `server/agent.mjs` for the stream-json wire format
402. **M** rename `agentsRaw` → `fleetAgents` (the suffix has no meaning)
403. **M** rename `focusedSlot` → `focusedSlotIdx` (it's 1..10 not 0..9 — be explicit)
404. **M** rename `awaiting` vs `awaitingPrompt` consistently
405. **M** rename `setSnapshot` → `setFleetSnapshot`
406. **M** `npm run docs:generate` — generate JSDoc HTML to `docs/api/`
407. **M** add file-header doc comments to every `server/` module
408. **L** add benchmark suite: `scripts/bench.mjs` for sparkline, render, fleet snapshot
409. **L** add `.editorconfig` for cross-editor consistency
410. **L** add `.nvmrc` pinning Node 20
411. **L** add `engines.npm` to package.json
412. **L** publish dev-only types package internal for IDE hints
413. **L** add `CODEOWNERS` if collab grows
414. **M** add `--help` flag to `mc` CLI — currently boots without help
415. **M** add `--version` flag to `mc` CLI
416. **M** add `--dry-run` flag for testing settings without launching agents
417. **L** add `--reset` flag that wipes config (audited)
418. **L** add shell completion (`mc completions zsh`) for the CLI
419. **L** add a `release.sh` script for tagging/publishing
420. **L** add a `bin/mc-doctor.mjs` that probes the environment and reports gaps
421. **M** add `.github/workflows/release-please.yml` for changelog automation
422. **M** add `npm run check` aggregating lint + typecheck + test
423. **L** profile + commit a flamegraph artifact for the boot path

---

## 9. DOCUMENTATION (38)

424. **H** README: rewrite the keymap section to mirror `Help.jsx` exactly (and stay in sync via a generator)
425. **H** README: document `q then y` confirm flow, not single-key
426. **H** README: document `:cap`, `:budget`, `:cost`, `:template` (currently absent)
427. **H** README: document `MC_DEBUG_KEYS=1` for terminal-specific debugging
428. **H** README: document `MC_MOCK=<fixture>` for trying mc without API spend
429. **H** README: document `MC_CONFIG_DIR` (after #382)
430. **H** Help modal: add row for `:cap`, `:budget`, `:cost`, `:template`
431. **H** Help modal: add Dashboard hotkey rows
432. **H** Help modal: add Broadcast chip nav
433. **H** Help modal: add RepoPicker `.` shortcut
434. **H** CLAUDE.md: add "session restart safety" subsection (where state lives, what survives)
435. **H** add `docs/STATE.md` — lifecycle of a session from launch → resume → kill
436. **H** add `docs/SUBPROCESS.md` — full wire-format reference for the claude stream-json
437. **H** add `docs/THEMES.md` — how to add a color palette
438. **M** README: include a screencast (asciinema) — recipes/asciinema script
439. **M** add `docs/TROUBLESHOOTING.md` — common gotchas (terminal keys, font, narrow widths)
440. **M** add `docs/PERFORMANCE.md` — what to expect, when to file a perf bug
441. **M** add `docs/SECURITY.md` — disclosure + trust boundaries
442. **M** add `docs/RELEASES.md` — versioning policy
443. **M** add `docs/UPGRADING.md` — migration notes for each minor
444. **M** add JSDoc to every component prop in `tui/`
445. **M** add JSDoc to `Fleet` / `Agent` public methods
446. **M** add JSDoc to every store's exports
447. **L** `Help.jsx` link out to README sections for deeper docs
448. **L** add inline links in code comments to docs paths
449. **L** add a "minimal example" subdir at `examples/` for embedding Fleet without UI
450. **L** add module-level top comments standardizing format (purpose + dependencies + invariants)
451. **L** ensure every TODO in code has a tag matching the global rule (`TODO(short-tag): ...`)
452. **L** add `docs/audit/CHANGES.md` — what changed since last audit
453. **L** add `docs/DESIGN-DECISIONS.md` — log of "we did X because Y"
454. **L** add a glossary: slot, fleet, agent, session, transcript, tail
455. **L** mermaid diagrams for each modal's state machine
456. **L** scope `Theme` and `Settings` JSON schema in their own doc
457. **L** add diagrams of the kill / pause / resume signal flow
458. **L** add a `docs/audit/COVERAGE.md` regenerated each audit pass
459. **L** add a `docs/audit/PERF.md` regenerated from bench runs
460. **L** README badge for test count / coverage / version
461. **L** README "support matrix" — iTerm2, Terminal.app, Ghostty, Alacritty, Kitty, tmux

---

## 10. NEW FEATURES (62)

### 10.1 Safe dev-on-mc workflow (the user's biggest pain) (10)

462. **C** `MC_CONFIG_DIR` env var → isolates settings/sessions/cost from prod mc
463. **C** `mc dev` subcommand → starts mc with sandboxed config + ephemeral state
464. **C** `mc --read-only` flag → don't touch any on-disk state
465. **H** `mc snapshot save <path>` → freeze current fleet state to file
466. **H** `mc snapshot restore <path>` → resume from snapshot file
467. **H** detached daemon mode: `mc-daemon` runs Fleet in background; `mc attach` connects as UI
468. **H** hot-reload of TUI components in dev mode (using `tsx watch`)
469. **M** `:doctor` slash → run env diagnostics + paste-able report
470. **M** `dev` mode banner: red border + "DEV — sandboxed" indicator
471. **M** `tests/recipes/dev-mode.recipes.test.jsx` — PTY test for the workflow

### 10.2 Webhook / inbound trigger (GH issue #2) (6)

472. **H** `mc-listener` companion: localhost HTTP server that pushes events to active mc
473. **H** `:watch <repo>` verb — register a session to react to webhooks for that repo
474. **M** `:webhook test` simulates an inbound event
475. **M** auth model for the local listener (token in `~/.config/claude-mc/listener.token`)
476. **M** transcript label for "triggered by webhook" entries
477. **L** documentation page on the wire format

### 10.3 Cost & budget (6)

478. **H** real-time soft cap: refuse new TURN when projected token cost exceeds remaining budget
479. **H** projected end-of-day spend in StatusBar
480. **M** export `:cost report month` to CSV
481. **M** per-model cost summary in Dashboard
482. **L** `:budget split <%>` apportion daily budget across slots
483. **L** notify when crossing 80% budget

### 10.4 Multi-line composer enhancements (6)

484. **H** auto-grow composer up to N lines, then scroll within
485. **H** preserve composer draft on accidental modal close
486. **H** `Ctrl+Enter` should send while `Enter` newlines (config flag for users who prefer this)
487. **M** `<C-x><C-e>` opens `$EDITOR` for long prompts (mirrors readline)
488. **M** composer markdown syntax tinting (lightweight)
489. **L** drag-paste detection (insert as file mention or text)

### 10.5 Session management (8)

490. **H** `:rename <slot> <name>` to relabel a session
491. **H** `:clone <slot>` duplicate session config to next free slot
492. **H** `:move <from> <to>` swap slots
493. **M** session tags (`:tag 1 review backend`) — filterable
494. **M** `:filter status=waiting`
495. **M** `:save-template <name>` — capture current fleet as template
496. **L** auto-checkpoint every N turns (heavy: opt-in)
497. **L** session export to `.mcsession.json` for sharing

### 10.6 Permissions & guardrails (4)

498. **H** per-tool allowlists in settings (block `bash:rm` etc.)
499. **M** confirm-on-first-`bash` per session
500. **M** detection of secrets in outbound prompts → warn before send
501. **L** PII redaction toggle for transcripts

### 10.7 Observability inside mc (4)

502. **H** `:logs` slash — view recent agent events + structured search
503. **H** `:perf` modal — live metrics (FPS, render time, snapshot rate)
504. **M** `:trace <slot>` records 60s of events to a file for bug reports
505. **L** `:replay <file>` replays a trace into a MockAgent

### 10.8 UX (8)

506. **H** Mouse-mode opt-in (Ink supports `useMouse`?) — scroll wheel in Zoom log
507. **H** Focus indicator: 1-cell colored stripe on the focused card
508. **H** Persistent column for "last response time" in Dashboard
509. **M** Compact mode for ≤80-col terminals
510. **M** Auto-detect dark vs light terminal background, choose default theme
511. **M** Theme preview in `:theme` listing (show first row of card in each)
512. **L** Color-blind-safe theme variants
513. **L** Banner ASCII art splash on first launch (opt-out)

### 10.9 Test infrastructure (5)

514. **H** Visual diffing for Card/Aggregate via stored frames
515. **M** `tests/fixtures/long-session.jsonl` — 10k-turn fixture for perf tests
516. **M** Mock the claude binary entirely (path-based) for end-to-end mc tests
517. **L** Chaos test: random kill+restart while sessions are active
518. **L** Property-based tests for `humanize`, `fmtK`, `fmtMoney`

### 10.10 Misc (5)

519. **M** `:export <slot> <path>` save current transcript jsonl out
520. **M** `:import <path>` rehydrate from transcript jsonl
521. **L** Slack thread per session for triage handoff
522. **L** GitHub Issue creation from `:bug "..."` inside mc
523. **L** Plugin model: drop `.mjs` in `~/.config/claude-mc/plugins/` to register verbs

---

## 11. ACCESSIBILITY & TUI UX (32)

524. **H** focus indicator on modal-internal fields (which input has focus?)
525. **H** Zoom: line/col indicator in composer when multi-line
526. **H** Zoom: keymap legend pinned to bottom (not just on first open)
527. **H** Help modal: searchable (`/`)
528. **H** Settings modal: keyword search across rows
529. **H** Toast levels: error toasts are sticky until dismissed (current auto-dismiss is too fast)
530. **H** Toast: `Esc` dismisses topmost
531. **H** Card: high-contrast variant for low-light theming
532. **M** Card: tabular numbers for token counts (monospace alignment)
533. **M** Card: ellipsis on truncated tail entries (current truncate hides it)
534. **M** Aggregate: visible labels for each cell (currently icon-only in places)
535. **M** Header: dynamic precision on clock (`HH:mm:ss` vs `HH:mm`)
536. **M** StatusBar: persistent latency / FPS indicator (under `:perf`)
537. **M** narrow-terminal fallback: hide aggregate when cols < 80
538. **M** Zoom log: jump-to-first-unread on incoming activity (configurable)
539. **M** FleetLog: ⌥+click (mouse) jump-to-zoom (if mouse mode enabled)
540. **M** Settings: visible "unsaved" indicator (currently auto-saves)
541. **M** Help: per-section anchors with letter shortcuts
542. **M** Broadcast: visible group-of-slots picker (all-working, all-waiting)
543. **L** Card border style settings: round/single/double/heavy
544. **L** Theme: ANSI-256 vs truecolor selection
545. **L** Reduced-motion: disable sparkline animation, blink
546. **L** Aria-like labels (where TUIs support screen-readers via Brltty)
547. **L** Keyboard repeat tuning hint in `:doctor`
548. **L** Confirm-before-overlap: same hotkey in multiple modals — make sure each scope is documented
549. **L** Auto-pause when host laptop battery low (settings opt-in)
550. **L** Auto-pause when host bandwidth drops
551. **L** Voice-over hooks (for accessibility experiments)
552. **L** RTL language consideration for composer
553. **L** Settings: opt-in unicode replacements (ASCII-only mode)
554. **L** Settings: cursor shape (block/bar/underline)
555. **L** Settings: bell-on-notification

---

## 12. OBSERVABILITY & TELEMETRY (24)

556. **H** `forge-logging-architect` pass — define happy/sad heuristics (HANDOFF mentions this is pending)
557. **H** structured log file at `~/.local/state/claude-mc/mc.log` with rotation
558. **H** boot health: log auth+claude+settings status to log file
559. **H** error log: every caught-and-swallowed error gets a log entry
560. **H** opt-in anonymous usage telemetry (with consent prompt)
561. **M** `:diag` toast: produces a single-line health summary
562. **M** `:export-diag` writes a `.zip` with logs + transcripts + settings (PII-stripped)
563. **M** session-level metrics: turns/min, tokens/min, cost/min
564. **M** fleet-level metrics: peak concurrent working, time-to-first-token
565. **M** `:graph` — render an ASCII chart of token rate over last hour
566. **M** key-event histogram (gated by `MC_DEBUG_KEYS`)
567. **M** render-frame histogram (gated by `MC_DEBUG_RENDER`)
568. **M** `:replay <log>` re-runs a session from log for repro
569. **L** OpenTelemetry traces if user opts in
570. **L** Honeycomb / Sentry integration for opt-in error reporting
571. **L** crash-dump on uncaught exception
572. **L** auto-attach last 200 log lines to GH bug template
573. **L** memory snapshot on heap-warning
574. **L** simple `prometheus`-style metrics endpoint (gated)
575. **L** time-budget tracker for each command
576. **L** auto-mute repetitive toasts (>3 in 10s)
577. **L** session-cost forecast accuracy log (compare projection vs actual)
578. **L** wire `forge-usage-listener` to this telemetry source
579. **L** `forge-usage-distiller` to surface improvements

---

## 13. UI / UX POLISH (36)

580. **M** Card focus border distinct color (currently same as theme.accent)
581. **M** Zoom modal title bar: show full session name
582. **M** Composer placeholder text is too long on narrow widths; truncate gracefully
583. **M** Empty-grid hint references `q` to quit — must say `q then y` (fixed today; verify post-restart)
584. **M** Toasts: align right with consistent padding
585. **M** Settings table: 2-column layout in wider terminals
586. **M** Help: highlight current modal context (e.g. dim irrelevant sections)
587. **M** NewSession: render selected model as a chip, not text
588. **M** Dashboard: row-stripe alternate background
589. **M** Card: red highlight on cost cap >90%
590. **M** Card: yellow on context >85%
591. **M** Aggregate: show "TIME BUDGET" if `dayCost > 80% budget`
592. **L** Card: animated dots while `working` (subtle)
593. **L** Card: subtle pulse on awaiting prompt
594. **L** Sparkline: option to use vertical-bar block characters vs dots
595. **L** Header: account name truncation rule
596. **L** Status bar: smoother cmd-buffer rendering
597. **L** Themes: previewable in `:theme list`
598. **L** Themes: per-status accent overrides
599. **L** RepoPicker: visible breadcrumb of current path
600. **L** RepoPicker: filter line (`/` to search)
601. **L** Settings: visible default-value chip next to changed rows
602. **L** Help: collapsible sections
603. **L** Dashboard: cost cap chip per slot
604. **L** Modal `Esc` closes consistently (some modals close on `Esc`, some on `,` — unify)
605. **L** Color-bar in StatusBar for command mode (`:`)
606. **L** First-launch wizard: pick theme, defaults, etc.
607. **L** "What's new" toast on version bump
608. **L** Card: hover-equivalent (focused state) shows extra info
609. **L** Idle agents fade to dim
610. **L** Stuck agents flash on stuckMin transition
611. **L** Zoom log: pretty-print tool outputs (currently raw)
612. **L** Zoom log: collapsible "thinking" blocks
613. **L** Zoom: composer width matches log width for visual alignment
614. **L** NewSession: model search by partial name
615. **L** Animations off in test mode (already partly true; codify)

---

## How to consume this list

- Pick a bucket. Filter by severity (C/H/M/L).
- Each task is small enough for the forge bite-sized contract (≤ 3 files / ≤ 100 LOC).
- If a task expands beyond that during scoping, split it into sub-tasks and append to the bucket.
- Use `forge-task-planner` to graph dependencies for any batch you want to ship together.
- Critical items in buckets 1, 2, 4, 8 are the biggest unblockers for the user's stated frustrations (composer editing, perf, dev workflow).

## 14. STRUCTURAL ASKS FROM 2026-06-09 USER FEEDBACK (12)

Filed verbatim from the dogfooding session. Big-ticket items that need
design before implementation; some overlap with earlier buckets.

616. **C** **Split-pane Zoom layout** — composer at TOP of screen with caret, scrollable log in middle box, optional notes panel on the right. Today everything is one column with composer at bottom. Needs `<ZoomLayout>` rewrite (see refactor #352).
617. **H** **Right-side task panel in Zoom** — per-session task list. Backing store TBD: GitHub Issues / forge tasks / local `tasks/<session-id>/`. Question for user.
618. **H** **Hotkey to open tasks for focused session** — pairs with #617. Suggest `T` (capital) or `:tasks`.
619. **H** **Ctrl+T = 3-state toggle** — currently 2-state (show/hide tool events). User wants: detailed view ↔ user-output view ↔ both, with a persistent panel listing ALL user commands sent in the session.
620. **H** **User-command history panel** — runs alongside the log, never clears, even when ctrl+T toggles tool visibility. Maps to #619.
621. **H** **Plugin slash commands** — drop a `.mjs` in `~/.config/claude-mc/plugins/` to register a verb (`/forge-goal`, `/forge-init`). Sketch: pluginStore.js with a registry, hot-reload optional.
622. **H** **Forge command integration** — first-class support for `/forge-goal <one-liner>`, `/forge-status`, `/forge-init`, `/forge-deploy`, `/forge-improve`. Implementation could be #621 (plugin layer) or hardcoded.
623. **M** **Markdown rendering in log** — model output is hard to read. Pretty-print headings, lists, code blocks. Tracked elsewhere (#611) but worth elevating.
624. **M** **Card overflow / overlap on narrow terminals** — fixed in this session (grid math now auto-reduces column count). Verify in real terminal at 80 cols.
625. **M** **`:transcript` / `:where` verbs** — surface where the on-disk JSONL transcript lives so users know they HAVE a persistent record. Shipped this session.
626. **M** **Survivor sessions banner on boot** — if previous mc was killed mid-session, show a toast "X sessions to resume — try :resume-all" instead of the silent boot. Already shipped, verify visibility.
627. **C** **Hot reload of mc itself** — restart-free dev. Today: kill mc, edit, restart, `:resume-all`. Wanted: tsx-watch picks up the change and re-renders without losing sessions. Hard — Fleet state would need to survive a re-import.

## Recommended first wave

If you can only do 10 things this week, do these:

1. #1-9 — Cursor positioning in TextField (the user is typing blind)
2. #57 — Kill the App.jsx re-render loop
3. #380-382 — `MC_CONFIG_DIR` so dev-on-mc is safe
4. #321 — Wire orphan slash commands (no false advertising)
5. #383 — Boot banner with version + git SHA
6. #126 — Fix Agent.send respawn race
7. #160 — Backup pattern on sessionStore writes
8. #244-258 — Hotkey test coverage (single shot, big leverage)
9. #338-346 — App.jsx hook extraction (unblocks further work)
10. #424-430 — Doc the actual surface (no more drift)
