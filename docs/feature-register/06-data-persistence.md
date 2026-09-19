# Feature register 06 — data, settings and persistence

What this covers: everything Mission Control stores, reads, or works out for
itself. Settings, the saved-session records, the money counters, the
single-writer guard, the model list, and the small readers that pull in git
status, plan usage and project health.

Reviewed 2026-09-19. Read-only review — no product code was changed.

**The short version.** Six of the 34 switches in the settings menu do nothing
at all. One more does half of what it says. The model list is eight rows typed
by hand, and two of those rows are measurably wrong — the app silently corrects
them at startup from a real measurement it already has. The five-hour usage
figure on screen right now says "0%" for a number that is simply not in the
source file. And a cost worked out from a guessed price is shown without the
mark that says it was guessed.

One thing to flag but not to panic about: the permission-mode menu offers six
options and the README documents four. Of the two extras, `auto` is real — the
README describes it as part of the CLI's own cycle, and it is what the user has
selected. `dontAsk` is the odd one out, documented nowhere; whether the CLI
accepts it is the single unverified item in this review.

A note on the evidence column, because it is the point of this document. "Ran
it" means the code was executed against real data on this machine and the
output is quoted. "Traced" means each step was followed by hand through the
files, with line numbers. "Test only" means a test passes, which pins current
behaviour and is not proof of correctness — several tests in this project were
found pinning a defect. "Unverified" means exactly that, and is an acceptable
answer.

---

## Part 1 — Every setting in the menu

One row per item in `SETTINGS_SCHEMA` (`tui/lib/settings.js:111-171`), in menu
order. "Actually read by" is the code that consumes the value. Where that
column says **nothing**, the switch is shown to the user and has no effect.

### GENERAL

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Update rate (`tickRate`) | "How often the UI re-samples derived stats" | `tui/App.jsx:249` sets the clock interval; `:271` is its dependency | Traced. `const activeMs = Math.max(300, settings.tickRate)` — note the floor, so values below 300 ms are clamped and the menu's 200 ms minimum is unreachable. |
| Git status poll (`gitPollSec`) | Labelled "Git status poll", in seconds | **Nothing** | Ran a repo-wide search. The string `gitPollSec` appears on exactly two lines in the whole project, both inside `tui/lib/settings.js` (`:87` default, `:114` menu row). No consumer, no test, no doc. **Dead.** |
| Broadcast stagger (`broadcastStaggerMs`) | Delay between each send in a broadcast, so mc does not open many connections at once | `tui/App.jsx:1756` (broadcast), `:1834` (resume-all) | Traced. Passed to `fleet.broadcast(targetIds, text, settings.broadcastStaggerMs ?? 0)`. |
| Vim keys (`vimKeys`) | "Use hjkl alongside arrow keys" | `tui/App.jsx:1542-1545` | Traced. Each of h/j/k/l is guarded by `settings.vimKeys`. |
| 24-hour clock (`clock24`) | — (no description) | `tui/App.jsx:607` | Traced. `fmtClock(now, settings.clock24)`. |
| Auto-resume on startup (`autoResumeOnStart`) | On boot, restore every saved session whose slot is empty | `tui/App.jsx:351` | Traced. Guards the bulk-resume branch at boot. |
| Session history limit (`sessionHistoryLimit`) | View-only history for `:history`; explicitly not used by resume-all | `tui/main.jsx:194`, `tui/App.jsx:448`, `:1091` → `sessionStore.js:298` | Traced. The disclaimer is honest: `listOpenResumeRecords()` (`sessionStore.js:378`) reads `bySlot`, never `history`. |
| Default model (`defaultModel`) | New-session default; `auto` follows discovery | `tui/App.jsx:1294`, `tui/modals/NewSession.jsx:99`, via `resolveModelId` (`models.js:109`) | Ran it. With the real model cache loaded, `resolveModelId('auto')` returned `opus-5`. The user's stored value is `"opus-4.8"`, an explicit pin. |
| Discover models on startup (`syncModelsOnBoot`) | Boot-time catalogue sync plus alias re-probe | `tui/main.jsx:109` | Traced. Gates both `syncModelsFromApi` and `autoProbeOnVersionChange`. The opt-out works; see Part 2 for what the sync itself does and does not do. |
| Default permission mode (`defaultPermission`) | Default for new sessions; six options offered | `tui/App.jsx:1295`, `:1722`, `:1779` → passed to `--permission-mode` (`ptyAgent.mjs:426`) | Traced, with one gap. The value is passed to the CLI with no validation beyond membership of the app's own list (`App.jsx:69`). The menu offers six modes; `README.md:415` documents four for `:perm` (`default`, `acceptEdits`, `bypassPermissions`, `plan`). Of the two extras, **`auto` is corroborated** — `README.md:321` describes the CLI's own cycle as `plan → auto → acceptEdits`, and that is the user's stored value. **`dontAsk` is not**: it appears nowhere in the README or docs, only in the app's own list and a comment at `App.jsx:67`. Whether the CLI accepts `dontAsk` is **unverified** — confirming it means launching a real session, which was out of scope. |

### LAYOUT

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Maximum live sessions (`maxSlots`) | Applies live; sizes the fleet | `tui/main.jsx:74`, `:148`, `:157`; `tui/App.jsx:414`; `fleet.mjs:304` | Traced. Also confirmed against real data: the user's setting is 15 and the saved store holds slots up to 15. |
| Density (`density`) | Cycles compact / regular / spacious | **Nothing** | Ran a repo-wide search. `density` appears only in `tui/lib/settings.js` (`:26`, `:126`) and in two tests that assert the menu renders the word and that a bad value falls back. No renderer reads it. **Dead.** |
| Grid columns (`gridCols`) | 3 / 4 / 5 | `tui/App.jsx:1539`, `:1894` → `gridLayout.js:73` | Traced. |
| Max windows per pane (`windowsPerPane`) | Cards per pane before the grid pages; 0 = fill | `tui/App.jsx:1897` → `gridLayout.js:87` | Traced. `perPage = windowsPerPane > 0 ? Math.min(windowsPerPane, capByFit) : capByFit` — the documented "also capped by terminal height" is real. |
| Card borders (`borderStyle`) | rounded / sharp / double | `tui/App.jsx:2152` → `Card.jsx:306` via `inkBorderStyle` (`:62`) | Traced. |
| Show fleet log (`showFleetLog`) | — | `tui/App.jsx:2186` | Traced. |
| Fleet log lines (`fleetLogLines`) | 4-40 lines | `tui/App.jsx:595`, `:2187` → `gridLayout.js:111` | Traced. The event buffer is sized from the menu's own maximum rather than a fixed number (`settings.js:194`, `:209`), so a large setting is not unreachable by construction — which it previously was. Whether any given value fills in practice depends on `FLEET_LOG_NARRATIVE_YIELD` (`settings.js:205`), itself a hand-rounded figure from two observations; that is listed as a hand-typed value below. The user is set to 32. |
| Fleet log content (`fleetLogMode`) | narrative vs all; Shift+L cycles live | `tui/App.jsx:595`, `:1497` | Traced. |
| Card tail: show tool events (`cardShowTools`) | Off by default: cards show user/asst/note only | `tui/App.jsx:2153` | Traced. |
| Hide claude update banner (`hideClaudeUpdateBanner`) | Lift the CLI's own update banner out of the zoom body into a header chip | `tui/App.jsx:2079` → `tui/zoom/PtyPane.jsx:94` | Traced. |

### COLORS

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Color theme (`theme`) | Seven named palettes | `tui/App.jsx:156`, `:233` → `themes.js` | Traced. All seven menu options exist as keys in `THEMES`; the list matches. |

### ALERTS

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Context warning threshold (`ctxThreshold`) | Token count at which a card warns; no upper cap | `tui/App.jsx:587` → `Card.jsx:138` | Traced. The menu carries its own admission that this is awkward to set — a `TODO` at `settings.js:141` notes a large value needs about 160 keypresses because there is no direct numeric entry. |
| Yellow band starts at (`warnPct`) | Percentage of the threshold where the warning colour begins | `tui/App.jsx:2151` → `Card.jsx:138` | Traced. `(agent.context \|\| 0) >= threshold * ((warnPct \|\| 85) / 100)`. |
| Suggest /compact at threshold (`autoCompactSuggest`) | Suggest compacting when the context threshold is hit | **Nothing** | Ran a repo-wide search. `autoCompactSuggest` appears on exactly two lines in the project, both in `tui/lib/settings.js` (`:94`, `:143`). No suggestion code exists. **Dead.** |

### SAFETY

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Confirm before broadcast (`broadcastConfirm`) | "Stops a stray ↵ from blasting all sessions" | `tui/App.jsx:1961` → `tui/modals/Broadcast.jsx:13` | Traced. This is the switch that was found doing nothing earlier this week; it is wired now — the value reaches the modal as the `confirm` prop. |
| Per-slot cost cap (`costCapUSD`) | Refuse further sends once a session crosses this | `tui/App.jsx:407` → `fleet.setCostCap` → `ptyAgent.mjs:730` | Traced. The cap binds — but on a worked-out number, not a billed one. See Part 2, "cost figures". The user's value is 0, so it is off. |
| Fleet daily budget (`dailyBudgetUSD`) | Refuse new launches once today's fleet total exceeds this | `tui/App.jsx:1704` → `costStore.dayCost()` | Traced. Same caveat as above. The user's value is 0, so it is off. |

### PLUGINS — memory management

These six rows are generated from `tui/lib/plugins.js` and rendered with the
descriptions shown. Each one presents as a working feature toggle.

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| `plugin_compactRestart` | "Summarize → kill → relaunch focused session with summary injected" | `tui/App.jsx:807` | Traced. Guards the `/compact-restart` verb. |
| `plugin_dedupeToolOutput` | "Collapse repeated tool outputs (git status, ls) into [deduped] markers" | **Nothing** | Ran a repo-wide search. `plugin_dedupeToolOutput` appears only in `tui/lib/plugins.js`. No hashing, no dedupe, no marker anywhere. **Dead.** |
| `plugin_projectMemory` | "On launch, prepend the focused repo's .mc/MEMORY.md to the first message" | `tui/App.jsx:868` (`:remember`), `:1727` (injection) | Traced. Both halves are real; `projectMemory.js` does the reading and injecting. |
| `plugin_vectorRecall` | "Index transcripts into a local vector DB; :recall <q> searches it" | **Nothing** | Ran a repo-wide search. `plugin_vectorRecall` appears only in `tui/lib/plugins.js`. **Dead** — and the user has it switched **on** in their real settings file. The row's own long help text admits "not yet wired (stub today)", but that text is only visible when a row is expanded; the one-line description shown in the list does not say so. |
| `plugin_mcpAware` | "List MCP servers attached to focused session; **surface a chip on Card**" | `tui/App.jsx:915` — the `:mcp` verb only | **Half dead.** Traced: the verb is gated and works. Searched `tui/Card.jsx` for "mcp" in any case — zero matches. The promised chip does not exist. |
| `plugin_recallSlash` | "If an MCP retrieval server is attached, /recall <q> dispatches to it" | **Nothing** | Ran a repo-wide search. `plugin_recallSlash` appears only in `tui/lib/plugins.js`. **Dead.** |

### FEEDBACK

| Setting | Claims to do | Actually read by | How I know |
|---|---|---|---|
| Slack webhook configured (`slackWebhook`) | Read-only indicator; set via `:slack <url>` | `tui/App.jsx:1408` → `slack.js:41` | Traced. Deliberately display-only so the URL is never drawn on screen. The address is re-checked against `https://hooks.slack.com/` at send time (`slack.js:46`), not only when it is set — the right place for it, since the file is hand-editable. |

**Two settings exist but are not in the menu.** `toastDurationMs` (read at
`tui/App.jsx:378`) and `repoParents` (read at `tui/App.jsx:329`) are in
`SETTINGS_DEFAULTS` but absent from `SETTINGS_SCHEMA`. These are the opposite
problem to the dead switches and are not a fault — both work, and `repoParents`
has its own picker. Noted so the table above is honestly limited to the menu.

---

## Part 2 — The stores and the derived numbers

| Feature | Expected to do | Does it? | How I know |
|---|---|---|---|
| **Settings file** (`settings.js:335-352`) | Load from disk, fall back to a backup copy, survive a hand-edited file | Yes | Traced. Read order is main → `.bak` → defaults (`:336`). Every known key is forced to the right type and clamped to the menu's own limits before any consumer sees it (`sanitizeSettings`, `:303`). Unknown keys pass through untouched. Written atomically: copy to `.bak`, write `.tmp`, rename (`:344-348`). |
| **Settings: stale model ids** | Rewrite model names that changed between versions | Yes, for two | Traced. `MODEL_ID_MIGRATIONS` (`settings.js:234`) maps `sonnet-4.5`→`sonnet-4.6` and `opus-4.1`→`opus-4.7`. A hand-maintained pair, duplicated verbatim in `sessionStore.js:97` — two copies that must be kept in step by hand. |
| **Saved sessions** (`sessionStore.js`) | Remember enough per slot to resume a conversation tomorrow | Yes | Ran it against the real store: version 2, 11 slots saved (3, 6-15), 15 history entries, last written 2026-09-19. Each record carries session id, working directory, branch, model and permission mode. |
| **Saved sessions: bad ids dropped** | Refuse records the CLI would reject | Yes | Traced. `isValidSessionId` (`sessionStore.js:91`) requires a UUID; non-UUID records are deleted at load (`:127-132`), with a deliberate exception for location-only records that carry no id by design. |
| **The open set** — which sessions `:resume-all` restores | Restore exactly the sessions that were open when the app last closed | Yes, by design; **the data shows a weakness** | Traced `listOpenResumeRecords` (`:378`). It reads a `live` flag written onto each record rather than a separate list — a sound choice, and the code comment explains that a parallel list drifts. Ran it: the real store's `openSlots` array is `[]` while six slots carry `live: true`, which is the vestigial field the `TODO` at `:396` describes. Harmless today because nothing reads it. |
| **Open set: closing the right slots** | Never mark a slot closed that this run has not seen open | Yes | Traced. Two guards at `:282-294`: nothing is closed unless at least one slot is live, and only slots this process has personally seen live are eligible. |
| **Boot-time tidy-up** (`pruneSessions`, `:320`) | Drop records above the fleet size; keep one record per repo | Yes | Traced. Called from `tui/main.jsx:148` with the user's `maxSlots`. Deliberately keeps two records for the same repo when both are live. |
| **Session history** (`listHistory`, `:416`) | A reference-only trail; never auto-restored | Yes | Traced. There is no restore path from `history`, and `listOpenResumeRecords` reads `bySlot` only. The limit is applied at `:298`. |
| **Weekly and daily spend** (`costStore.js`) | Track spend per ISO week and per UTC day across restarts | Yes | Ran it against the real store: current week `2026-W38`, current day `2026-09-19`, 17 week buckets, 90 day buckets, 7 session markers. |
| **Spend: rolling retention** | Keep about a year of weeks and 90 days, so the file cannot grow forever | Yes — and it is currently active | Ran it. The real file holds exactly 90 day buckets against a cap of 90 (`DAYS_KEEP`, `costStore.js:144`), and 17 weeks against a cap of 53. The day bucket is at its limit, so the prune is demonstrably doing work right now. |
| **Spend: no double-counting on resume** | A resumed session must not re-count money it already spent | Yes | Traced. The first sighting of any session is recorded as a starting point, never as new spend (`costStore.js:210-215`), and the marker is keyed by session id, which survives a resume, rather than by the per-launch agent id (`seenKey`, `:174`). |
| **Spend: two apps at once** | Two copies of the app must not overwrite each other's totals | Yes | Traced. `persist` (`:104`) re-reads the file and adds only the amount accrued since the last write, rather than overwriting (`:112-119`). Pending amounts are cleared only when the write actually lands (`:243`). |
| **The cost figures themselves** | Show what the fleet is spending | **Derived, not measured** | Ran it. The real week bucket reads $5,505.70 and today's $2,768.98. These are token counts multiplied by prices typed by hand in `models.js`, not amounts billed. On a subscription plan they correspond to no charge at all. Both money caps gate on this worked-out number. |
| **Cost of an unknown model** | Never price a model the list does not know at $0 | Yes — the zero is fixed | Ran it. `deriveCost(usage, 'claude-mythos-9')` returned **$30.00** for a million tokens in and out, with the price inherited from `opus-5`. The earlier defect, where an unknown model priced at $0 and quietly switched off both caps, is genuinely repaired at `jsonlConnector.mjs:157`. |
| **Marking a guessed price as guessed** | A cost based on a guessed price shows a `~` so it is not mistaken for a real figure | **No — broken** | Ran it. Two different lookups disagree. The cost is worked out with `estimatedPricingFor` (`jsonlConnector.mjs:157`), which always returns a price and sets an `estimatedPricing` flag — but `deriveCost` returns only a number and throws the flag away. The `~` marker instead reads `model.estimatedPricing` where `model = modelByCli(resolvedModel) \|\| MODELS[agent.model]` (`Card.jsx:125-126`, same at `Zoom.jsx:104`). For a model the list has never heard of, that lookup returns **null**, so no `~` is drawn. Measured: `claude-mythos-9` → cost $30.00, UI lookup `NULL -> no "~" marker`. A guessed figure is shown as if it were measured. |
| **Single-writer guard** (`instanceLock.js`) | One app per config folder; a second one runs but writes nothing | Yes — and it now covers all four stores | Traced all four. `sessionStore.js:155`, `costStore.js:105`, `settings.js:340`, `templateStore.js:91` each check `isReadOnlyMode()` before writing. The earlier state, where only the session store honoured the flag, is repaired; the flag lives in `instanceLock.js:34` so the stores share one gate without importing each other. |
| **Lock: a dead or recycled holder** | Take over a lock whose owner is gone; keep out of the way of one that is alive | Yes | Ran it against the live lock file. Contents: `{"pid":85785,"startedAt":1789784835948}` — the shape the code expects. The holder is genuinely running: `ps -p 85785` returned `Fri Sep 18 21:27:15 2026  node`. The lock's own timestamp decodes to the same second, so the reused-process-number check at `lockHolderIsLive` (`:68-75`) sees a difference of zero against a 5-second tolerance and correctly treats it as the real owner. An app started now would go read-only, as designed. A process that exists but cannot be signalled also counts as alive (`:43`) — the cautious choice. |
| **Lock: ordering at boot** | Acquire the lock before anything writes | Yes | Traced. `tui/main.jsx:137` acquires it; the tidy-up that writes runs after, at `:148`. |
| **File permissions tidy-up** (`tightenStateModes`, `:123`) | Tighten folders to owner-only on old installs | Yes | Traced. Called at `tui/main.jsx:128`. Walks three levels, skips symbolic links (`:128`, `:137`), never throws. Verified on the real folder: `drwx------` and every file `-rw-------`. |
| **Templates** (`templateStore.js`) | Named bundles of sessions; write examples on first use | Yes | Traced. Three bundled examples at `:37-88`. **But** every example pins a model by hand — `opus-4.8` and `sonnet-4.6` — so the shipped templates will name stale models as the catalogue moves. No file exists in the real config folder, so the defaults have never been written there. |
| **Project memory** (`projectMemory.js`) | Read `<repo>/.mc/MEMORY.md` and prepend it to the first message | Yes, and safely | Traced. Reads at most 64 KB (`:35`, `:53-61`) and uses `lstat` rather than `stat` (`:50`) so a repository cannot ship a symbolic link pointing at, say, a private key and have it pasted into a prompt. Refuses anything that is not a plain file (`:51`). |
| **Plan usage** (`usage.js`) | Show the real Anthropic-side rate-limit percentages | **Partly — the five-hour figure is fabricated** | Ran it against the real file. The source contains only `seven_day`: `{"source": "claude", "updated_at": 1789837017, "seven_day": {"used_percentage": 61, "resets_at": 1790352000}}`. There is no `five_hour` key. `readUsage()` maps the missing value to `0` (`usage.js:40`, `raw.five_hour \|\| {}` then `Number(undefined) \|\| 0`) and returned `fiveHour: { usedPct: 0, resetsAt: 0 }`. `Aggregate.jsx:76` renders that as **`5h 0%`** — an unknown reported as the most reassuring possible number. The seven-day figure (61%) is real. This is the same defect class that was fixed in `projectHealth.js:73` and left in place here. |
| **Auth probe** (`auth.js`) | Report which account sessions will run under | Yes | Traced. Uses `execFileSync` in argument form (`:24`), so the user-controlled `CLAUDE_BIN` cannot inject a shell command. Falls back to looking for an API key in the environment when the CLI has no `auth status` (`:40-49`). Not executed here — running it spawns the CLI. |
| **App version** (`version.js`) | Report version, short commit and whether the tree is dirty | Yes | Traced. Reads `package.json`, then two `git` calls in argument form (`:27`, `:40`), each with a 2-second limit, each degrading to null or false. |
| **Model catalogue** (`models.js`) | Names, context sizes and prices for every model | **Eight rows typed by hand; two of them wrong** | Ran it. The table holds 8 entries. Overlaying the real cached measurement changed two: `sonnet-5` maximum output **128000 → 64000**, `haiku-4.5` **64000 → 32000**. Both hand-typed numbers were wrong and are silently corrected at every startup. A ninth model, `opus-5`, is **added** at startup — it is not in the table at all. |
| **Catalogue: newest model** (`newestModelId`) | Work out the newest model of a family from the live list, with nothing hardcoded | Yes | Ran it. After the real cache was applied, `newestModelId('opus')` returned `opus-5` and `resolveModelId('auto')` returned `opus-5` — a model that exists nowhere in the source. The "no hardcoded current best" claim holds. |
| **Catalogue: hand-added exception** | `fable-5.1` is documented as the one hand-added row | Yes, honestly documented | Traced `models.js:46-57`. The comment states plainly that its prices are **not** verified and explains why neither automatic source can reach it. Its limits came from a live model listing; its prices are inherited and flagged. |
| **Alias probe** (`modelProbe.js`) | Learn what `opus`/`sonnet`/`haiku` point at today, only when the CLI changes | Yes | Ran it. The real cache is stamped `claudeVersion: "2.1.267"`, fetched `2026-09-18T21:08:29Z`, and records `opus → claude-opus-5`, `sonnet → claude-sonnet-5`, `haiku → claude-haiku-4-5-20251001`. Each probe is a real billed turn, so it fires only on a version change (`:169`). The version stamp is withheld unless at least one alias resolved (`:174`), so a network failure does not silence discovery until the next update. |
| **Models API sync** (`syncModelsFromApi`) | Fetch the authoritative model list and reconcile | **Written, wired, and never runs here** | Traced. Called at `tui/main.jsx:110`. It returns early at `modelProbe.js:203` with "no API credential" unless `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is in the environment. This machine signs in through the CLI, so neither is set and the sync silently does nothing. This is the pending decision noted in the brief — reported, not acted on. |
| **Models API sync: safety of the diff** | Do not wipe the catalogue on a bad response | Yes | Traced. Refuses a non-HTTPS address (`:210`), will not follow redirects (`:222`), and will not mark anything retired unless at least one model was recognised (`:298`). |
| **Project health** (`projectHealth.js`) | Show the latest session-health score per repo | Yes, and it is careful | Traced. Reads only the last 16 KB of a file that grows forever (`:17`, `:26`). An unmeasured score stays `null` rather than becoming `0` (`:73-74`), the colour falls back to neutral rather than green or red (`:112`), and the trend arrow is left blank when there is only one reading (`:79-83`). This is the correct handling of an unknown — and the model the usage reader above should follow. |
| **GitHub issues** (`tasks.js`) | List open issues for a session's folder via the `gh` tool | Yes | Traced. Argument-form call (`:48`), never throws, and carries a second deadline (`:86`) because the tool's own timeout was observed failing to fire — a real hang of about nine minutes is recorded in the comment at `:23`. |
| **Slack posting** (`slack.js`) | Send `:feedback` and `:request` to an Incoming Webhook with a summary of fleet state | Yes | Traced. Sends the simplest text-only payload (`:57-61`) so no bot token or scopes are needed. Three things it gets right: it re-checks the address against `https://hooks.slack.com/` at send time (`:46`) rather than trusting what was stored, because the settings file is hand-editable; it refuses to follow redirects, so the address cannot be bounced off that origin (`:70`); and it caps the request at 10 seconds (`:73`) so a hung post cannot wedge the caller. Returns a structured result rather than throwing (`:77`, `:81`). Not executed — sending would make a network call. |
| **Slack posting: the context block** | Attach who and what to the message | Yes, with one inherited fault | Traced `contextLines` (`:14-29`). Includes the signed-in address, a live-session count and up to five slot lines. It also prints the plan usage figures (`:26`), which means the fabricated five-hour `0%` described below travels into Slack messages too. |
| **Git status** (`server/git.mjs`) | Report branch, uncommitted-file count, and ahead/behind | Works, but **reports failure as zero** | Traced. `dirtyCount` returns `0` when the command fails or times out (`:45`) — indistinguishable from a clean tree. `aheadBehind` returns `{ahead: 0, behind: 0}` when there is no upstream branch (`:57`) — indistinguishable from being in step. Same defect class as the usage reader. |
| **Repository discovery** (`server/repos.mjs`) | Find recently-touched repositories for the new-session picker | Works, but **invents a branch name** | Traced. `defaultBranch` returns the literal string `'main'` whenever the git head file cannot be read (`:76`), and the picker displays that as the repository's branch. A repository on `master` or `develop` whose file is unreadable is shown as `main`. `readRemote` is honest by contrast — it returns `'(local)'` (`:83`). |
| **Repository discovery: where it looks** | Scan the user's configured folders, else defaults | Yes | Traced. Order is user setting, then the `REPO_PARENTS` environment variable, then seven hardcoded folder names under home (`:18-26`, `:42-47`). The seven defaults are a hand-typed guess at the user's layout, which is why the setting exists. |
| **Status hook** (`server/hooks/emit-status.mjs`) | Append one line per event; never block a turn | Yes | Traced. Exits zero on every path (`:64`), including empty input (`:21`), unparseable input (`:28`) and a non-UUID session id (`:40`). Reads all of standard input before parsing (`:18`) — correct, since the payload can arrive in pieces. Creates its folder owner-only and its file owner-only (`:45`, `:61`). Tool names are cut at 80 characters (`:51`), a hand-chosen limit. |

---

## Summary

**Counts.** 72 rows were examined — 34 settings and 38 stores and derivations.
Each row is classed by its strongest evidence, counted once.

| Class | Count | What it means |
|---|---|---|
| Ran it against real data | 12 | Product code executed on this machine against the user's real files; output quoted above. |
| Proved absent by exhaustive search | 6 | A repo-wide search for the key, plus a search for computed-key reads, returned no consumer. For "nothing reads this", an exhaustive search is the strongest evidence available — but it is a search, not a run, so it is counted separately. |
| Traced | 53 | Every step followed by hand with file and line numbers. |
| Test only | 0 | No claim in this document rests on a passing test alone. |
| Unverified | 1 | Whether the CLI accepts the `dontAsk` permission mode. Needs a real session launch, which was out of scope. |

**Broken: 9 items.** Six dead settings, one half-dead setting, the missing `~`
marker on guessed costs, and the fabricated five-hour usage figure. Three
further readers report a failure as a plausible number; those are counted in the
second list below rather than here, to avoid double-counting.

### Settings shown to the user that have no effect

1. **Git status poll** (`gitPollSec`) — no consumer anywhere in the project.
2. **Density** (`density`) — no renderer reads it.
3. **Suggest /compact at threshold** (`autoCompactSuggest`) — no suggestion code exists.
4. **Tool-output dedupe in tail** (`plugin_dedupeToolOutput`) — no dedupe code exists.
5. **:recall semantic search** (`plugin_vectorRecall`) — no index, no search. **The user currently has this switched on.**
6. **/recall routes to MCP retrieval** (`plugin_recallSlash`) — no dispatch code exists.
7. **MCP inventory** (`plugin_mcpAware`) — *half*. The `:mcp` command works; the "chip on Card" the description promises does not exist in `Card.jsx`.

All seven present in the menu exactly like the working switches: same look,
same confident description, and in the plugin section a paragraph of help text
describing behaviour that was never built.

**How solid is "nothing reads it"?** As solid as a static search can be. A
literal search for each key name across the whole project was the first pass.
The remaining way such a conclusion could fail is a value applied by computed
key — `settings[something]` — which a name search cannot see. Searched for that
pattern across `tui/` and `server/`: the only hits are
`tui/modals/Settings.jsx:117` and `:227`, which draw and edit the menu itself,
and `tui/lib/plugins.js:80`, which is `isPluginEnabled`. That helper has exactly
four callers (`App.jsx:807`, `:868`, `:915`, `:1727`), covering only
`plugin_compactRestart`, `plugin_projectMemory` and `plugin_mcpAware`. No code
anywhere applies a setting by computed key. The six dead rows stand.

### Numbers that are typed or invented rather than measured

1. **The model table** — 8 rows of names, context sizes and prices typed by
   hand (`models.js:64-73`). Two maximum-output figures are provably wrong:
   `sonnet-5` says 128000, the measurement says 64000; `haiku-4.5` says 64000,
   the measurement says 32000. Both are silently overwritten at startup, so the
   file has been wrong without anyone noticing.
2. **A ninth model exists that the table does not list** — `opus-5` is what the
   `opus` alias resolves to on this machine today. It is added at startup with
   prices inherited from `opus-4.8` and flagged as guessed.
3. **`fable-5.1`'s prices** — inherited from `fable-5`, not published rates.
   Honestly flagged in the source.
4. **Every cost on screen** — token counts times hand-typed prices. The real
   store reads $5,505.70 for this week. Nothing was billed at that figure. Both
   money caps gate on this derived number.
5. **A guessed price is shown without its `~`** — measured: an unknown model's
   turn costs $30.00 and displays with no mark distinguishing it from a real
   figure, because the cost path and the marker path use different lookups.
6. **The five-hour usage percentage** — the source file has no such key; the
   app prints `5h 0%`. Measured today.
7. **Uncommitted-file count on a git failure** — reported as `0`, same as clean
   (`git.mjs:45`).
8. **Ahead/behind with no upstream** — reported as `0/0`, same as in step
   (`git.mjs:57`).
9. **A repository's branch when the git head file is unreadable** — reported as
   the literal `'main'` (`repos.mjs:76`).
10. **Seven default scan folders** — a hand-typed guess at the user's directory
    layout (`repos.mjs:18-26`).
11. **The tool-name cut at 80 characters** in the status hook (`emit-status.mjs:51`).
12. **The two model-rename mappings**, maintained by hand in two separate files
    that must be kept in step (`settings.js:234`, `sessionStore.js:97`).
13. **The fleet-log yield figure** — `FLEET_LOG_NARRATIVE_YIELD = 0.125`
    (`settings.js:205`), a hand-rounded number derived from two observations
    recorded in the comment above it. It sizes the event buffer, so how large a
    fleet log can actually fill rests on it. Honestly documented as an estimate,
    but an estimate nonetheless.
14. **The three bundled templates** pin `opus-4.8` and `sonnet-4.6` by hand
    (`templateStore.js:42-85`), so the shipped examples name models that age.

### One more thing the stored data shows

The saved session records disagree with themselves about which model is
running. Read from the real store today: slot 11 records `model: "fable-5"` but
`resolvedModel: "claude-opus-5"`. Slots 10, 12 and 14 record `model:
"opus-4.8"` against `resolvedModel: "claude-opus-5"`. The launch label and the
model that actually ran are different, and both are on disk. This is the
displayed-model problem described in the stabilisation ruling, visible in the
persisted data rather than inferred.

### The pattern underneath

Three separate readers turn "I could not measure this" into a specific,
plausible number: usage says 0%, git says 0 changed files, repository discovery
says `main`. One reader — project health — gets it right, keeping `null` for an
unmeasured score and rendering a neutral marker. That file was corrected
recently and shows what the fix looks like. The other three were not part of
that change and still report a confident answer where they have no information.
