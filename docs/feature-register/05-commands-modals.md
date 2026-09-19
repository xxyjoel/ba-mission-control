# Feature register 05 — commands and modals

Every way a user tells Mission Control to do something: the fleet-view hotkeys,
the `:` command verbs, the command bar itself, the filter, focus movement,
pagination, and the modal screens.

Audited 2026-09-19 against `main` at `f2fda14`.

## How to read the evidence column

| Label | What it means |
|---|---|
| **Drove it** | The app was rendered and the key or command was pressed. The quoted text is what the screen actually said. |
| **Traced** | Walked through the code with file and line for each hop. Not run. |
| **Test only** | A unit test passes. That pins today's behaviour, not correctness — several tests in this repo were found pinning the defect. |
| **Unverified** | Not established. No guess offered. |

The app was driven with the fake fleet (`tests/lib/fakeFleet0408.js`) at a
controlled terminal size (`tests/lib/render-size.js`), settings sandboxed to a
scratch directory. No real `claude` was started. Three verbs shell out to real
programs and were deliberately not run: `:model refresh` (a billed probe),
`:update` and `:whoami` (spawn `claude`). `:tasks` was run because it only
spawns `gh`, which is read-only.

The three documented sources cross-checked are `README.md`, the in-app Help
screen (`tui/modals/Help.jsx`), and `docs/HOTKEYS.md`.

---

## Table 1 — hotkeys

Most rows are the fleet view, with no modal open. The last six rows apply
while the command bar or filter bar is open, which takes priority over
everything else.

| Key | Documented as | Actually does | How I know |
|---|---|---|---|
| `?` | README:323 "Help"; Help.jsx:56 "Help" | Opens the Help screen | Drove it. Frame showed `━━ KEYBOARD ━━  (1-40/75)`. |
| `,` | README:314 "Settings menu"; Help.jsx:99 "Open settings menu esc (or ,)" | Opens Settings | Drove it. Frame showed `⚙ SETTINGS`. |
| `Esc` | README:313 "Open settings menu (or close current overlay)"; Help.jsx:99 same. **But** Help.jsx:22 also lists `esc` under NAVIGATION as "Defocus / close overlay" | Opens Settings. There is no "defocus" behaviour in the fleet view. | Drove it. Pressing `Esc` with no modal open rendered `⚙ SETTINGS`. Help.jsx:22 is wrong for this view. |
| `b` / `B` | README:315 "Broadcast modal" | Opens Broadcast | Drove it. Both cases rendered `━━ BROADCAST ━━`. |
| `d` / `D` | README:316 "Fleet dashboard". **Absent from Help.jsx** | Opens the Dashboard | Drove it. Both cases rendered `━━ FLEET DASHBOARD · 3 live`. Help.jsx has no `d` row — grep for `dash` in that file returns nothing. |
| `!` | README:322 "Open shell overlay"; README:398-406 describes it, including a `cd` into the focused card's directory | Opens the shell overlay. The `cd`-on-focus is **not established**. | Drove the open. Frame showed `shell · zsh · /Users/joelproctor` and the footer `⌃Q close · all other keys → shell` — the **home** directory, not the focused card's cwd, which was set elsewhere in that run. The `cd` is a deferred call (App.jsx:1491) into `cdToCwd`, which no-ops unless the shell sits at a fresh prompt; traced, and not observed happening. |
| `Shift+L` | Help.jsx:53 "Fleet log: all ↔ narrative". **Absent from README entirely** | Flips the fleet log between `all` and `narrative` and saves the choice | Drove it. One press toasted `fleet log → all`; a second toasted `fleet log → narrative`. `grep -n "Shift+L" README.md` returns nothing. |
| `q` / `Q` | README:326 "Quit — opens a confirm"; Help.jsx:100 "q → confirm modal" | Opens the quit confirm screen | Drove it. Both cases rendered `Quit mc?`. |
| `/` | README:324 "Filter … Press `/` again to clear" | With no filter set, opens the filter bar. With a filter set, clears it. | Drove it. `/` then `repo` showed the status chip `─ FILTER ─  /repo█`. `/`, `repo-1`, Enter, `/` toasted `filter: repo-1  (/ to clear)` then `filter cleared`. |
| `:` | README:325 "Command bar" | Opens the command bar | Drove it. Status chip changed to `─ : ─` with a live buffer. |
| `1`–`9`, `0` | README:311 "Jump to slot 1–10 (slots 11+ via arrow nav or `:goto <slot>`)" | Focuses that slot; `0` means slot 10 | Drove it. `2` moved the status bar to `[2] repo-2`; `0` on a fleet with slot 10 live moved focus there. |
| `←` / `h` | README:309; Help.jsx:18 | Moves focus one card left, wrapping | Drove it. `l` then the frame's bold border moved from card 1 to card 2. `h` is gated on the Vim-keys setting (App.jsx:1542), on by default. |
| `→` / `l` | README:309; Help.jsx:18 | Moves focus one card right, wrapping | Drove it (same run as above). |
| `↑` / `k` | README:309; Help.jsx:18 | Moves focus up one grid row. Clamped, not wrapping. | Traced: App.jsx:1544. Driven only as a no-op at the top row, which is the safety case below. |
| `↓` / `j` | README:309; Help.jsx:18 | Moves focus down one grid row. Clamped. | Traced: App.jsx:1545. |
| `[` / `]` | README:312 "Switch to the previous / next pane — only when the grid pages"; Help.jsx:20 | Moves focus to the first card of the adjacent pane. Does nothing when the grid fits one pane. | Drove it. With 8 cards in a 24-row terminal the footer read `pane 1/2 · [ ] to switch panes`; after `]` it read `pane 2/2` and focus moved to `[6] repo-6`. |
| `↵` (Enter) | README:310 "Zoom focused session — or open New Session if nothing is live" | Exactly that | Drove it. On a live card the frame became the zoom view (`[1] repo-1  ⎇ main ●clean`, footer `⌃Q exit · ⌃J newline · ⌃Y scroll · ⌃K tools · ⌃U stats`). With no live sessions it opened New Session. |
| `n` | README:317 "New session"; Help.jsx:25 "n · ctrl+n" | Opens New Session on the next free slot | Drove it. Rendered `━━ NEW SESSION · slot [4]`. With all 10 slots full it toasted `all 10 slots occupied — kill one first`. |
| `Ctrl+N` | README:317 | Opens New Session | Drove it. Rendered `━━ NEW SESSION · slot [3]`. |
| **`N` (plain Shift+N)** | **README:317 lists it: `n` / `N` / `Ctrl+N`** | **Nothing. It is not bound.** | **Drove it. The frame stayed on the fleet grid, no modal, no toast — with live sessions and with none. App.jsx:1596 binds `input === 'n'` or Ctrl plus `n`/`N`; the comment at App.jsx:1593 says Shift+N is deliberately left free.** |
| `p` / `P` | README:318 "Pause (SIGSTOP)" | Pauses the focused session and says so | Drove it. Toast: `paused slot 1 · r to resume`, and the fake agent recorded a `pause` call. With no live focus: `no live session focused`. |
| `r` / `R` | README:318 "Resume (SIGCONT)" | Resumes the focused session — **silently**. No toast on success and none on failure. | Drove it. The fake agent recorded `resume(SIGCONT)` but the toast list was unchanged. With no live focus, nothing at all happened. Its partner `p` toasts in both cases (App.jsx:1617, 1622). |
| `K` (uppercase) | README:319 "Kill — uppercase only … armed by first press (3s window); confirms on second `K`". **docs/HOTKEYS.md:38 still says `k` / `K`** | Arms on the first press, kills on the second | Drove it. First press: `press K (shift+k) again to kill slot 1 · cancels in 3s`. Second press: `killed slot 1` and a recorded `kill`. With no live focus: `no live session focused — arrow keys to pick one`. |
| `k` (lowercase) | README:319 says it "stays vim-up and never kills". docs/HOTKEYS.md:38 says it kills. | Vim-up only. When that move is a no-op it falls through and does nothing. | Drove it. `k`,`k` on a single card produced no arm toast and no kill call. docs/HOTKEYS.md:38 is stale. |
| `a` / `A` | README:320 "Approve … Only accepted while the session is **waiting**" | Sends the continue turn only when the session is waiting; otherwise warns | Drove it. On an idle card: `slot 1 is idle — approve only applies when waiting for input`, no approve call. On a waiting card: `approve → slot 1` and a recorded `approve`. |
| `Shift+Tab` | README:321 "Cycle focused session's permission mode: plan → auto → acceptEdits" | Exactly that | Drove it. Toast `permission: plan` and a recorded `perm` call with `plan`. With no live focus: `no live session focused`. |
| `Ctrl+C` | README:327 "Quit immediately (treated as no save)" | Ink exits the app | Traced: `exitOnCtrlC: true` at tui/main.jsx:179, plus a `SIGINT` shutdown handler at tui/main.jsx:232. Not driven — the harness disables Ctrl+C. |
| `Ctrl+Q` (shell overlay open) | README:403 "Close: Ctrl+Q"; Help.jsx:52 | Closes the shell overlay. The shell process stays warm. | Drove it. `!` then Ctrl+Q returned to the fleet grid. A second handler at App.jsx:1463 exists as a backstop so a half-unmounted overlay can never trap the user. |
| `Esc` (command bar open) | Status bar shows `↵ run · esc cancel`. Not in README or Help. | Cancels and clears the buffer | Drove it. `:`, `quit`, Esc returned to `─ NORMAL ─` with nothing run. |
| `↵` (command bar open) | Status bar `↵ run` | Runs the command, or applies the filter | Drove it throughout Table 2. |
| `Backspace` / `Delete` (command bar open) | Not documented | Deletes the last character | Drove it. `:`, `themx`, Backspace, `e`, ` Matrix` produced the buffer `:theme Matrix`. |
| Printable text (command bar open) | Not documented | Appends a whole run of text, not one character. Line breaks collapse to a space. | Drove it. Writing `note one\ntwo` in one chunk produced the buffer `:note one two`. Normalisation lives in tui/lib/typedText.js. |
| `←` / `→` (command bar open) | Not documented | **Nothing.** There is no cursor in this bar — text only ever appends at the end. | Drove it. `:`, `abc`, `←`, `X` produced `:abcX`, not `:abXc`. |
| `Ctrl+U` / `Ctrl+W` (command bar open) | Not documented | Nothing. Both are dropped. | Drove it. `:`, `abc`, Ctrl+U left the buffer at `:abc`. App.jsx:1451 excludes anything carrying Ctrl or Meta. |

---

## Table 2 — command verbs

One row per case label in the dispatch table at `tui/App.jsx:612-1418`. There
are **63 labels**. A clean scan of the switch (comment lines excluded) finds
**no duplicate labels** — the twin `case 'resume'` that made selective restore
unreachable was fixed and the fix is described in the comment at App.jsx:1014.

| Verb | Documented as | Actually does | How I know |
|---|---|---|---|
| `:q` | Nowhere | Exits | Drove it. The app unmounted; the frame went empty. App.jsx:617. |
| `:quit` | README:434 "Exit"; Help.jsx:96 | Exits | Drove it. Same as above. |
| `:theme <name>` | README:413 "Cycle palette (any substring match)"; Help.jsx:59 | Case-insensitive substring match against the palette names; with no argument it names the current one | Drove it. `:theme Matrix` → `theme → Matrix`. `:theme gruv` → `theme → Gruvbox Dark`. `:theme` alone → `current theme: BlueArch`. `:theme wibble` → `no theme matches "wibble"`. |
| `:cols 3\|4\|5` | README:414; Help.jsx:60 | Sets grid columns; rejects anything else | Drove it. `:cols 4` → `grid → 4 columns`. `:cols 9` → `cols must be 3, 4, or 5`. |
| `:goto <slot>` | README:311 "slots 11+ via arrow nav or `:goto <slot>`"; Help.jsx:61 | Focuses any slot the fleet actually has, including past 10 | Drove it, including on a 20-slot fleet: `:goto 12` moved the status bar to `[12] repo-12`. Out of range: `slot out of range — fleet has 10 slots`. |
| `:jump <slot>` | Nowhere | Same case block as `:goto` | Drove it. `:jump 2` moved focus to `[2] repo-2`. App.jsx:639-640. |
| `:model` | README:416; Help.jsx:77 | With a live card, reports requested vs resolved model and flags a mismatch. With none, lists the catalog. | Drove it. `slot 1 · requested claude-sonnet-4-6 (claude-sonnet-4-6) · resolved (pending init)`. With no live session: `available · opus-4.8 · … · :model refresh to re-probe`. |
| `:model <id>` | README:417 "Switch the focused session's model live (restarts the subprocess)" | Exactly that | Drove it. `:model sonnet-4.6` → `model: sonnet-4.6 (restarting session)` and a recorded `model` call. Unknown id: `unknown model · use one of: …`. |
| `:model default <id>` | README:418; Help.jsx:79 | Sets the fleet default for new launches; also accepts `auto` | Drove it. `:model default sonnet-4.6` → `default model → sonnet-4.6`. |
| `:model refresh` | README:419; Help.jsx:80 "probe live models (billed ~$0.10/ea)" | Probes each alias with a real billed turn, caches the result | Traced only: App.jsx:660-686. Deliberately not run — it spends money and starts `claude`. |
| `:perm <mode>` | **README:415 says "Set default permission mode"** — wrong. Help.jsx:62 says "change focused session's mode (live)" — right. | Changes the **focused live session**, not the default | Drove it. `:perm plan` recorded a `perm` call against slot 1 and toasted `permission: plan`; the default was untouched. App.jsx:743-751. |
| `:perm default <mode>` | Help.jsx:63. Not in README's command table. | Changes the fleet default | Drove it. `default permission → plan`. |
| `:permission …` | Nowhere | Same case block as `:perm` | Drove it. `:permission plan` recorded the same `perm` call. App.jsx:722-723. |
| `:clear` | Not in README as a `:` verb (README:215 mentions `/clear` in prose). Help.jsx:87. | Kills the focused session and relaunches a fresh one in the same slot | Drove it. Recorded `kill` then `launch` with the same cwd, model and permission mode; toast `slot 1 cleared — fresh session`. |
| `:restart` | Nowhere in README. Help.jsx:87. | Same case block as `:clear` | Drove it. Identical calls and toast. App.jsx:755-756. |
| `:compact [focus]` | Not in README as a `:` verb (README:301 names `/compact` in prose). Help.jsx:85. | Sends a summary request to the focused session. Does not restart it. | Drove it. Recorded a `send` carrying "Please provide a concise summary of our conversation so far in 3-5 paragraphs…"; toast `compact: asked slot 1 for a summary — review then optionally /clear`. |
| `:compact-restart [focus]` | README:301 names `/compact-restart` in prose but never says how to run it. Help.jsx:86 gives `(or :cr)`. **tui/lib/plugins.js:23 tells the user to type `/compact-restart` in a Zoom composer, which cannot work.** | Sends the summary request, waits up to 2 minutes for a reply longer than 50 characters, then kills and relaunches with the summary injected. Gated on the `plugin_compactRestart` setting (on by default). | Drove the first half. Recorded a `send` with the summary prompt; toast `compact-restart: waiting for summary on slot 1…`. The kill-and-relaunch half is traced only (App.jsx:836-862) — it needs a real reply. |
| `:compactrestart` | Nowhere | Same case block | Traced: App.jsx:805. |
| `:cr` | Help.jsx:86 | Same case block | Drove it. Identical `send` call and toast. |
| `:remember "<note>"` | Not in README. Help.jsx:88. | Appends a dated note to `<focused cwd>/.mc/MEMORY.md` and echoes it into the session tail. Gated on `plugin_projectMemory` (on by default). | Drove it. Toast `remembered (198b) · …/MEMORY.md` against a scratch directory. No argument: `usage: :remember "<short note about the project>"`. |
| `:rem` | Help.jsx:88 | Same case block | Drove it. Second note appended, `remembered (231b)`. |
| `:memory` | Not in README. Help.jsx:89. | Dumps the repo's memory file into the session tail | Drove the empty case: `no project memory at …/MEMORY.md (use :remember "X" to seed)`. The populated path is traced: App.jsx:903-911. |
| `:mem` | Help.jsx:89 | Same case block | Drove it. Identical toast. |
| `:mcp` | Not in README. Help.jsx:90. | Lists MCP servers from `~/.claude/.mcp.json` and `<cwd>/.mcp.json`. Gated on `plugin_mcpAware` (on by default). | Drove it. `no MCP servers in ~/.claude/.mcp.json or …/.mcp.json`. |
| `:kill [slot]` | README:420 "Kill focused (or specified) session"; README:319 adds that it "follows the same arm/confirm flow"; Help.jsx:64 | Arms on the first call, kills on the second. Rejects an out-of-range slot instead of retargeting. Honours fleets larger than 10. | Drove it. `:kill` → `press K (or :kill 1) again to confirm · or :kill! 1`; a second `:kill` → `killed slot 1`. `:kill 99` → `slot out of range — use :kill <1-10> or :kill for the focused session`. On a 20-slot fleet, `:kill 12` armed correctly. |
| `:kill!` / `:kill !<n>` | README:319 "`:kill! <slot>` bypasses"; Help.jsx:31 | Kills with no confirm, in both the bang-on-verb and bang-on-argument forms | Drove both. `:kill! 1` and `:kill !1` each recorded a `kill` and toasted `killed slot 1`. |
| `:pause` | README:421; Help.jsx:64 | Pauses the focused session | Drove it. Recorded `pause`; toast `pause slot 1`. |
| `:note <text>` | README:430; Help.jsx:92 | Adds a local annotation to the focused session's log; never sent to claude | Drove it. Recorded `note` with the text; toast `note added to slot 1`. No argument gives a usage line. |
| `:n <text>` | README:430; Help.jsx:92 | Same case block as `:note` | Drove it. `:n hello` recorded `note` with `hello`. |
| `:approve` | README:422 "Same as the `A` hotkey — only accepted while **waiting**". **Absent from Help's command list.** | Approves only when the session is waiting | Drove it. Idle: `slot 1 is idle — approve only applies when waiting for input`, nothing sent. Waiting: `approve → slot 1`. |
| `:a` | README:422 | Same case block | Drove it. Identical warn on an idle session. |
| **`:resume <slot ...>`** | README:342 and README:423 "Restore **specific** slots — e.g. `:resume 1 3 5`"; Help.jsx:65 | **A slot number outside 1–10 is silently dropped, and the verb then falls into its bare-argument branch: it SIGCONTs the focused session and toasts success naming a slot the user never typed.** Valid slots 1–10 work. | **Drove it. `:resume 99`, `:resume 0`, `:resume abc` and `:resume 11` each recorded `resume(SIGCONT)` against slot 1 and toasted `resume slot 1`. On a 20-slot fleet, `:resume 12` did the same. The filter is App.jsx:1026-1031.** Valid case driven too: `:resume 1` → `no saved session for slot 1`; `:resume 3 4 5` → `resumed 0/3 · 3 unknown`. |
| `:resume` (bare) | README:342 "resumes (SIGCONT) the focused **live** session … or, when the focused slot is empty, restores that slot's saved record"; Help.jsx:64 | Exactly that | Drove it. With a live card focused: recorded `resume(SIGCONT)` and `resume slot 1`. With focus on a different live slot: `resume slot 2`. |
| `:resume-all` | README:341; Help.jsx:66 | Restarts the sessions open at last close, staggered | Drove the empty case: `no saved sessions to resume`. The populated path is traced: App.jsx:1074-1082 into `resumeAllSessions` at App.jsx:1819. |
| `:history [n]` | README:343 "**View-only** browse … Never bulk-restores"; Help.jsx:67 | Toasts a header plus one line per session; restores nothing | Drove the empty case: `no session history yet`. The populated path is traced: App.jsx:1090-1099. |
| `:hist` | Nowhere | Same case block | Drove it. Identical toast. App.jsx:1086. |
| **`:forget <slot>`** | README:345 and README:425 "Drop one slot's saved state"; Help.jsx:68 | **Hard-capped at slot 10 even though the fleet can hold up to 64 (tui/lib/settings.js:125).** | **Drove it. `:forget 3` → `forgot saved session for slot 3`. On a 20-slot fleet, `:forget 12` → `forget <slot 1-10>`. The bound is App.jsx:1103.** |
| `:sessions` | README:344 and README:424; Help.jsx:68 | Toasts up to four saved sessions | Drove the empty case: `no saved sessions`. Populated path traced: App.jsx:1110-1114. |
| `:ls` | README:344 lists it as an alias. Absent from Help. | Same case block | Drove it. Identical toast. App.jsx:1109. |
| `:help` | Nowhere | Opens the Help screen | Drove it. Frame became `━━ KEYBOARD ━━`. App.jsx:1117. |
| `:?` | Nowhere | Same case block | Drove it. Identical frame. App.jsx:1118. |
| `:version` | Absent from README's command table. Help.jsx:81. | Toasts the running build | Drove it. `mc 1.1.14 · gf2fda14 · dirty`. |
| `:ver` | Help.jsx:81 | Same case block | Drove it. Identical toast. |
| `:update` | README:427 "Report claude version drift"; **absent from Help** | Compares the on-disk `claude --version` with the version each live session launched on | Traced only: App.jsx:1126-1154. Not run — it spawns `claude`. |
| `:transcript` | Absent from README. Help.jsx:82. | Toasts the transcript path for the focused session. **When the session id is not a canonical UUID it prints the literal word `null`.** | Drove both. With a real UUID: `transcript · ~…/0123abcd….jsonl`. With a non-UUID id: `transcript · null`. The guard returns null at server/agent.mjs:50-53; App.jsx:1164 interpolates it unchecked. |
| `:tx` | Help.jsx:82 | Same case block | Drove it. Identical toast in both cases. |
| `:log` | Help.jsx:82 | Same case block | Drove it. Identical toast. |
| `:tasks` | Absent from README. Help.jsx:91. | Fetches the focused repo's open GitHub issues through `gh` | Drove it. Outside a repo it toasted `fetching tasks for repo-1…` then `tasks · Command failed: gh issue list … not a git repository`. The success path is traced: App.jsx:1181-1193. |
| `:todo` | Help.jsx:91 | Same case block | Traced: App.jsx:1172. |
| `:t` | Help.jsx:91 | Same case block | Drove it. Identical `gh` failure toast. |
| `:debug-keys [on\|off\|status\|clear\|path]` | Absent from README. Help.jsx:84. | Toggles the raw key recorder and shows a `● REC keys` chip in the status bar | Drove it. `:debug-keys` → `debug-keys · off · log …/debug-keys.log`. `:debug-keys on` → `debug-keys ON · logging to …` and the chip appeared in the status bar. Bad sub-command → `usage: :debug-keys [on\|off\|status\|clear\|path]`. |
| `:debugkeys` | Nowhere | Same case block | Traced: App.jsx:1206. |
| `:dk` | Nowhere | Same case block | Drove it. `:dk path` → `debug-keys log · …/debug-keys.log`. |
| `:where` | Absent from README. Help.jsx:83. | Toasts the config directory and the focused session's transcript path. **Same unguarded `null` as `:transcript`.** | Drove both. With a UUID: `config · …/cfg2` and `transcript · ~…/0123abcd….jsonl`. Without: `transcript · null`. App.jsx:1241. |
| `:whoami` | README:428; Help.jsx:70 | Re-probes `claude auth status` and toasts the account | Traced only: App.jsx:1247-1253. Not run — it spawns `claude`. |
| `:auth` | README:428; Help.jsx:70 | Same case block | Traced: App.jsx:1248. |
| `:dash` | README:644 heading "Fleet dashboard (`D` or `:dash`)". Absent from Help's command list. | Opens the Dashboard | Drove it. Frame became `━━ FLEET DASHBOARD`. |
| `:dashboard` | Nowhere | Same case block | Drove it. Identical frame. App.jsx:1256. |
| `:template [name] [cwd]` | README:681-701; Help.jsx:76 | With no argument lists templates; with a name launches the bundle into free slots | Drove the list: `templates: review(3), explore(2), spec-then-implement(2)`. Unknown name: `no template "nope" · :template lists available`. The launch path is traced: App.jsx:1276-1300. |
| `:tpl` | Help.jsx:76 | Same case block | Drove it. Identical listing. |
| **`:cap <slot> <usd>`** | README:669 "`:cap <slot> <usd>` rejects further user messages to that slot"; Help.jsx:73 | **Hard-capped at slot 10 even though the fleet can hold up to 64.** | **Drove it. `:cap 1 5` → `slot 1 cap → $5.00`. On a 20-slot fleet, `:cap 12 5` → `usage: :cap <slot 1-10> <usd>`. The bound is App.jsx:1319.** |
| `:cap default <usd>` | README:670; Help.jsx:74 | Sets the fleet-wide default cap | Drove it. `default cost cap → $3.00`. No argument shows the current value. |
| `:budget <usd>` | README:674-676; Help.jsx:75 | Sets the daily spend budget; `0` disables; bare shows today's spend | Drove all three. `today: $0.00 · no budget set`, `daily budget → $25.00`, and `usage: :budget <usd>  (0 disables)` for a non-number. |
| `:cost` | **Absent from README.** Help.jsx:72. | Toasts the focused session's cost and the fleet week | Drove it. `cost · session $0.01  ·  fleet week $0.03`. |
| `:usage` | README:429; Help.jsx:71 | Re-reads the plan rate-limit file and toasts the 5h and 7d figures | Drove it. `5h: 0%  (resets in ?)` and `7d: 61%  (resets in 5d 23h)`. |
| `:repos` | README:426; Help.jsx:69 | Opens the folder picker | Drove it. Frame became `━━ PICK REPO LOCATION` with `browsing ~`. |
| `:repos clear` | README:426 "resets to defaults"; Help.jsx:69 | Resets the scan locations. Also accepts `reset` and `off`. | Drove it. `repo locations reset to defaults`. |
| `:slack <url>` | README:431; Help.jsx:93 | Stores the webhook after checking the prefix; `clear` or `off` removes it | Drove all three. Bare: `no slack webhook — usage: :slack <https://hooks.slack.com/...>`. Bad host: `webhook url must start with https://hooks.slack.com/`. Good: `slack webhook configured — try :feedback <message>`. |
| `:feedback <msg>` | README:432; Help.jsx:94 | Posts the message plus auth, fleet and usage context to the webhook | Drove it. With no webhook: `no slack webhook — configure with :slack <url>`. With one set: `sending feedback…` followed by the post result. |
| `:request <msg>` | README:433; Help.jsx:95 | Same case block, different `kind` field | Drove it. `sending request…` then `slack post failed · no_team` from the dummy webhook. |
| _(anything else)_ | — | `unknown command: <verb>` | Drove it. `:zzznotaverb` → `unknown command: zzznotaverb`. Also confirmed `:recall` and `:rec` are **not** verbs, despite tui/lib/plugins.js:44 and tui/lib/plugins.js:47 advertising `:recall <q>`. |

---

## Table 3 — modals and input surfaces

| Feature | Expected to do | Does it? | How I know |
|---|---|---|---|
| **Help** (`tui/modals/Help.jsx`) | Show the whole keymap in a window that scrolls, closing on `Esc` | Yes | Drove it. Opened at `(1-40/75)`; `j` three times → `(4-43/75)`; `G` → `(36-75/75)`; `g` → back to `(1-40/75)`; Space paged down; `Esc`, `?` and `Enter` each closed it. `↑`/`k` and PgUp/PgDn are traced only (Help.jsx:135-140). |
| Help — "CURRENT VIEW" highlight | Highlight the section matching the surface the user came from | **No. It is permanently stuck on the main-view sections.** | Drove it: `▶ NAVIGATION · CURRENT VIEW` and `▶ SESSIONS · CURRENT VIEW`, with both ZOOM sections plain. Traced the cause: `helpView` is created at App.jsx:162 and read at App.jsx:1938, but `setHelpView` is never called anywhere in the file. |
| Help — coverage | Match the keys the app binds | Mostly. **No row for `d`/`D` (Dashboard).** One row is wrong for its own view: Help.jsx:22 lists `Esc` as "Defocus / close overlay" under NAVIGATION, but `Esc` opens Settings. | Drove the `Esc` case (frame showed `⚙ SETTINGS`). The missing `d` row: `grep -in "dash" tui/modals/Help.jsx` returns nothing. |
| **QuitConfirm** (`tui/modals/QuitConfirm.jsx`) | `[s]` or Enter saves and quits, `[d]` quits without saving, `[n]` or `Esc` cancels, every other key is ignored | Yes | Drove it. The frame showed all three choices. `n` and `Esc` returned to the grid; `d` and `s` unmounted the app. **`y` was ignored** — the modal stayed open. |
| QuitConfirm — in-app instructions | Tell the user the right keys | **No. The Settings NOTES tab says `q  then  y  quit mc`.** `y` does nothing. | Drove both halves: the NOTES tab rendered `q  then  y  quit mc (sessions auto-save before exit)`, and `q` then `y` left the confirm open. Source: `NOTES_BODY` at tui/modals/Settings.jsx:58. |
| **Broadcast** (`tui/modals/Broadcast.jsx`) | Type one message, pick targets, send to all of them | Yes | Drove it. Opened at `targets: 3/3`. Text plus Enter armed (`send to 3 sessions? ↵ again to confirm · esc cancel`); a second Enter recorded a `broadcast` call to all three ids and toasted `broadcast → 3 sessions`. |
| Broadcast — two-step confirm | First Enter arms, second sends; editing disarms | Yes | Drove it. After arming, typing `x` then Enter re-armed instead of sending, and no broadcast call was recorded. |
| Broadcast — target chips | `Tab` cycles chips, Space toggles one, `a` toggles all | Partly. `Tab` and Space work. **`a` only toggles all once Tab has moved focus off the text box** — pressed from the default focus it just types the letter `a`, even though the modal header advertises `[a] toggle all`. | Drove it. `b`, Tab, Space → `targets: 2/3`. `b`, `a` → `targets: 3/3` (unchanged). `b`, Tab, `a` → `targets: 0/3`. The gate is `if (!inText)` at tui/modals/Broadcast.jsx:63. |
| Broadcast — empty message | Send nothing | Yes | Drove it. Enter twice on an empty box neither armed nor sent. |
| **Settings** (`tui/modals/Settings.jsx`) | Tabbed editor over the settings schema, saving to disk | Yes | Drove it. Opened on `[1] GENERAL … [8] NOTES`. `Tab` advanced a tab, `Shift+Tab` wrapped back to NOTES, digits `1`–`8` jumped directly (`3` showed `Color theme ◀ BlueArch ▶`). `Esc` and `,` both closed it. |
| Settings — row editing | Arrows change a value, `j`/`k` move between rows | Yes | Drove it with before/after frames. `→` took `Update rate` from `800 ms` to `900 ms`; `←` took it back; `j` moved the `▶` marker from `Update rate` to `Git status poll`. |
| Settings — Space and Enter | Toggle the highlighted switch | Yes, and more: on a number or cycle row they nudge the value one step, not just flip a switch. Undocumented. | Drove it. Space on the `Update rate` row moved it `700 ms` → `800 ms`; Enter moved it `900 ms` → `1000 ms`. Source: the `key.return \|\| input === ' '` branch at tui/modals/Settings.jsx:180 calls the same `cycle()` as the arrows. |
| **Dashboard** (`tui/modals/Dashboard.jsx`) | One sortable row per slot for triage | Yes | Drove it. Header `━━ FLEET DASHBOARD · 3 live … sort: slot ↓`. `s` → `sort: status ↓`, again → `sort: ctx ↓`. `r` → `sort: slot ↑`. `d` and `Esc` closed it. Enter opened the zoom view for the highlighted row. Its own footer reads `↑↓ select · ↵ zoom · S sort · R reverse · D/esc close`. |
| **RepoPicker** (`tui/modals/RepoPicker.jsx`) | Browse folders and pick one as the repo scan root | Yes | Drove it via `:repos`. `→` descended from `~` to `/Users`; `←` ascended to `/`; `j` moved the `▶` marker; `.` picked the browsed folder and toasted `repo location → ~`; `Esc` closed it. |
| **NewSession** (`tui/modals/NewSession.jsx`) | Filter repos by typing, pick with arrows, launch with Enter | Yes | Drove it. Opened as `━━ NEW SESSION · slot [4]`. `Tab` switched the footer from `tab focus [path] · arrows = cursor` to `tab focus [list] · ↑↓ pick · ← → model`. `↓` auto-switched to the list. `Ctrl+B` opened the folder browser (`━━ PICK REPO LOCATION`). `Esc` closed it. |
| NewSession — model cycling | Help.jsx:28 says "In NewSession · cycle model ← →" | Only while the list has focus. In the path box the arrows are the text cursor. The modal's own footer says this; Help's row does not. | Drove it. With Tab pressed first, `→` moved `model ◀ OPUS 4.8 ▶` to `OPUS 4.7`. Without Tab, the same key left it at `OPUS 4.8`. |
| **Zoom** (`tui/modals/Zoom.jsx`) — as a modal boundary | Open on Enter over a live card, close on `Ctrl+Q` | Yes | Drove it. Enter rendered `[1] repo-1  ⎇ main ●clean` with the footer `⌃Q exit · ⌃J newline · ⌃Y scroll · ⌃K tools · ⌃U stats`; `Ctrl+Q` returned to the grid. The keys **inside** the zoom body belong to the zoom register, not this one, and were not audited here. |
| **ShellOverlay** (`tui/modals/ShellOverlay.jsx`) | A persistent shell pane; only `Ctrl+Q` is intercepted | Yes | Drove it. `!` rendered `shell · zsh · /Users/joelproctor` and the footer `⌃Q close · all other keys → shell · avoid fullscreen apps (vim/less) here`; `Ctrl+Q` closed it. The keep-warm and `cd`-on-focus behaviour is traced only (App.jsx:1486-1494). |
| **Command bar** (`:`, App.jsx:1425-1455) | Type a command and run it | Yes, but it is a much smaller editor than the modals' text field — append and backspace only. Neither README nor Help says so. | Drove it. Backspace works; `←`/`→`, `Ctrl+U` and `Ctrl+W` do nothing; a pasted or dictated run arrives whole and its line breaks become spaces. Compare `tui/lib/TextField.jsx:4-11`, which offers cursor motion, Home/End, word jumps, insert-at-cursor and multi-line editing. |
| **Filter mode** (`/`) | Type a substring; non-matching cards dim; `/` clears | Yes | Drove it. Status chip `─ FILTER ─  /repo█` while typing; Enter toasted `filter: repo-1  (/ to clear)` and left a `filter /repo-1 (/ to clear)` chip in the status bar; a second `/` toasted `filter cleared`. Matching covers name, branch, model and status (App.jsx:550-557) — confirmed by filtering on `idle`, which matched. |
| **Focus movement** | Arrows and `hjkl` walk the visible cards; a no-op move falls through to the action keys | Yes | Drove the horizontal case (border moved between cards) and the fall-through safety case (`k`,`k` at the top row neither armed nor killed). Vertical movement is traced: App.jsx:1544-1545. |
| **Pagination** (`[` / `]`) | Move focus to the adjacent pane when the grid pages | Yes | Drove it. 8 cards in a 24-row terminal: footer `pane 1/2 · [ ] to switch panes`, then `]` gave `pane 2/2` with focus on `[6] repo-6`. |
| **TextField** (`tui/lib/TextField.jsx`) as used by Broadcast and NewSession | Insert at the cursor, move with arrows and Home/End, Enter submits, Esc cancels, multi-line via Ctrl+J | Partly verified | Drove the Broadcast and NewSession paths that go through it: typing, Enter-submits, Esc-cancels, and the `focus` handoff that stops NewSession's arrows fighting the cursor. Cursor motion, Home/End, word jumps, the emoji-safe stepping and the row cap are traced only (TextField.jsx:39-104). Its own header at TextField.jsx:12-18 lists what it does not do: no vertical motion, no word jumps, no selection, no undo, and the cursor resets to the end when a parent replaces the value. |
| **Modal key isolation** | While a modal is open, the fleet hotkeys must not fire | Yes | Drove it. With Help open, `K` did not arm a kill and `q` did not open the quit confirm — the Help frame was unchanged. The gate is `if (modal) return` at App.jsx:1465. |

---

## Summary

### Counts

| Evidence | Table 1 hotkeys (34) | Table 2 verbs (71) | Table 3 modals (24) | Total (129) |
|---|---|---|---|---|
| Drove it — rendered app, observed | 31 | 64 | 24 | **119** |
| Traced — file:line only | 3 | 7 | 0 | **10** |
| Test only | 0 | 0 | 0 | **0** |
| Unverified | 0 | 0 | 0 | **0** |

Table 2 has 71 rows for **63 case labels**: seven extra rows cover argument
forms that behave differently (`:model` has four, and `:perm`, `:cap`,
`:repos` and `:resume` have two each), plus one row for the unknown-verb
fallback. Every one of the 63 labels has a row, and no row names a verb the
code does not have.

**12 rows are broken**: documented somewhere the user can read, and the app
does something else. The `:resume` and `N` defects were both observed
directly, not inferred.

No test was relied on as sole evidence, so nothing is labelled "test only".
The 10 traced rows are the four that shell out (`:model refresh`, `:update`,
`:whoami`, `:auth`), three alias labels whose twins were driven
(`:compactrestart`, `:todo`, `:debugkeys`), and vertical grid movement and
`Ctrl+C`, which the test harness cannot deliver. Two Table 3 rows — the shell overlay's
keep-warm behaviour and TextField's internals — are driven at their boundary
and traced inside; the row says which half is which.

### Broken

Ordered worst first. Worst means: the user is told it works, and it either does
nothing or does something different while reporting success.

1. **`:resume <slot>` silently retargets when the slot is out of range** —
   `tui/App.jsx:1025-1031`, with the filter itself at
   `tui/App.jsx:1028`. Any token outside 1–10 is dropped, the argument list
   becomes empty, and the verb falls into its bare branch: it
   SIGCONTs the focused session and toasts `resume slot 1`. The toast is
   affirmative and names a slot the user never typed, so someone restoring slot
   12 walks away believing slot 12 came back. That is why it ranks above `N`:
   `N` does nothing and looks like it did nothing. Observed for
   `:resume 99`, `:resume 0`, `:resume abc`, and for `:resume 11` and
   `:resume 12` on a 20-slot fleet. This is the exact defect class that was
   fixed for `:kill` — see the comment at `tui/lib/killTarget.js:5-9`, where an
   out-of-range slot used to kill the focused session. `:resume` never got the
   same treatment. Documented at `README.md:342` and `README.md:423`.
2. **`N` does nothing** — `tui/App.jsx:1596` binds only lowercase `n` and Ctrl
   plus `n`/`N`. `README.md:317` advertises `n` / `N` / `Ctrl+N`. The code
   comment at `tui/App.jsx:1593` says Shift+N is deliberately unbound, so the
   README is the side that is wrong.
3. **Settings NOTES tab tells the user the wrong quit key** — `NOTES_BODY` at
   `tui/modals/Settings.jsx:58` says `q  then  y  quit mc`. `tui/modals/QuitConfirm.jsx:26-28`
   accepts `s`, `d`, `n`, Enter and Esc, and ignores everything else. Observed:
   `q` then `y` leaves the confirm on screen.
4. **`:cap <slot>` refuses slots 11 and up** — `tui/App.jsx:1320`, while
   `tui/lib/settings.js:125` lets the fleet grow to 64 slots. Observed on a
   20-slot fleet: `usage: :cap <slot 1-10> <usd>`. Documented at `README.md:669`.
5. **`:forget <slot>` refuses slots 11 and up** — `tui/App.jsx:1103`, same
   mismatch. Observed: `forget <slot 1-10>`. Documented at `README.md:345`.
6. **The in-app plugin help gives an invocation that cannot work** —
   `tui/lib/plugins.js:19` and `tui/lib/plugins.js:23` tell the user to type
   `/compact-restart` in a Zoom composer. `README.md:391-396` states that the
   zoom body is a real `claude` process and that mc no longer intercepts slash
   commands there, so that text goes to claude, which has no such command. The
   only working invocations are `:compact-restart`, `:compactrestart` and `:cr`.
7. **`:recall` is advertised but does not exist** — `tui/lib/plugins.js:44`
   and `tui/lib/plugins.js:47` describe `:recall <q>`; `tui/lib/plugins.js:61`
   and `tui/lib/plugins.js:64` describe `/recall <query>`.
   Observed: `unknown command: recall`. Both plugins are off by default, and
   `plugins.js:48` does say "not yet wired (stub today)" — but the
   `plugin_recallSlash` entry carries no such warning.
8. **`docs/HOTKEYS.md:38` still documents lowercase `k` as kill** — the row
   reads `` `k` / `K` | Kill focused agent ``. `tui/App.jsx:1636` arms on
   uppercase `K` only, and `README.md:319` says so. Observed: `k`,`k` on a
   single card neither arms nor kills. That file's cited ranges
   (`tui/App.jsx:1140-1322`) are also about 280 lines stale — the handler now
   runs 1422-1690. Its own instruction at `docs/HOTKEYS.md:14` says "If you add
   a hotkey, update the matching row here in the same commit"; that did not
   happen for `K`.
9. **`README.md:415` describes `:perm <mode>` as setting the default** — it
   changes the focused live session (`tui/App.jsx:743-751`). The default form is
   `:perm default <mode>`, which the README's command table does not list at
   all. `tui/modals/Help.jsx:62-63` has both right.
10. **Help's "CURRENT VIEW" highlight is inert** — `helpView` is declared at
    `tui/App.jsx:162` and passed at `tui/App.jsx:1938`, but `setHelpView` is
    never called. The ZOOM sections can never be highlighted. Observed: the
    marker sits on NAVIGATION and SESSIONS in every state reached.
11. **`:transcript` and `:where` print the literal word `null`** —
    `tui/App.jsx:1164` and `tui/App.jsx:1241` interpolate `transcriptPathFor()`
    without checking it. `server/agent.mjs:50-53` returns null for any session
    id that is not a canonical UUID, which is the correct guard — but the user
    sees `transcript · null` instead of an explanation. Observed in both verbs.
12. **`tui/modals/Help.jsx` has no row for `d`/`D`** — the Dashboard is one of
    the nine screens under `tui/modals/`, and `README.md:316` documents its key. A user who
    learns the keymap from the in-app Help never finds it.
**The rule behind items 1, 4 and 5.** Five verbs take a slot argument. Two read
the fleet's real slot count and so work past 10: `:goto` (`tui/App.jsx:642`) and
`:kill` (`tui/lib/killTarget.js:19-34`, handed `slots: snapshot.slots || 10`
from `tui/App.jsx:956`). Three hardcode `<= 10`: `:resume` (`tui/App.jsx:1028`),
`:forget` (`tui/App.jsx:1103`) and `:cap` (`tui/App.jsx:1320`). Two of those
three at least refuse loudly; `:resume` does not.

### Undocumented

Works, but a user reading the docs would not find it.

- **`Shift+L`** (fleet log: all ↔ narrative) — `tui/App.jsx:1496`. Absent from
  `README.md` entirely; present at `tui/modals/Help.jsx:53`. The project's own
  rule is that the README tracks every merge.
- **The command bar is a lesser editor than the modals' text box** —
  `tui/App.jsx:1425-1455` supports append and backspace only. No cursor
  movement, no word kill, no command history. `tui/lib/TextField.jsx` — used by
  Broadcast and NewSession — offers all of those. Nothing says the two differ.
- **`r`/`R` is silent** — `tui/App.jsx:1625-1634` calls resume with no toast,
  on success or on failure. Its partner `p` toasts in both cases
  (`tui/App.jsx:1617`, `tui/App.jsx:1622`) precisely because silence was judged
  a defect there.
- **Broadcast's `[a] toggle all` needs `Tab` first** — the `if (!inText)` gate
  in `tui/modals/Broadcast.jsx` means `a` from the default focus types a letter.
  The modal header advertises `[a] toggle all` with no qualifier.
- **Settings Space and Enter nudge numbers and cycles**, not just toggles —
  the `key.return || input === ' '` branch at `tui/modals/Settings.jsx:180` calls
  the same cycle helper as the arrow keys.
- **`:cost`** — `tui/App.jsx:1343`. Absent from `README.md`; present at
  `tui/modals/Help.jsx:72`.
- **Verbs absent from `README.md`** (most are in Help): `:clear`, `:restart`,
  `:compact`, `:compact-restart`, `:cr`, `:remember`, `:rem`, `:memory`,
  `:mem`, `:mcp`, `:version`, `:ver`, `:transcript`, `:tx`, `:log`, `:tasks`,
  `:todo`, `:t`, `:debug-keys`, `:where`, `:tpl`, `:cost`.
- **Verbs absent from `tui/modals/Help.jsx`** (some are in README):
  `:approve`, `:a`, `:update`, `:dash`, `:ls`.
- **Aliases documented nowhere at all**: `:q`, `:jump`, `:permission`, `:hist`,
  `:help`, `:?`, `:debugkeys`, `:dk`, `:compactrestart`, `:dashboard`.
- **The Tests section lists two test files that no longer exist** —
  `README.md:901-907` describes `tests/slashCommands.test.mjs` and
  `tests/Zoom.slash.test.jsx`, and describes the retired zoom slash catalog
  (bare `/` returning a catalog that narrows to `/perm` and `/pause`, `/cost`
  routing through `onSlashCommand`) as current. Neither file is on disk. This is
  a stale test inventory rather than a wrong instruction to a user, which is why
  it is here and not in the Broken list — but a reader checking what is covered
  will be misled.
- **`docs/HOTKEYS.md` covers none of the `:` verbs** and omits `!`, `Shift+L`
  and `[`/`]`, despite presenting itself as the complete binding inventory.

### Not broken, worth recording

- **No duplicate verb labels.** A scan of every `case '…'` in
  `tui/App.jsx:612-1418` with comment lines excluded finds 63 labels and no
  repeat. The twin `case 'resume'` that made selective restore unreachable is
  gone; the replacement routes on the argument, and the comment at
  `tui/App.jsx:1014-1024` records why.
- **The kill chord is safe.** Uppercase only, armed, 3-second window, and a
  no-op vim move falls through rather than swallowing the press.
- **Approve is gated on `waiting`** in both the hotkey and the verb, so a stray
  keystroke cannot authorise a billed turn.
- **`:kill` rejects an out-of-range slot** instead of retargeting. That is the
  fix `:resume` still needs.
- **Modal key isolation holds** — `tui/App.jsx:1465`.
