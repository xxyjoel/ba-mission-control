# ba-mission-control — Component & Function Inventory

Generated 2026-06-09. Every component, every exported function, every
command/hotkey — with purpose, callers, test coverage, and orphan flags.

Sibling docs: `ARCHITECTURE.md`, `IMPROVEMENTS.md`.

---

## 1. UI components

### 1.1 Top-level (tui/*.jsx)

| Component | File:Line | Lines | Props | Owns (useState/ref) | Renders | Parents | Refactor? |
|-----------|-----------|-------|-------|---------------------|---------|---------|-----------|
| App | App.jsx:54 | 1389 | fleet, auth | **23 useState + 6 refs** | header + aggregate + grid + log + status + modals + toasts + cmd bar + feedback | (root) | **CRITICAL split — too many concerns** |
| Header | Header.jsx:19 | ~120 | agents, threshold, nowStr, sessionStr, theme, auth, version | — | one-line status strip | App | ok |
| Aggregate | Aggregate.jsx:30 | ~140 | agents, fleetTpm, aggSpark, theme, usage, fmtReset | — | fleet totals + sparkline + usage % | App | ok |
| Card | Card.jsx:80 | ~280 | agent, focused, threshold, warnPct, borderStyle, showTools, theme | — | per-slot tile | App grid | ok |
| FleetLog | FleetLog.jsx:48 | ~110 | log, focusedId, theme, maxLines | — | 10-line activity stream | App | ok |
| StatusBar | StatusBar.jsx:30 | ~80 | mode, focused, cmdMode, cmdBuffer, filterActive, theme | blink (useState) | bottom status + cmd buffer | App | ok |

### 1.2 Modals (tui/modals/*.jsx)

| Component | File:Line | Lines | Props | useState count | Notes | Refactor? |
|-----------|-----------|-------|-------|----------------|-------|-----------|
| Zoom | Zoom.jsx:131 | 1129 | agent, threshold, onClose, onSendMessage, onSlashCommand, onCyclePerm, theme, width, usage, fmtReset, weekCost | **13** | scroll machine + composer + awaiting-prompt | **HIGH split** |
| NewSession | NewSession.jsx:85 | 278 | slot, repos, onLaunch, onClose, defaultModel, theme, width | 6 | repo picker + model selector | extract useRepoSearch hook |
| RepoPicker | RepoPicker.jsx:32 | 182 | start, current, onPick, onClose, theme, width | 5 | filesystem browser | extract useFsNav hook |
| Dashboard | Dashboard.jsx:69 | 233 | agents, threshold, theme, weekCost, dayCost, budget, onClose, onZoom, onFocus, initialSlot, width | 3 | sortable fleet table | ok; sort to util |
| Settings | Settings.jsx:79 | ~295 | settings, setSettings, onClose, theme, width | 2 | tabs + tunable rows | ok |
| Broadcast | Broadcast.jsx:19 | ~85 | agents, onSend, onClose, theme, width | 3 | target chips + composer | ok |
| Help | Help.jsx:30 | ~130 | onClose, theme, width, view | — | keymap reference | ok |

### 1.3 Shared (tui/lib/*.jsx)

| Component | File:Line | Lines | Props | Owns | Used by | Refactor? |
|-----------|-----------|-------|-------|------|---------|-----------|
| TextField | TextField.jsx:66 | ~194 | value, onChange, onSubmit, onCancel, placeholder, focus, color, caretColor, width | blink, escTimerRef | Zoom · Broadcast · NewSession | **EDITOR FEATURES MISSING — see IMPROVEMENTS.md "TextField"** |

### 1.4 Inline helpers (not exported)

| Helper | In file | Purpose |
|--------|---------|---------|
| Seg | Header.jsx:10 | label + separator bar |
| Cell | Aggregate.jsx:14 | label + separator bar |
| Row | Help.jsx:6 | two-column keymap row |
| Section | Help.jsx:15 | help section header + body |
| TurnHeader | Zoom.jsx:78 | visual separator between conversation turns |

---

## 2. Data-layer modules (server/*.mjs + tui/lib/*.js)

| Module | Exports | Purpose | External deps |
|--------|---------|---------|---------------|
| server/fleet.mjs | `Fleet` class | 10-slot agent container + pub-sub | EventEmitter |
| server/agent.mjs | `Agent` class, `detectPrompt(text)` | wraps `claude` subprocess; streams JSON; detects approval prompts | child_process.spawn, fs |
| server/mockAgent.mjs | `MockAgent` class | replays fixtures (MC_MOCK=name) | fs |
| server/git.mjs | `isGitRepo`, `currentBranch`, `dirtyCount`, `aheadBehind`, `fullStatus` | read-only git introspection | child_process.spawn |
| server/repos.mjs | `listRecentRepos({limit, parents})` | discover recent repos by mtime | fs.readdir |
| tui/lib/sessionStore.js | `loadSessions`, `syncFromSnapshot`, `getResumeRecord`, `listResumeRecords`, `clearResumeRecord`, `listHistory`, `clearHistory` | persist slot→sessionId records | fs |
| tui/lib/costStore.js | `CostStore` class, `isoWeek`, `isoDay` | week/day cost buckets + persistence | fs |
| tui/lib/auth.js | `probeAuth({timeout})`, `authSummary(probe)` | `claude auth status` + summary | execFileSync |
| tui/lib/settings.js | `loadSettings`, `saveSettings`, `SETTINGS_DEFAULTS`, `SETTINGS_SCHEMA` | preferences load/save | fs |
| tui/lib/templateStore.js | `loadTemplates`, `getTemplate`, `listTemplates` | named session bundles | fs |
| tui/lib/format.js | `bar`, `barCells`, `sparkLine`, `fmtK`, `fmtMoney`, `trunc`, `fmtClock`, `humanize`, `fmtDuration` | string rendering helpers | — |
| tui/lib/models.js | `MODELS`, `MODEL_IDS`, `modelColor` | Claude model metadata | — |
| tui/lib/themes.js | `THEMES`, `DEFAULT_THEME` | 6 color palettes | — |
| tui/lib/usage.js | `readUsage`, `fmtReset` | reads `~/.claude/abtop-rate-limits.json` | fs |
| tui/lib/slashCommands.js | `SLASH_COMMANDS`, `matchSlash` | autocomplete catalog | — |
| tui/lib/slack.js | `postSlack` | feedback webhook POST | fetch |

---

## 3. Commands & hotkeys

### 3.1 App-level hotkeys (normal mode)

| Trigger | Handler | Purpose | In Help | Tested |
|---------|---------|---------|---------|--------|
| `?` | App.jsx | open help modal | ✓ | — |
| `,` / `esc` | App.jsx | open settings | ✓ | — |
| `b/B` | App.jsx | open broadcast | ✓ | — |
| `d/D` | App.jsx | open dashboard | ✓ | — |
| `q/Q` | App.jsx | arm quit (3s window) | ✓ | — |
| `y/Y` | App.jsx | confirm quit when armed | ✓ | — |
| `n/N/ctrl+n` | App.jsx | new session in next free slot | ✓ | — |
| `0-9` | App.jsx | jump to slot (0=10) | ✓ | — |
| `↑↓←→` / `hjkl` | App.jsx | grid navigation | ✓ | — |
| `↵` | App.jsx | zoom focused or launch new | ✓ | — |
| `p/P` | App.jsx | pause focused | ✓ | — |
| `r/R` | App.jsx | resume focused | ✓ | — |
| `K` (capital) | App.jsx | kill focused (arm-then-confirm) | ✓ | — |
| `a/A` | App.jsx | approve pending action | ✓ | — |
| `shift+tab` | App.jsx | cycle permission mode | ✓ | — |
| `/` | App.jsx | filter mode (or clear) | ✓ | — |
| `:` | App.jsx | command bar | ✓ | — |

### 3.2 Command-bar verbs (`:verb`)

| Verb | Handler | Purpose | In Help | Tested |
|------|---------|---------|---------|--------|
| `:q` / `:quit` | App.jsx:399 | exit | ✓ | — |
| `:theme <name>` | App.jsx:403 | switch theme | ✓ | — |
| `:cols 3/4/5` | App.jsx:411 | set grid columns | ✓ | — |
| `:perm <mode>` / `:perm default <mode>` | App.jsx:418 | session or fleet-default permission | ✓ | — |
| `:kill [slot]` / `:kill!` | App.jsx:447 | kill (! skips confirm) | ✓ | — |
| `:pause` | App.jsx:474 | SIGSTOP focused | ✓ | — |
| `:note <text>` / `:n` | App.jsx:484 | local annotation | ✓ | — |
| `:approve` / `:a` | App.jsx:494 | send generic continue | ✓ | — |
| `:resume [slot ...]` | App.jsx:504 | restore one or many | ✓ | — |
| `:resume-all` | App.jsx:560 | restore every recent-active | ✓ | — |
| `:history [n]` / `:hist` | App.jsx:572 | view-only last N (reference) | ✓ | — |
| `:forget <slot>` | App.jsx:588 | drop saved session | ✓ | — |
| `:sessions` / `:ls` | App.jsx:595 | list saved sessions | ✓ | — |
| `:help` / `:?` | App.jsx:604 | help modal | ✓ | — |
| `:whoami` / `:auth` | App.jsx:608 | re-probe auth | ✓ | — |
| `:dash` / `:dashboard` | App.jsx:616 | dashboard | ✓ | — |
| `:template` / `:tpl` | App.jsx:621 | list or launch templates | ✗ **undocumented** | — |
| `:cap [slot] <usd>` | App.jsx:663 | cost cap | ✗ **undocumented** | — |
| `:budget <usd>` | App.jsx:690 | daily spend budget | ✗ **undocumented** | — |
| `:cost` | App.jsx:704 | show running cost | ✗ **undocumented** | — |
| `:usage` | App.jsx:716 | show plan-side rate-limit | ✓ | — |
| `:repos` / `:repos clear` | App.jsx:727 | pick repo scan folder | ✓ | — |
| `:slack <url>` | App.jsx:738 | set Slack webhook | ✓ | — |
| `:feedback <msg>` | App.jsx:757 | feedback to Slack | ✓ | — |
| `:request <msg>` | App.jsx:757 | request to Slack | ✓ | — |

### 3.3 Slash commands (Zoom composer only — `/verb`)

| Slash | Purpose | Wired? | Notes |
|-------|---------|--------|-------|
| `/help` | reference | ✓ | Zoom.jsx |
| `/cost` | toast running cost | ✓ | Zoom.jsx |
| `/usage` | toast plan usage | ✓ | Zoom.jsx |
| `/quit` / `/exit` / `/close` | close zoom | ✓ | Zoom.jsx:712 |
| `/perm <mode>` | **ORPHAN — listed in SLASH_COMMANDS but no Zoom handler** | ✗ | TODO(slash-perm): wire it or remove from catalog |
| `/note <text>` | **ORPHAN** | ✗ | TODO(slash-note): wire it or remove |
| `/approve` | **ORPHAN** | ✗ | TODO(slash-approve): wire it or remove |
| `/pause` | **ORPHAN** | ✗ | TODO(slash-pause): wire it or remove |
| `/resume` | **ORPHAN** | ✗ | TODO(slash-resume): wire it or remove |
| `/kill` | **ORPHAN** | ✗ | TODO(slash-kill): wire it or remove |

### 3.4 Modal-internal hotkeys

| Modal | Hotkeys | Documented in Help? |
|-------|---------|---------------------|
| Zoom | shift+tab, ctrl+t, ctrl+s, pgup/pgdn, ctrl+u/d, shift+↑/↓, home, end/ctrl+g, ↑↓ (history/dropdowns), tab (autocomplete), 0-9/a-z (binary/select), a/r/y/n/1/2 (approve/reject), esc (close empty) | mostly ✓ |
| Settings | esc/,, tab, shift+tab, 1-9, ←/h, →/l, ↑/k, ↓/j, ↵/space | ✓ |
| Broadcast | esc, tab, space/↵ (chip toggle), ←/→ (chip nav), a/A (all) | partial ✗ |
| NewSession | esc, ctrl+b, ↑↓, ←/→ | ✓ |
| RepoPicker | esc, ↑/k, ↓/j, ←/h, →/l, ↵, . (pick current) | partial ✗ |
| Dashboard | esc/d/D, s/S (sort), r/R (rev), ↑↓, ↵ | **all undocumented ✗** |
| Help | esc/↵/? | ✓ |

### 3.5 Environment variables

| Var | Read by | Purpose | Tested |
|-----|---------|---------|--------|
| `CLAUDE_BIN` | main.jsx, agent.mjs, auth.js | override claude binary path | — |
| `MC_MOCK` | main.jsx, fleet.mjs | mock-fixture mode | ✓ (MockAgent.replay) |
| `MC_NO_TRANSCRIPT` | agent.mjs | suppress transcript writes (test infra) | (used by tests) |
| `MC_DEBUG_KEYS` | TextField.jsx | log every key event to `~/.config/claude-mc/debug-keys.log` | — |
| `ANTHROPIC_API_KEY` | auth.js | fallback API-key detection | — |

---

## 4. Orphan & dead-code flags

These are exports / handlers / advertised features with no corresponding
wiring. Each one is a candidate for either (a) wiring, or (b) removal —
listed here so the team can decide.

| Item | Location | Recommendation |
|------|----------|----------------|
| `/perm`, `/note`, `/approve`, `/pause`, `/resume`, `/kill` in SLASH_COMMANDS | tui/lib/slashCommands.js | **wire OR remove** — currently advertised, never handled |
| `loadTemplates()` export | tui/lib/templateStore.js | unused; only `getTemplate` + `listTemplates` consumed |
| `bar()` export | tui/lib/format.js | superseded by `barCells()`; only callsite is `barCells` |
| `currentBranch`, `dirtyCount`, `aheadBehind`, `isGitRepo` | server/git.mjs | only called internally by `fullStatus()`; consider de-export |
| `sawConfirmation` | server/agent.mjs:448 | assigned but never read — TODO(remove) |
| `Dashboard` modal hotkeys (s/r/↑↓/↵) | modals/Dashboard.jsx:125+ | **not documented in Help** — wire docs or drop |
| `RepoPicker` `. = pick current` | modals/RepoPicker.jsx:99 | **not documented** — wire docs or drop |
| `Broadcast` chip nav (space, ←/→) | modals/Broadcast.jsx:48 | **not documented** — wire docs or drop |
| `:template`, `:cap`, `:budget`, `:cost` | App.jsx runCommand | **not documented in Help** — add Help rows |
| `clearResumeRecord` | tui/lib/sessionStore.js | only via `:forget` verb — confirm intended scope |

---

## 5. Test coverage matrix

| Surface | Existing tests | Gap |
|---------|----------------|-----|
| TextField | TextField.test.jsx (6 tests) + recipes/textfield.recipes.test.jsx (2 PTY tests) | cursor positioning, paste, undo, Home/End — **none covered** |
| Zoom composer | Zoom.slash.test.jsx, Zoom.input.test.jsx, Zoom.chips.test.jsx, recipes/zoom.recipes.test.jsx | broad coverage; multi-line composer not covered |
| Fleet | none (only MockAgent.replay touches it) | **no direct Fleet test** |
| Agent | agent.reliability.test.mjs, agent.costCap.test.mjs | respawn race, kill, changePermissionMode — not covered |
| sessionStore | none | **no test** — schema migration, persist failure, history |
| costStore | none | **no test** — week/day rollover, GC, negative delta |
| settings | none | **no test** — load defaults, schema enforcement |
| templateStore | templateStore.test.mjs | basic; no test for missing file |
| auth | none | **no test** — claude auth status parse |
| git | none | **no test** — fullStatus parsing |
| repos | none | **no test** — listRecentRepos |
| format | none | **no test** — bar, sparkLine, fmtK, humanize |
| usage | none | **no test** — readUsage parse |
| slashCommands | slashCommands.test.mjs | basic matchSlash; no edge-case |
| slack | none | **no test** — postSlack |
| App.runCommand | none | **30+ verbs untested** |
| App hotkeys | none | **no test** — arrow nav, slot jump, kill/quit arm |
| Header/Aggregate/Card/FleetLog/StatusBar | Card.tier.test.jsx (one) | rest **untested** |
| NewSession/Settings/Help/Broadcast/Dashboard | NewSession.test.jsx, RepoPicker.test.jsx | Settings/Help/Broadcast/Dashboard **untested** |

---

## 6. Refactor candidates (large/mixed components)

| File | LOC | useState | Concerns mixed | Split into |
|------|-----|----------|----------------|------------|
| tui/App.jsx | 1389 | 23 | fleet sub + commands + hotkeys + modals + toasts + sessions + cost + auth | hooks: useFleetSnapshot, useToasts, useCommandDispatch, useSessionManager, useAuthProbe + ModalRouter + HotkeysManager |
| tui/modals/Zoom.jsx | 1129 | 13 | scroll state + composer + awaiting prompts + autocomplete + log render | hooks: useZoomScroll, useZoomComposer, useZoomAwait + components: ZoomLog, ZoomComposer |
| tui/modals/NewSession.jsx | 278 | 6 | repo discovery + UI | hook: useRepoSearch |
| tui/modals/RepoPicker.jsx | 182 | 5 | fs nav + scroll window | hooks: useFsNav, useListScroll |

---

## 7. How to read this doc going forward

- "Refactor?" column = severity of split-needed signal (CRITICAL > HIGH > extract > ok)
- "In Help" / "Documented" = does the user-facing Help modal mention this trigger?
- "Tested" = does any file under `tests/` cover this code path?
- Orphans here are tracked in `IMPROVEMENTS.md` under the **TODO-REMOVE** bucket
- Refactor splits are tracked in `IMPROVEMENTS.md` under the **ARCHITECTURE** bucket
