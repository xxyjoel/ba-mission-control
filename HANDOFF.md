# HANDOFF — ba-mission-control

## Current state

**2026-07-18 — PH-release prep: security review, social preview PNG, demo GIFs**
— On branch `fix/fleetlog-escape-strip-and-social-preview` (PR pending). (1)
**Security review** (full tree + full git history): no glass-worm/invisible-Unicode,
no secret keys in tree OR history, clean supply chain. One **Medium fixed** —
`FleetLog.jsx` rendered untrusted `claude` stream output (asst/user/bcast/err)
raw; now routes every kind through `humanize()` (strips OSC/CSI/C0), closing a
terminal-escape passthrough from the passive fleet view. Report at
`docs/audit/SECURITY-REVIEW-2026-07-18.md`. FleetLog suite green (7/7). Minor
open: 7 public commits carry `joelproctor@…local` author email (metadata only —
recommend `git config user.email` to noreply, NOT a history rewrite). (2)
**Visuals generated** (finishes two REMAINING launch items below): rasterized a
clean 1280×640 `assets/social-preview.png` via `@resvg/resvg-js` (fixed the SVG's
chip overlap + drew the flag as vector since color emoji won't rasterize); and
recorded all four `assets/*.gif` (hero/zoom/themes/dashboard) via VHS against
`MC_MOCK` fixtures. Fixed every tape's session-launch flow (the NewSession modal
needs a valid dir → type `~` before Enter). Recorded with an isolated `$HOME` so
no real `~/.config/claude-mc` state is touched and no DEV/sandbox banner shows.
GOTCHA: VHS needs `vhs`+`ttyd`+`ffmpeg` (brew) and a system Chrome; isolate via
`HOME=/tmp/<name>` NOT `MC_CONFIG_DIR` (the latter triggers the sandbox banner).

**2026-07-16 — 🚀 PUBLIC: clean-history repo is live and open source**
— The project is public at github.com/xxyjoel/ba-mission-control (AGPL-3.0).
Because ~30 closed/merged PRs + the `v0.2.0` tag would have exposed the old
pre-squash history (personal paths/email) and PRs/tags can't be deleted on
GitHub, we did NOT flip the original repo — instead: (1) deleted all 17
non-main branches, (2) renamed the original private repo →
`ba-mission-control-private` (keeps full history + PRs + tag as a private
backup), (3) created a FRESH public `ba-mission-control`, (4) pushed **main
only** — the 7-commit clean squash, no tags, no other refs. Verified against
the live public remote: **0 PII blobs, 0 secret blobs**, `main` is the only
branch, no tags. `origin` now points at the public repo (private backup is not
wired as a remote here). REMAINING to finish the launch (public repo now
exists): GitHub settings (Pages → main /docs, secret scanning + push
protection, branch protection, topics, upload social-preview.png); generate
`assets/*.gif` (`vhs tapes/*.tape`) + rasterize social-preview.svg→png; npm
publish + Homebrew tap + sha256; brand kit → tokens.css; CoC email; tag
v1.0.0. NOTE: forge `tasks/` is gitignored on the public repo (dev-internal);
the private backup retains it. This HANDOFF is the tracked progress record.

**2026-07-15 — fix: "Maximum live sessions" (maxSlots) applies live**
— Suite green (76 files). maxSlots persisted but the Fleet was sized once at
boot, so changing it in Settings did nothing until an mc restart (read as
broken). Added `Fleet.setSlots(n)` (grow appends empty slots; shrink floors at
the highest occupied slot; clamped [1,64]; emits change) wired from App.jsx on
`settings.maxSlots` change, mirroring the `setCostCap` effect; toasts if a
shrink was clamped. Updated the setting desc + boot comment. The 3 App
`FakeFleet` stubs gained `setSlots`.

**2026-07-15 — fix: transient api retries no longer spam red "api error" log lines**
— Suite green (76). `jsonlConnector.mjs` api_error handling kept the card
`working` through claude's transient retries (correct) but still pushed a red
`kind:'err'` tail line for EVERY one — flooding the log with alarming "api
error" lines on healthy sessions (1200+ ECONNRESETs in a single session). Now a
transient retry emits a calm `kind:'sys'` "api retry · CODE (n/max)" line;
only exhausted retries (`attempt >= max`) stay red `err` + errored status. Test
`jsonlConnector` mid-retry updated (asserts `sys`, not `err`); exhausted case
unchanged.

**2026-07-13 — chore: open-source launch prep + clean-history public release**
— Suite green (76 files). Publishing as `@bluearch/mission-control` under
**AGPL-3.0** as a squashed clean-history release that **includes** the sub-agent
fan-out feature (see the entry below). Plan: `.claude/plans/oss-launch.md`.
Shipped this session:
1. **Matrix theme** — green-phosphor palette in `tui/lib/themes.js` +
   registered in the COLORS settings group; `:theme matrix`. BlueArch stays
   default. New `tests/themes.test.jsx` guards every palette has all 12 tokens.
2. **Packaging** — `package.json`: dropped `private`, scoped name to
   `@bluearch/mission-control`, v1.0.0, added license/repo/homepage/keywords, a
   `files` allowlist (ships bin/tui/server + fix-node-pty + README + LICENSE
   only), `publishConfig.access=public`. Added AGPL-3.0 `LICENSE`.
3. **Hardening** — `hookSettings.mjs` quotes node+emitter paths (spaces-in-path
   safe). `forge-ci.yml` gained a non-blocking `npm audit` job.
4. **Privacy** — removed the maintainer's personal Google-Drive path from
   `repos.mjs` DEFAULT_PARENTS (**real leak the initial audit missed** — it was
   in the shipped `files` set), deleted `docs/notes/probe-pty.txt`, genericized
   the username in one hook-event fixture + a `sessionFileTailer` comment.
   Entire tracked tree now clean of personal identifiers.
5. **Marketing** — README hero (tagline, made-in-USA slogan, badges, hero-GIF
   slot), "Who this is for", "Why not tmux or cmux?" table, npx quick-start,
   themes section. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`,
   PR template. VHS tapes (hero/zoom/themes/dashboard) + workflow docs.
   Single-page GitHub Pages landing at `docs/index.html` (Matrix aesthetic;
   brand tokens isolated in `docs/assets/tokens.css`). Social-preview card
   `assets/social-preview.svg` (1280×640; rasterize to PNG per assets/README.md;
   wired as the landing `og:image`).
**OPEN / INPUTS NEEDED before publish:** (a) **BlueArch brand kit** (fonts +
palette) to finalize `docs/assets/tokens.css` and the landing design — currently
seeded from the Matrix/BlueArch palettes. (b) **Generate the demo GIFs**:
`brew install vhs && vhs tapes/hero.tape` → `assets/hero.gif` (README + landing
reference it via absolute raw-GitHub URLs; broken until committed to `main`).
(c) **CoC enforcement email** placeholder in `CODE_OF_CONDUCT.md`. (d) Confirm
the `@bluearch` npm org exists / publish access (nothing published yet). (e)
Enable GitHub Pages → `main` `/docs`. (f) Repo metadata assumes remote
`github.com/xxyjoel/ba-mission-control` — update if it moves to a `bluearch` org.
**GOTCHAS:** AGPL network-copyleft has limited practical effect on a local TUI
but is a valid strong-copyleft choice; permissive MIT deps are fine to
redistribute inside it. `tasks/` + `.claude/` are excluded from the npm tarball
but are still public on GitHub — decide whether to keep forge task state public.

**SECURITY AUDIT (pre-publish, 2026-07-13):** Scanned all 2,535 blobs across all
378 commits. **No secrets anywhere** — zero API keys/tokens/AWS/GitHub/Slack
creds/private keys/webhooks in the working tree OR full git history; no `.env`
or real `settings.json`/transcripts ever committed; postinstall only `chmod`s
node-pty's helper (no network/exec). Hardened `.gitignore` to block future
accidental commits of `settings.json` (holds a Slack webhook when configured),
session/cost state, and key/cert files. **REMAINING (not keys — a privacy
decision):** history still contains personal data in ~56 old blobs
(home-dir paths, a personal email) and commit-author metadata (a personal email
+ a local machine hostname). Working tree is clean; history is not. Options before going public: (1) accept it (normal for
solo OSS — author email is expected), (2) squash to a single commit via an
orphan branch, or (3) `git filter-repo` to redact paths + rewrite author. Also
do NOT commit the untracked `tasks/archive/batch-*` or `.claude/plans/` — they
carry personal paths (now gitignored for plans). Also added: SECURITY.md
private-vulnerability-reporting channel + supported-versions, `.github/
dependabot.yml` (weekly npm + actions), and `docs/RELEASE-CHECKLIST.md`
consolidating the remaining human/account steps (history decision, GitHub
security settings, npm publish, tagging). Later adds: `.github/FUNDING.yml`,
a Homebrew formula scaffold (`packaging/homebrew/mission-control.rb` + setup
README; needs `npm publish` then the tarball sha256), README Homebrew install
tier, and the social-preview card. NOTE: global `mc` is an `npm link` symlink
(`/opt/homebrew/bin/mc` → this repo), so it runs whatever branch is checked
out — restart `mc` after switching branches to pick up e.g. the Matrix theme.

**2026-07-12 — feat: surface parallel sub-agents on cards + count their token/cost spend**
— Uncommitted, suite green (75 files). Two related threads, both about sub-agent
(sidechain) visibility.
1. **Fan-out on the card** — server pairs `Task`/`Workflow` `tool_use`→
   `tool_result` into a live `pendingSubagents` map (both pipelines +
   `eventShapes.subagentLabel`/`SUBAGENT_TOOLS`), exposed as
   `activeSubagents` on the snapshot. Card current-item row shows `⋔{n}`
   (count, or the single agent's label); Zoom lists each with elapsed. STUCK is
   suppressed while fan-out is outstanding (sub-agents work on sidechains the
   main thread can't see → activity clock goes quiet but isn't wedged). Retires
   the `TODO(fanout)` in `Card.jsx`.
2. **Sub-agent token + cost accounting** — new `server/subagentUsageTailer.mjs`
   watches `<sessionId>/subagents/agent-*.jsonl` (verified on-disk layout) and
   folds each sidechain's `message.usage` into the parent's `tokensIn`/
   `tokensCacheRead`/`tokensOut`/`costSession` + tok-min spark (NOT `ctx`).
   Fixes the "tok/min doesn't include all agents / totals way off" report —
   fan-out spend was entirely invisible (main tailer reads one file). Wired into
   ptyAgent as `this.usageTailer` (started on spawn, stopped at all 3 teardown
   sites). Resume-safe: files present at attach are primed at EOF; files
   appearing after are read from 0.
**GOTCHAS:** (a) the "waiting for background agent to finish" IDLE case is NOT
fixed here — a `run_in_background` Task returns its tool_result immediately, so
the pending-map/PTY-banner signal for that specific case is still open (plan:
`.claude/plans/background-agent-status.md`, needs a real PTY sample). (b) cost
for sub-agents uses `deriveCost(usage, message.model)` — the sidechain model is
a cli id (`claude-*`), resolved via `lookupByCliModel`.

**2026-07-09 — fix(status): working session reads idle on thinking/text-only turns**
— On `fix/status-working-shows-idle`, suite green (73). A hooked session that
starts a turn with no tool call (pure thinking/text) had no lifecycle event to
flip it to 'working': registered hooks were only Notification/PreToolUse/Stop,
and only PreToolUse maps to 'working'. So it stayed parked on the prior
Stop→idle until the JSONL connector caught a streamed event (behind the ~1.5s
stat-poll; nothing written during a long think) — the card read 'idle' while
claude was actively generating. Fix: register a **UserPromptSubmit** hook
(`hookSettings.mjs`) and map it → 'working' (`statusHookTailer.mjs`); Stop still
resets to idle at turn end. Emitter needed no change (forwards any event name).
Paired tests in map + hookSettings suites.

**2026-07-09 — fix(card): correct model label + de-inflate tokens-in display**
— On `fix/status-false-input-and-card-triage`, suite green (73 files). Two
card-metric display bugs reported live this session.
1. **Model label froze at launch/init value** (`server/agent.mjs`): the card
   reflects `agent.resolvedModel`, but that was only captured from the `init`
   event — the assistant handler ignored `ev.message.model`, the field claude
   stamps on every assistant message. So a mid-session `/model` switch (or a
   resumed session whose real model differed from init) never updated the card
   (repro: slot [3] showed OPUS 4.7 after switching to 4.8). Fix: track
   `resolvedModel` from each assistant message. Card repoints on the next turn.
2. **Tokens `in` inflated ~100× by cache re-reads** (`agent.mjs`,
   `jsonlConnector.mjs`, +producers): `tokensIn` summed `input + cache_creation
   + cache_read` cumulatively. `cache_read_input_tokens` re-reads the whole
   window every assistant message, so it dwarfed the headline (67M "in" on a 60k
   ctx). Now `tokensIn` = fresh input only; cache reads broken out into
   `tokensCacheRead`, surfaced as `cache` in Zoom. `ctx` unchanged (still full
   window = size on the wire); cost unchanged (already priced cache at 0.1×);
   spark still fed total processed. Persisted in sessionStore + restored in App.
**GOTCHAS:** (a) no paired unit test for fix #1 — `#handle`/`#onStdout` are
private and MockAgent uses its own interpreter, so a regression test needs a
fake-proc stdout harness (deferred). (b) `TODO(opus-4.8-pricing)` in `models.js`
still mirrors 4.7 rates — that's the "unknown model default rate" health flag,
unrelated to these fixes.

**2026-07-07 — fix(status): false INPUT? on working sessions + card triage-row redesign (0256)**
— Uncommitted on `main`. Two independent threads; suite green (Card 17, status 57,
approval 14).
1. **False `INPUT?` fixed** (`server/ptyAgent.mjs`): a hooked+working session
   (`hookStatus==='working'`) only reads `waiting` via `#scanApprovalPrompt()` — a
   regex scrape of the rendered PTY. That triad (`do you want to` + `1. Yes` +
   `No, and/keep`) appears in ordinary *content* a working session renders (its own
   `approvalPrompt.test.mjs`, the detector source, a web page), so it false-flipped
   actively-working cards to INPUT? (repro: this MC session + auto-job-applier +
   crm-helper). Fix: gate the scrape on `!ptyFresh` — a real prompt BLOCKS the
   session so output settles; a working session streams bytes continuously. A
   genuine prompt re-qualifies ~`WORKING_FRESH_MS` after paint, still ahead of the
   ~10-20s permission_prompt hook. The existing approval tests only covered the
   *un-hooked* branch (why it slipped) — added a hooked-path repro test.
2. **Card triage-row redesign** (`tui/Card.jsx`): the centered health bar is
   replaced by a **triage row** — todo burndown (`▸ 5/7 ████░░ <verb>`) + a
   status-driven next-action verb (`check back` / `ready to review →` /
   `needs a nudge →` / `needs input · answer to continue`), colored by urgency —
   plus a **current-item** row (`↳ <in-progress activeForm>`). Health demoted to a
   small `●<score><trend>` dot in the vitals row (matches Zoom's glyph). The
   untrusted verdict *string* is no longer rendered on the card, so its
   escape surface is gone (supersedes the 0181 Card humanize path). Layout
   invariant holds (11 rows, no overflow, all widths). Zoom brought to parity —
   its `verdictWord` render is now `humanize()`d (closes the 0181 sibling gap).
**GOTCHAS:** (a) triage verbs are **status-driven** — they depend on the status
fix above being correct. (b) The richer "active subagents/workflows" signal is
deferred: no active-count on the snapshot (tail holds 16 events, never pairs a
`Task`/`Workflow` tool_use with its result). `TODO(fanout)` in `Card.jsx` specs
the server work (pending-tool map → `agent.activeSubagents`, render `⋔n`).

**2026-07-06 — feat(grid): card-grid redesign — append placement · stats-only cards · paginated panes (t1-t7)**
— Three feedback threads shipped on branch `forge/card-grid-redesign/t1-append-slot`
(all committed, **not pushed** — user chose to hold). Suite **73 files green**.
1. **Append-to-bottom placement** (`t1`): new `tui/lib/slots.js` `nextLaunchSlot()`
   — new sessions land below the last active card instead of backfilling a
   killed-slot hole (hole-fill only when there's no room to append). Wired into
   the `n`/`Ctrl+N` + Enter-on-empty sites in `App.jsx`. Slot index still = digit
   hotkey. 6 unit tests.
2. **Stats-only card** (`t2-t4`): `Card.jsx` drops the 3 tail rows + activity line
   (the only variable-height rows → unpredictable shapes). Now pure stats at fixed
   `height=11`: centered health row (promoted out of the foot chip), TODO progress
   (`agent.todos`), vitals (turns/msgs/uptime/state-age). Added `fmtDurShort()` to
   `format.js`. Replaced obsolete `Card.tier.test` with `Card.stats.test`.
3. **Paginated panes** (`t5-t7`): extracted pure `tui/lib/gridLayout.js`
   `computeGridLayout()` (testable — injects termRows; ink-testing can't) with the
   pane model, added `windowsPerPane` setting (default 9), wired into `App.jsx`
   replacing the old clip-prone scroll viewport. `[` / `]` switch panes; active
   pane follows focus. Retires `TODO(grid-overflow)` ("10th session collapses the
   grid"). Help + README updated.
**GOTCHAS:** (a) `computeGridLayout` guards non-finite terminal dims — a non-TTY
stdout reports `rows=undefined` → NaN would slice zero cards → empty grid; keep
that guard. (b) `showTools` prop on `Card` is now a no-op (TODO to remove). (c)
Per-pane count is `min(windowsPerPane, what-fits-terminal-height)`, so a short
terminal pages more aggressively than the setting — by design (never clip). (d)
Plan: `.claude/plans/card-grid-redesign.md`.

**2026-07-01 — feat(status): regex scraping RETIRED behind the hook feed (973bf6f, 0248-0255)**
— With the feed proven live (0248), `toJSON()` now branches on `hookStatus`:
**hooked** sessions (hookStatus != null) are driven by Claude's lifecycle events —
`waiting`→waiting; `working`→**sticky until Stop** (covers the 0198 intra-turn
end_turn flash with NO `#scanWorking`); `idle`→wins when fresher than
`lastConnectorTs`, else connector (text-only-turn safe). The **only** scraper in
the hooked path is `detectApprovalPrompt`, gated to `hookStatus==='working'` as
the instant-INPUT fast-path (permission_prompt is a delayed ~10-20s hook).
**Un-hooked** sessions (legacy `FLEET_USE_PTY=0` Agent, or a PTY session before
its first hook event) keep the full `#scanWorking`/`#scanApprovalPrompt` overlay —
so the scrapers are RETAINED for fallback, just gated out of the normal path.
Removed the temp MC_DEBUG status probe (0254). **Re-verified live** (real Write
dialog): working→waiting→idle unchanged. Suite 71 files green. **Design notes:**
0252 = keep detectWorking (fallback only); 0253 = partial-by-design (retired from
hooked path, retained for fallback). **GOTCHA:** `detectWorking`/`detectApprovalPrompt`
still exist and matter for un-hooked sessions — don't delete them.

**2026-07-01 — VERIFIED LIVE + fix(status): hook freshness compares against JSONL-only clock (df18b83)**
— Real-app /verify (real claude 2.1.176, real PtyAgent, real Write permission
dialog) drove the feed end-to-end: **working → waiting → idle**, with
`connector=working` (stuck/wrong) in EVERY state and the hook correctly winning —
proving both bug reports fixed ("working at an input" → waiting; "working but
idle" → idle). **The verify caught a shipping bug:** the 0229 merge compared
`hookStatusTs > lastEventTs`, but `onData` bumps `lastEventTs` on every PTY byte,
so claude's constantly-repainting TUI (update banner/health chip/spinner) kept
the connector "fresher" than any Stop hook → cards stuck on 'working' forever
(unit tests passed only because they pinned lastEventTs old). Fix: new
`agent.lastConnectorTs` bumped ONLY by `jsonlConnector.parseEvent`; `hookWins`
compares against that. **GOTCHA for future work:** any freshness/staleness logic
must use `lastConnectorTs` (JSONL-only), NOT `lastEventTs` (PTY-polluted). This
also satisfies the **0248 "feed proven in real use"** gate → the retire-scraping
cluster (0250 gate-regex, 0251-0255) is now unblocked.

**2026-07-01 — feat(status): hooks-based-status-feed — producer + tailer + source-of-truth merge SHIPPED (fixes the "working but idle / working at an input" class at code level)**
— Built the full pipeline this session (71 test files green): `server/statusFile.mjs`
(`statusFilePath`), `server/hooks/emit-status.mjs` (emitter), `server/hookSettings.mjs`
(`buildHookSettings`), `--settings` injection in `ptyAgent.start()`,
`server/statusHookTailer.mjs` (`mapEventToStatus` + `createReadCore` + `startStatusHookTailer`
watch/poll/stop → sets `agent.hookStatus`/`hookStatusTs`, emits 'change' on transition),
tailer wired into PtyAgent lifecycle, and the `toJSON()` merge. **Precedence (checkpoint
0283):** `hookStatus==='waiting'` (permission_prompt) ALWAYS wins; for working/idle the
FRESHER of hook vs connector wins (`hookStatusTs > lastEventTs`) — handles both
stuck-on-working AND text-only turns (no PreToolUse); STUCK suppressed when `hookWins`.
**Key spike finding:** `Notification:permission_prompt` is a DELAYED push (~10-20s), so a
narrow gated regex stays as the instant-INPUT fast-path (hybrid; retire-scraping cluster
0248-0255 is gated behind 0248 "feed proven in real use"). **Takes effect on RELAUNCH** —
a session already running has no injected hooks until re-spawned; and this is NOT yet
verified end-to-end in the real app (unit/integration only). Tasks done: 0201-0203, 0204,
0207, 0210-0214, 0220-0223, 0226, 0229, 0261-0264, 0283 (+0281/0215/0216 OBE). **Next:**
real-app /verify of ③; then hardening (0245 StopFailure, 0231-0234 resume/sid-rotation,
0246/0247 stale-file/EOF, 0235/0236 degrade, 0265-0291 UI reflection), then retire-scraping
behind 0248. **Also filed:** UI bugs 0302 (six-cards grid clip) + 0303 (tool-visibility UX).

**2026-06-30 — feat(status): new goal `hooks-based-status-feed` — replace regex scraping with Claude's hook events (spike done, GO)**
— Live bug recurred: sessions awaiting a permission prompt read WORKING. Root
cause is structural — the JSONL has no permission event, so status leans on a
fragile terminal-regex overlay (`detectApprovalPrompt`/`detectWorking`) that
drifts whenever claude rewords a prompt (the 0180/0198/0200 bug class). New
goal: derive status from Claude Code's own hook events. Verified `claude
2.1.176` supports `--settings <file-or-json>` (per-invocation injection, no
global/repo config touched) and the hook events fire in interactive PTY.
**Spike (0259/0260/0261/0201) ran against real claude** — all 4 events captured
verbatim to `tests/fixtures/hookEvents/spike-0260-capture.ndjson`. **Key
finding:** `Notification:permission_prompt` is a DELAYED push (~10–20s after the
dialog), not on-show; `PreToolUse` is instant; `Stop`/`idle_prompt` clear state.
**Decision (hybrid):** hook events = source-of-truth for working/idle;
`detectApprovalPrompt` KEPT but **gated to an outstanding-PreToolUse window**
for instant INPUT; `permission_prompt` = ≤20s backstop. Full design +
contract in `.claude/plans/hooks-based-status-feed.md`. Decomposed into 101
tasks **0201–0301** (`tasks/_plan.md`), spike committed (`32f964b`).
**Next:** 0203 checkpoint (`--settings` JSON-string vs per-slot temp file),
then emitter (0204–0209) + injection (0210–0216) + statusHookTailer (0217–0225)
fan-out. Retire-scraping cluster (0248–0255) is gated behind 0248 (feed proven
in real use). NOTE: 0250 revised from "remove" to "gate" detectApprovalPrompt.
**Carry-over:** `server/ptyAgent.mjs` has an uncommitted MC_DEBUG status-probe
(pre-existing this session) — belongs with the impl phase (task 0254 removes it).

**2026-06-29 — fix(status): idle→working overlay false-positive (0200, fixes 0198)**
— After 0198, idle sessions read WORKING and never reverted ("cloud eff",
"linkedin extractor", "crm helper" all stuck on WORKING while idle). Cause: the
terminal scan alone — an idle session emits no bytes, so its last working frame
(with the `esc to interrupt` hint) lingers in the xterm buffer with nothing to
clear it, and `#scanWorking()` kept matching forever. Fix: new `lastPtyTs`
(PTY-only clock, bumped only in `onData`, NOT by jsonlConnector like
`lastEventTs`); the overlay now requires `#scanWorking()` AND fresh PTY output
(`< WORKING_FRESH_MS` = 2500ms). Live spinner (hint + bytes) → working; frozen
frame (hint, silent) → idle; clean finish (bytes, hint gone) → idle, no flicker.
New false-positive guard test; suite green (59 files). Residual risk: a future
claude that repaints an idle composer could defeat the freshness guard (TODO:
pin `detectWorking` against a real PTY capture).

**2026-06-28 — feat: Session Health surfaced inside ba-mc (0199)**
— The session-benchmarking Stop hook writes a 0-100 composite per turn to each
project's `.project-health/history.jsonl`, but it was only visible in the claude
statusline (interactive only) — never in ba-mc. Now: `tui/lib/projectHealth.js`
tail-reads that file (per-cwd TTL+mtime cache, parses complete lines from the
end), and a `●<score><trend>` chip renders on the **card foot row** (colored by
verdict) + a `health ●<score> <verdict>` segment on the **zoom compact stats
line** (visible without toggling ⌃U). mc only READS the score. New
`tests/projectHealth.test.mjs` (5 cases); suite green (59 files). README +
task 0199.
**Gotcha / follow-up (other repo):** the benchmarking tool flags `claude-opus-4-8`
as an *unknown model* and falls back to a default cost rate, so its
`session_cost_usd` probe is miscalibrated for Opus 4.8 — fix belongs in the
`session-benchmarking` repo's model rate table, not here.
**Hotkeys:** ⌃S/⌃T complaints were a STALE BUILD — current code already uses ⌃U
(stats) / ⌃K (tools) and forwards ⌃S/⌃T to claude (decided: keep, just restart).
**Restart/launch path (verified):** `mc` = Homebrew bin symlinked to
`/opt/homebrew/lib/node_modules/ba-mission-control`, which is itself a symlink to
THIS dev repo; HEAD matches. No build step (tsx runs .jsx). So quitting +
relaunching `mc` runs the new code — 0198/0199 take effect on restart. Card chip
verified via a real ink render (`●86↑` on the foot row).
**0198 caveat (known):** the idle→working overlay keys off the literal
`esc to interrupt` phrase in claude's rendered terminal — matched from live text,
NOT a captured fixture. Hardened to not require the leading "(" (version drift),
but if claude rewords the hint the overlay silently stops (fail-safe: reverts to
the old turn-boundary IDLE flash, never crashes). TODO: pin `detectWorking`
against a real PTY capture in a recipe test.

**2026-06-28 — fix(status): overlay idle → working at the turn-boundary gap (0198)**
— Cards showed **IDLE while actually WORKING**. Root cause: `jsonlConnector`
writes `idle` at turn boundaries (`system/turn_duration` unconditionally;
assistant `end_turn` w/ no prompt), but claude emits those markers *mid-work*
and keeps streaming — next `tool_use` lands 3–14s later — with no heartbeat to
re-assert `working`. Widened on cloud-synced session files (the user's "cloud
efficiency metrics" project) where `fs.watch` never fires and the tailer leans
on the 1500ms stat-poll. Fix: `PtyAgent.toJSON` now overlays `idle → working`
when the rendered terminal still shows claude's `(esc to interrupt)` active-turn
indicator (`detectWorking` + `#scanWorking`, mirroring the approval-prompt scan).
Derived on read → self-clears when the idle composer appears; STUCK still keys
off `_statusValue` (stays idle, never accrues). New `tests/workingOverlay.test.mjs`
(7 cases); full suite green (58 files). README "Session states" + task 0198 logged.
Chose a terminal scan over a `lastEventTs` timer (the idle-setting JSONL line
bumps `lastEventTs`, and a timer flickers `working` after every clean finish).

**2026-06-28 — docs: HOTKEYS.md reflects zoom Ctrl+Q/Y/K/U/J rewrite**
— Brought `docs/HOTKEYS.md` in sync with the shipped zoom chrome-key scheme.
Chrome keys now documented as living in `tui/zoom/zoomKeys.js` (single source of
truth, all in the `Ctrl+A..Z` range Ink reliably delivers). The five PtyPane
intercepts are now `Ctrl+Q` (exit, was Esc/`Ctrl+]`), `Ctrl+Y` (scroll mode),
`Ctrl+K` (tools, was `Ctrl+T`), `Ctrl+U` (stats, was `Ctrl+S`), `Ctrl+J`/`Shift+Enter`
(newline). `Esc`, `Ctrl+T`, `Ctrl+S`, `Shift+Tab` are now forwarded to claude;
conflict matrix + forwarding tables + the "scroll bindings" section updated to
SHIPPED. Also gitignored `.project-health/` (local session-health telemetry).
Docs-only; no code change.

**2026-06-27 — zoom: permission-prompt status detection + correct footer hints**
— Two fixes. (1) **WORKING+STUCK → INPUT?** — `PtyAgent.#scanApprovalPrompt`'s
question anchor `APPROVE_Q_RX` only matched "Do you want to **proceed/continue**",
so Edit/Write/Run permission prompts ("…make this edit to X?", "…create X?",
"…run this command?") never flipped the card to `waiting`; it sat on `working`
and after 5 min painted a red STUCK chip. Broadened the anchor to
`/\b(?:do|would) you (?:want|like) to\b/i` (the strict `1. Yes` + `No, and/keep`
anchors still guard against prose false-positives). Also: `toJSON` no longer
accrues `stuckMin` while the approval overlay is active — a session parked on a
prompt is waiting on the USER, not wedged. A genuinely silent `working` session
with no prompt STILL flags STUCK (covered by a new test). Net: such a card now
reads **INPUT?** with a **yellow** border, no STUCK. (2) **zoom footer was
lying** — it advertised `Esc Esc` exit / `⌃T` tools / `⌃S` stats / `⌃]` exit,
none of which are the real bindings (those forward to claude / are dead). The
toggles always worked via the real keys; the footer just pointed at the wrong
ones. Corrected `Zoom.jsx` footer to mirror `zoomKeys.js`: **`⌃Q` exit · `⌃J`
newline · `⌃Y` scroll · `⌃K` tools · `⌃U` stats**; `Esc · ⇧⇥ → claude`. README's
zoom table was already correct — only the in-app footer had drifted. Tests:
`approvalPrompt.test.mjs` gained edit/write detection + STUCK-suppression cases.
All 57 test files pass. (Also logged, not yet implemented: session-resume
integrity tasks 0194–0197 in `tasks/open/`.)

**2026-06-27 — session persistence + context accuracy + discrete update banner**
— Branch `forge/session-persistence-accuracy`. Four threads:
(1) **ctx accuracy** — `jsonlConnector` now ignores `isSidechain` turns when
setting `agent.context` (sub-agent turns no longer dive the gauge); current
claude writes sub-agents to a separate `subagents/*.jsonl` the tailer skips, so
this is defensive. (2) **`/clear` reset** — the old `/clear` reset was DEAD CODE
(checked the `local_command` system event, whose content is only stdout); `/clear`
actually arrives as a `type:"user"` `<command-name>/clear</command-name>` message.
Moved detection to `handleUser` and extended it to zero `ctx` + `tokensIn` +
`tokensOut` + `costSession`. (3) **save-is-opt-in lifecycle** — QuitConfirm now
offers `[s] save & quit` / `[d] quit, no save` / `[n]` cancel. `sessionStore`
gained `setQuitMode('save'|'clear')`: `save` writes the full record (sessionId +
in/out/cost totals); every other exit (incl. SIGHUP/SIGINT/SIGTERM via
`main.jsx` shutdown) writes LOCATION-ONLY (`fresh:true`, no sid) so `:resume-all`
reopens repos fresh. `launchFromRecord` branches fresh-vs-full and seeds saved
totals on a full resume. `tryRead` keeps `fresh` records despite no sid. Per-slot
crash recovery during a live session still resumes (default mode is `save`).
(4) **update banner** — `PtyPane` detects claude's own "update available" row
(`claudeBanner.js` matcher), blanks it from the zoom body, and `Zoom` shows a
discrete `⬆ update` chip on the right of the header. Setting
`hideClaudeUpdateBanner` (default on, LAYOUT). Tests added: sidechain guard,
`/clear` reset, `sessionStore.quitmode`, `claudeBanner`; 4 recipe/snapshot tests
updated for the new quit keys. All 57 files pass under a normal color env.
NOTE: pre-existing `Card.tier.test.jsx` fails ONLY when `FORCE_COLOR` forces ANSI
into `lastFrame()` (harness artifact) — green on a normal dev/CI env.
Not yet live-verified: real save→resume cycle + suppression vs a real banner.

**2026-06-27 — CI green: exclude PTY recipe suite on the headless runner (0192)**
— Same branch/PR #32. 0190 (poll) + 0191 (chmod all prebuilds) were necessary
but NOT sufficient: node-pty emits EMPTY frames on ubuntu-latest even for the
trivial counter-app fixture — backend non-functional on the runner, not
reproducible on macOS (no Linux prebuild locally). To restore the merge gate
without more blind CI cycles: new `scripts/run-tests.mjs` replaces the
find|xargs `npm test` one-liner and, under `CI=true` (set `MC_RUN_PTY=1` to
override), excludes REAL-TERMINAL tests — `tests/recipes/*` (node-pty) AND
`*.realparser.test.*` (ink raw-keypress parser, returns undefined for control
bytes like Ctrl+Q in a non-TTY) — with a logged count. They still run locally +
on every push (pre-push runs `npm test`, CI unset). `CI=1 npm test`: 12 excluded,
43/43 pass. Restoring real CI terminal coverage = OPEN task 0193
(diagnose linux node-pty: missing prebuild vs spawn-helper vs source build;
then swap the blanket exclusion for a runtime PTY probe → skip-not-fail).

**2026-06-27 — fix headless-CI PTY flakiness: poll frames + chmod spawn-helper (0190, 0191)**
— Branch `forge/ci-pty-stability/poll-frames` (PR #32). forge-ci `tests` had been
red on `main` 1+ day; all failures were `pty:` recipes. Two root causes, two
fixes: (0190) `tests/lib/recipe-pty.js` checked the frame ONCE after a fixed
delay — replaced with `waitForFrame()` poll-until-match (≤8s, returns on first
match so fast runs pay nothing; per-step `timeout` override; `expectExit` default
2000→4000). (0191) — but recipes STILL showed EMPTY frames in CI (even the
counter-app fixture): the `postinstall` `scripts/fix-node-pty.mjs` chmod'd only
`prebuilds/darwin-*/spawn-helper`, so the linux-x64 CI helper kept npm's stripped
non-exec mode → `pty.spawn` emitted nothing. Now enumerates `prebuilds/*/
spawn-helper` (+ `build/Release`), best-effort chmod (try/catch, won't crash on
read-only paths — spirit of open 0135/0136). 64/64 recipe assertions pass
locally; CI validation pending on PR #32. NOTE: 0191 fix can't be reproduced on
a macOS dev box (no linux prebuild locally) — verified via the runner.


**2026-06-26 — resume robustness: per-record `live` flag replaces openSlots (0189)**
— Branch `forge/resume-robustness/live-flag`. Root-caused a real-world
mis-resume: a 3-day-old `mc` process whose cached `sessionStore.js` predated the
`openSlots` logic kept updating `bySlot` but never the `openSlots` array, so it
froze at `[1,2,3]` while 9 sessions were live — `:resume-all` would have restored
3 of 9. Fix co-locates liveness on each `bySlot` record: `syncFromSnapshot`
writes `live:true` on live slots and `live:false` only when a slot is empty while
others are live (deliberate kill; never on all-empty boot/close).
`listOpenResumeRecords` now derives from `bySlot` — `live===false` skip,
`live===true` restore at any age (protects partial-resume from aging out dormant
slots), legacy no-flag records restore only within `RESUME_RECENCY_MS` (120s) so
ancient leftovers expire. `openSlots` left vestigial w/ `TODO(resume-cleanup)`.
4 preserved openset tests + 3 new; full suite 428 green. NOTE: takes effect only
after an mc restart (running process caches the old module — same mechanism that
caused the bug). Live `~/.config/claude-mc/sessions.json` was hand-patched
(`openSlots → [1..9]`) so the *current* process's next restart also resumes all 9.

**2026-06-26 — Card/FleetLog test gaps + small FleetLog fixes (0017-0030, 0052)**
— Branch `feat/card-fleetlog-test-gaps`. FleetLog.jsx fixes: width-aware row
text budget (`fleetLogTextBudget`, fed from `termSize.cols`) replacing the
hardcoded 90; grapheme-safe name column via new `padCol()` (format.js); '—'
fallback (not 'unknown'); explicit stable-sort tiebreak (insertion seq → no
flicker); err rows now render their tool prefix in red. New
`tests/FleetLog.test.jsx` (7) + `tests/Card.status.test.jsx` (4, activity
trunc / STUCK chip / APPROVE?-over-INPUT?). Closed 14 (0017-0019, 0021-0030,
0052); marked 0015/0016 OBSOLETE (superseded by 0176 fixed-height — placeholder
rows are intentional). Full suite 425 green. Open backlog 76. DEFERRED (still
open): 0013/0014 (hidden-count window semantics — needs a product decision),
0020 (ctx-pct color-band — needs a band-helper extraction or fragile ANSI
assertions).

**2026-06-26 — infra: MC_DEBUG logging + SECURITY.md + CLAUDE_BIN test (0107-0110)**
— Branch `feat/infra-debuglog-security`. Shipped the never-shipped infra:
(0107/0108) `tui/lib/debugLog.js` — `dlog(scope,msg,kv)` appends JSONL to
`$XDG_STATE_HOME/claude-mc/debug.log` only when `MC_DEBUG=1` (zero-I/O no-op
otherwise, never stdout/stderr); wired into PtyAgent spawn/exit + App
boot/shutdown. (0109) `SECURITY.md` — trust boundaries, every env var +
consumer, plaintext `slackWebhook` risk, session-content sanitization, argv-only
subprocess rule. (0110) `tests/agent.security.test.mjs` — hostile `CLAUDE_BIN`
spawns as literal argv[0], never shell-interpolated. Full suite 414 green. Open
backlog now 92.

**2026-06-26 — fleet broadcast paused-skip bug + lifecycle tests (0069-0073, 0079)**
— Branch `feat/fleet-broadcast-skip-paused-lifecycle`. `broadcast()` was sending
to SIGSTOPped (paused) agents — the write just queued in stdin and surfaced
confusingly on resume. Fix: skip paused/empty targets, return `{sent, skipped}`
(was a bare count); App.jsx broadcast toast now shows "skipped N". Plus new
`tests/fleet.lifecycle.test.mjs` pinning four invariants: launch-on-occupied-slot
throws + slot unchanged (0071), killAll kills every agent (0072), resume without
sessionId throws (0073), and 10 launch+kill cycles don't leak fleet 'change'
listeners (0079, uses MC_MOCK to avoid real claude spawn). Full suite 410 green.
Needs mc restart. NOTE: broadcast() return shape changed number→{sent,skipped};
the only call site (App.jsx sendBroadcast) is updated.

**2026-06-26 — backlog audit + format-fn test coverage**
— Audited the 126-task "harden" backlog (2026-06-08 decomposition) against
current code via parallel auditors. Outcome: **9 closed as already-done**
(0002/0004 humanize, 0053 Card, 0081/0083/0084 settings, 0121 TextField, 0123
resume-all, 0124 Ctrl+J); **41 pruned as OBSOLETE** — superseded by the Zoom→PTY
rewrite (0031-0040,0042-0046,0048-0051) and Agent→PtyAgent migration
(0055-0067,0075,0076,0078) plus 0092/0093/0095/0101/0125/0126; **9 monetization
tasks pruned** earlier as goal-misaligned (paywall/license/trial — contradicts
"single user, CLI is the product"). Then added `tests/lib/format.test.mjs`
(12 cases) closing 5 format-test-win tasks (0011/0012 fmtK, 0103 fmtMoney, 0104
fmtDuration, 0105 barCells) — code was already correct, tests were just missing.
Backlog 169 → 102 open; remaining are genuine NOT-DONE gaps + 5 checkpoints.
Then the two impl tweaks landed too: `trunc()` is grapheme-cluster safe (cached
Intl.Segmenter, ASCII fast path preserved) and `sparkLine()` returns '' for
all-zero input — closing 0009/0010/0106. Full suite 404 green. Real gaps left:
fleet.broadcast paused-skip (0069/0070) + fleet.lifecycle tests (0071/72/73/79),
plus never-shipped SECURITY.md / MC_DEBUG logging / energy baselines (0107-0119).

**2026-06-26 — tailer rotation excludes sibling-claimed sids (0188)**
— Branch `fix/rotation-exclude-claimed-sids`. Closes the `TODO(rotation-multislot)`
from 0187: two slots sharing one cwd could have an idle slot's rotation hunt
yank its card onto the active sibling's transcript. Fix plumbs the OTHER slots'
sessionIds from Fleet down to the tailer: `fleet.launch()` builds a lazy
`siblingSids` getter (filters self by slot index) → `PtyAgent` forwards it as
`claimedSids` → `startSessionTailer` passes it to `findRotatedSession`, which now
skips claimed sids (4th arg `excludeSids`). Lazy getter so it reflects live
re-points. Defaults claim nothing → Agent/MockAgent/tests unchanged. Extended
`tests/sessionFileTailer.rotation.test.mjs` (4 → 6). Full suite 388/388. Needs
mc restart.

**2026-06-26 — tailer follows transcript rotation instead of freezing (0187)**
— Branch `fix/tailer-follow-rotation`. Found live while answering a context
question: mc's stats read **689.0k/1000k** but the actual live context was ~200k.
ROOT CAUSE: `startSessionTailer` pinned `path` as a closure const and never
re-pointed. The slot was stuck on session `9b30a87d` (Jun 25, frozen at 688,965
tokens) while the live conversation had rotated to a freshly-minted transcript
`0b27af9e` (Jun 26 — a `/clear` mints a new session file). The whole card
(context/status/tokens/activity) froze at the dead file. zoomSession already
detects minted-sid rotation but only at zoom mount; the always-on fleet tailer
didn't. Fix (`server/sessionFileTailer.mjs`): `path`→`let`; exported
`findRotatedSession()`; `maybeRepoint()` on the existing stat-poll re-points to
the newest sibling once our file is DEAD (N frozen polls). KEY guard: re-point
FORWARD only (`minMtime = max(spawnedAt, ourFileMtime)`) — else two files newer
than spawn flip-flop every poll (caught by the test). New
`tests/sessionFileTailer.rotation.test.mjs` (4/4). Full suite 386/386. Needs mc
restart. TODO(rotation-multislot): two slots in one cwd can mis-attach — needs
Fleet claimed-sid info.

**2026-06-26 — show 'waiting' when claude is blocked on a permission prompt (0180)**
— Branch `fix/approval-prompt-waiting`. INVESTIGATION settled the task's open
question: claude's tool-permission prompt ("Do you want to proceed? ❯ 1. Yes /
… / No, and tell Claude…") is **PTY-only** — NEVER written to the session JSONL
(grepped all 1604 session files: zero hits). So the JSONL shows a `tool_use`
with no `tool_result` and the connector leaves status `working` while claude is
actually blocked on the user (finding #25). Detection must read the rendered
terminal — `PtyAgent` already keeps a persistent xterm `term` buffer. HUMAN
CHECKPOINT resolved: user approved strict triple-anchor matching + INPUT?-only.
Fix (`server/ptyAgent.mjs`, 1 file): exported pure `detectApprovalPrompt(rows)`
(requires question + `1. Yes` + `No, and/keep` all in the bottom 12 rows — so
asst prose can't false-trigger), `#scanApprovalPrompt()` reads the bottom of
`term.buffer.active`, and `toJSON()` overlays `working → waiting` on a match.
Derived on read → auto-clears when the prompt leaves the buffer (no state to
unwind); only overlays over `working`. New `tests/approvalPrompt.test.mjs` (9/9,
drives real bytes through real xterm). Full suite 382/382. Needs mc restart.

**2026-06-26 — sanitize terminal escapes in surfaced session content (0181)**
— Branch `fix/sanitize-terminal-escapes`. From the 2026-06-23 security review:
the TUI paints attacker-influenceable session content (a file claude `Read`s, a
tool/model/branch name, an api-error cause) to the user's REAL terminal even in
the non-zoomed fleet view, and `humanize()` only stripped CSI — so an OSC-52
`\x1b]52;…` in that content could silently WRITE the user's clipboard. Fix:
(1) `tui/lib/format.js` broadens the stripper to OSC (incl. OSC-52 + title,
BEL/ST-terminated, tolerant of truncation), full CSI grammar, other ESC-intro
forms, and all C0 except `\t`/`\n` (CR/BEL/NUL/DEL/lone-ESC) — still idempotent.
(2) `tui/Card.jsx` routes `activity`, `branch`, the api_error `err` tail entry,
and `resolvedModel` (now a sanitized drift label on catalog-miss, not bare `—`)
through `humanize()`; FleetLog inherits it via its existing tier-2 routing.
(3) `server/sessionFileTailer.mjs` `claudeSessionPath()` rejects non-UUID
`sessionId` (path-traversal guard on `--resume`/claude-minted ids). Tests:
humanize.test +OSC/ESC/C0/combined (22/22), new sessionPath.guard.test (5/5).
Full suite 372/373 — the one fail is the SAME pre-existing flaky recipe race
(pty.recipes/quit-confirm; all recipe files pass in isolation), not this change.
Needs mc restart.

**2026-06-25 — reliable zoom keybinds + real-parser test harness (0186)**
— Branch `fix/zoom-keybinds-reliable`. User: Esc both exits zoom (mc) AND backs
out of claude menus (overlap); Ctrl+]/Ctrl+\ did nothing. ROOT CAUSE (proven via
Ink source + live probe): Ink only sets `key.ctrl` for bytes 0x01-0x1a; Ctrl+]
(0x1d)/Ctrl+\ (0x1c) arrive `ctrl:false`, so `key.ctrl && input===']'` is
UNREACHABLE — dead keys. The old unit tests passed by fabricating
`{ctrl:true,input:']'}`, a shape the real parser never emits → false confidence
(the deeper "how do we KNOW keybinds work" problem). Fix: new `tui/zoom/
zoomKeys.js` registry + `classifyZoomKey()`; chrome keys are Ctrl+Q (exit),
Ctrl+Y (scroll), Ctrl+K (tools), Ctrl+U (stats) — all Ink-reliable AND unused by
claude-code. Esc, Ctrl+T (todos), Ctrl+S (stash), Shift+Tab now FORWARD to
claude. THE test: `tests/zoom/zoomKeys.realparser.test.jsx` drives REAL bytes
through Ink's REAL parser (ink-testing-library stdin.write) — goes red on any
"shape Ink can't emit" binding. Recipes G/G2/O/O2/O3 updated. 360/360 green.
Docs (README/Help/KEYBINDINGS) corrected. NEEDS mc restart. NOTE: tests/recipes/
pty.recipes + quit-confirm are still flaky (separate de-flake task worth filing).

**2026-06-24 — ctx gauge resets on /clear and /compact (0185)**
— Branch `fix/reset-ctx-on-clear-compact`. The zoom/card ctx bar reads only
`agent.context` (set from each turn's `usage.input_tokens`), and `/clear`//compact`
emit no usage event, so the bar stayed pinned at the pre-op value until the next
message. Fix in `jsonlConnector.handleSystem`: `system/compact_boundary` →
`context=0` (+ "context compacted (was Nk)" tail); a `local_command` carrying
`<command-name>/clear</command-name>` → `context=0`. Both signals confirmed in
the live logs. 47/47 jsonlConnector green. Needs mc restart.

**2026-06-24 — API-error resilience: stagger + heartbeat + backoff (0182-0184)**
— Branch `feat/api-error-resilience`. User reported recurring "API 500" errors;
investigation found the live fleet's actual errors are 237 ECONNRESET + 6×502 +
6×401 in 2.5h, ZERO literal 500s — transport noise, not server 500s. mc makes NO
direct API calls (verified) so it's not the source, but it ran 8 concurrent
streams with un-staggered bursts. Shipped (plan
`.claude/plans/piped-beaming-haven.md`): (0182) `fleet.broadcast` + resume-all
stagger per-session sends by `broadcastStaggerMs` (default 200ms); (0183) header
`api ⚠N retrying` heartbeat from `apiErrorCount`/`lastApiErrorTs` so transport
noise reads as retrying not failed; (0184) restart backoff widened 1/2/4→2/5/15s.
342/342 green. Needs mc restart. Operational note for the user: ECONNRESET at
this volume is network-path — check VPN/proxy/Wi-Fi and reduce concurrent slots;
claude's 10× retry already absorbs most. New OPEN task 0185: `/clear`//compact`
doesn't reset the ctx bar because mc ignores `system/compact_boundary` and only
updates ctx from turn usage — fix is to zero `agent.context` on that event.

**2026-06-24 — tailer: status-on-attach + cloud stat-poll (0178/0179)**
— Branch `fix/tailer-status-on-attach-and-poll`. The two top causes of "session
status still not accurate" (from the 50-reasons audit), both in
`server/sessionFileTailer.mjs`. (0178) The tailer started at EOF on attach, so it
only ever saw FUTURE events — a session quiescent when mc connects (blocked on a
question / idle) showed its spawn-time `working` until the next event. New
`primeStatusFromDisk()` replays a bounded 256KB tail into a SCRATCH object
(parseEvent accumulates tokens/cost/tail, so the scratch absorbs those) and
copies back only last-writer-wins fields (status/awaitingPrompt/activity/todos/
context/resolvedModel); forward tailing continues from the EOF it read to.
(0179) fs.watch silently never fires on cloud-synced (GoogleDrive/CloudStorage)
session files — most of the user's fleet — so cards froze. Added a 1.5s
stat-poll backstop alongside fs.watch (cheap: readNew early-returns on no
growth), cleared in stop(). Tasks 0178/0179 → done. Test added; 71/71 green.
NEEDS mc restart; verify on a GoogleDrive-hosted session. Remaining status
follow-ups still open: 0180 (permission-prompt → waiting), 0181 (escape
sanitization, security).

**2026-06-23 — :resume-all restarts only sessions open at last close**
— Branch `fix/resume-all-open-sessions-only`. resume-all consumed the whole
`bySlot` map (every slot that ever held a session) instead of the set open at
terminal close. Fix: `syncFromSnapshot` records the live slot set
(`store.openSlots`); new `listOpenResumeRecords()` returns only those;
`resumeAllSessions` + boot hint/auto-resume use it. bySlot untouched (manual
`:resume <slot>` still works). `:forget` clears openSlots too. GUARD: an
all-empty snapshot (boot after close — children dead) must NOT wipe openSlots,
else resume-all has nothing to restore. Test: `tests/sessionStore.openset.test.mjs`.
Needs mc restart. NOTE: open question — retire HANDOFF.md in favor of task-db
only? Currently the forge pre-push hook still REQUIRES a HANDOFF change.

**2026-06-23 — cards are fixed 11-row boxes (random grid overlap)**
— Branch `fix/card-layout-predictable-resize`. User: constant, seemingly-random
box overlap on the main page. Cause: the grid budgets each card at `CARD_H=11`
(`App.jsx`) but `Card` used `minHeight=11` and left the name/branch as bare
`<Text wrap="truncate">` — and truncate is a no-op without a sized parent (the
card's own tail-row comment says so), so long names/branches WRAPPED to a 2nd
line → card grew past 11 rows (vertical overlap w/ fleet log) and painted past
its width (horizontal overlap). Content-dependent ⇒ "random but constant". Fix:
(1) thread `cardWidth` from App into Card and PRE-truncate name+branch with
`trunc()` to the measured leftover width — one plain Text line each, no Ink
flex-truncation (which wraps/phantoms in a row of differently-colored Texts);
(2) Card outer box `height=11` + `overflow=hidden` — hard guarantee a card can
never exceed its budget; (3) footer drops the `wk` cost on tight (<40 inner)
cards so it can't wrap (still shown in the aggregate bar). Empty-slot card also
fixed-height now. Test: `tests/Card.layout.test.jsx` asserts 11 rows + no width
overflow across cardWidth 34..120. Needs mc restart to go live.

**2026-06-23 — tool_result clears stale 'waiting' (1-stage-behind lag)**
— Branch `fix/tool-result-clears-waiting-lag`. User: "status is ~1 stage behind
— INPUT shows after I answer the questions." Root cause (proven from a real
session log w/ timestamps): an AskUserQuestion sets the card 'waiting' on the
assistant `[TU:AskUserQuestion]` record; the user's answer arrives as a
`user/tool_result` event, but `handleUser`'s tool_result branch never changed
status — so the card stayed 'waiting' from the answer (18:54:01) until claude's
NEXT assistant record (18:54:15) = ~14s stale. Fix: a tool_result means claude
got what it was blocked on (tool output OR the answer) → set status='working'
and clear awaitingPrompt immediately. Non-blocking tool_results were already
'working' (no flicker; setter early-returns on same value). Ruled OUT a
universal buffering lag: claude's JSONL is newline-terminated per record, so
the tailer processes each complete line at once. Test added in
`tests/jsonlConnector.test.mjs` (43 pass). Needs mc restart to go live.

**2026-06-23 — broadcast auto-submit + card/zoom model tracks /model switch**
— Branch `fix/broadcast-submit-and-model-display`. Two live-reported bugs.
(1) Broadcast typed text into each session but didn't submit — user had to zoom
in + press Enter per session. Cause: in bracketed-paste mode `#writePtyMessage`
wrote the `200~..201~` paste content + submit CR in ONE write; claude swallows
a CR coalesced into the paste burst during finalize. Fix: defer the CR to a
separate `setImmediate` tick (the rule the slash path already used); paste-off
path keeps single-write `text\r`. Test in `tests/ptyAgent.test.mjs` forces
bracketed mode on. (2) Card/Zoom model label+color+ctx%-denominator keyed off
`agent.model` (launch model), so a mid-session `/model` switch (which only
updates `agent.resolvedModel`, the cli id) left them stale. New `modelByCli()`
in `tui/lib/models.js` reverse-looks-up resolvedModel → catalog entry; card
(`Card.jsx`) + zoom (`Zoom.jsx`) prefer it, fall back to launch model. Zoom's
`⚠ resolved` chip now only fires for an unknown cli model (genuine drift), not
an in-catalog switch. Tests: `tests/models.test.mjs`. Verified via render
smoke-test (Opus-launch + Sonnet-resolved → shows SONNET 4.6 @ correct 25%).
NOTE: both need an mc restart to go live (no hot reload).

**2026-06-23 — transient api_error no longer flips card to 'error'**
— Branch `fix/transient-api-error-not-error`. `jsonlConnector.handleSystem`
set `status='error'` on EVERY `system/api_error` event. But those events are
claude's transient-retry signal — they carry `retryAttempt`/`maxRetries` +
a cause code (ECONNRESET, overloaded) and claude keeps working through the
retry. 1202 such events across the on-disk session logs; each flashed the
card red mid-work ("error while the model is active and working" — user
report). Fix: only `error` when retries are exhausted (`retryAttempt >=
maxRetries`); otherwise stay `working` and surface `retrying api · <code>
N/M` in the activity line. Genuine terminal death still surfaces via PTY
exit → `ptyAgent.#onExit` (auto-restart, then `error`). Breadcrumb now
includes the cause code. Tests: updated the old api_error test + added
exhausted→error case in `tests/jsonlConnector.test.mjs` (42 pass). NOTE:
this is the PTY/jsonl path; legacy `agent.mjs` already has a separate
error path. Separate latent responsiveness gap (not fixed here): the
session tailer snapshots offset=EOF on attach, so on mc startup/resume a
card shows the spawn-time `working` until the next live event — see
`sessionFileTailer.startSessionTailer`.

**2026-06-23 — header/aggregate status bars wrapping fix**
— Branch `fix/header-aggregate-wrap`. The top two status strips
(`tui/Header.jsx`, `tui/Aggregate.jsx`) wrapped onto a second line when
their content exceeded the terminal width — `claude-mission-cont`/`ol`,
`statu`/`NOMINAL`, `cost·sessi`/`$611.1`/`7` fragments that shoved the
whole grid down. Cause: each segment wrapper was a bare `<Box>` (Yoga
default `flexShrink: 1`); when the row overflowed, Yoga squeezed the
cells and the inner `<Text>` (default wrap) broke onto extra lines. Fix:
`flexShrink={0}` on every segment **and** separator box so cells keep
content width, `overflow="hidden"` + `flexWrap="nowrap"` on each row so
overflow clips at the right edge on a single line, separators tightened
`  │  `→` │ ` (~35 cols reclaimed). Verified via ink-testing-library:
both bars now render exactly 1 line, separators intact. TRADE-OFF: at
~174 cols the rightmost header segment (UTC clock) now clips instead of
wrapping (standard status-line behavior; everything shows ≥185 cols).
Follow-up if the clock must always show: make the bar responsive
(abbreviate/drop low-priority segments at narrow widths) — not done here.
No tests added (no existing Header/Aggregate test harness; verified by
render smoke-test). Only these two files used the `'  │  '` cell pattern.

**2026-06-22 — tool_use 'needs input' state + stale-doc reconcile (#5)**
— Branch `fix/tool-use-needs-input-state`. A human-blocking `tool_use`
(`AskUserQuestion` / `ExitPlanMode`) arrives mid-turn with
`stop_reason='tool_use'`, so `jsonlConnector` pinned the card on
`working` while claude was actually `waiting` (needs input) — observed
live by the user watching mc's own session card during an
AskUserQuestion. New shared `promptFromToolUse()` in
`server/detectPrompt.mjs` classifies the blocking tools and maps their
input onto the existing `awaitingPrompt` shape (yellow `INPUT?` chip,
Zoom `NEEDS INPUT`); `jsonlConnector.handleAssistant` flips to
`waiting` when one is seen. Non-blocking tools (Bash/Read/Edit) still →
`working`. Legacy stream-json `agent.mjs` gets a `TODO(state)` (that
path is `-p`/non-interactive + slated for Phase E deletion). Tests:
2 new in `tests/jsonlConnector.test.mjs` (AskUserQuestion→waiting+chips,
ExitPlanMode→waiting); 78/78 in the server suites pass. Closed GH #1
(TextField horiz-scroll), #3 (`:resume-all`), #4 (Ctrl+J newline), #5
(Ctrl+↑/↓ Mission-Control conflict) — all verified fixed-in-code first.
While verifying #5 found the documented fix was stale: the PTY-embed
rewrite replaced mc-side `Shift+↑/↓` log scroll with a `Ctrl+\` scroll
mode (`PtyPane.jsx`: `w`/`s`/`b`/`f`/`g`/`G`), and arrows now forward to
claude. `tests/Zoom.shiftarrow.test.jsx` (cited as "PROVEN" in
KEYBINDINGS.md) never existed. Reconciled `README.md` Zoom scroll rows +
added a supersession banner to `docs/audit/KEYBINDINGS.md` and stripped
the fabricated test claims. CAVEAT: the `waiting` flip is unit-verified
against synthetic JSONL — confirm end-to-end by watching a live card go
yellow on a real AskUserQuestion. Out of scope this pass: the rest of
the KEYBINDINGS.md Zoom table (composer/slash/history rows) is also
pre-rewrite stale — flagged via banner, needs a fuller audit.

**2026-06-22 — broadcast submit + slash dispatch + fleet t/min (#24/#25/#26)**
— Branch `fix/broadcast-submit-and-spark`. (#26) The PTY pipeline never
updated `spark`, so fleet `t/min` was pinned at a constant ~8000/agent.
New `server/spark.mjs` holds the shared `updateSpark()` normalizer +
`SPARK_SCALE`; `agent.mjs` delegates to it, `jsonlConnector.handleAssistant`
now calls it on each usage event, `ptyAgent` seeds `lastTokSampleTs`, and
`App.jsx` denormalizes with the shared `SPARK_SCALE` (no more literal 8000).
Fixed a latent `|| now` → `?? now` bug (a 0 timestamp was treated as
missing). (#24/#25) Broadcast wrote `text + '\r'` as ONE chunk, which
claude absorbed as paste content — text landed in the box but never
submitted until a manual zoom Enter, and slash commands never dispatched.
`ptyAgent.#writePtyMessage` now: wraps normal text in bracketed paste when
claude's mode is on (CR outside the 201~ marker = unambiguous Enter), and
for slash commands writes the command raw then the submit CR on a SEPARATE
tick (so claude dispatches it). New pure `pasteForSubmit()` helper, unit
tested. Tests: `tests/spark.test.mjs` (5), spark test in
`jsonlConnector.test.mjs`, `pasteForSubmit` + slash-send tests in
`ptyAgent.test.mjs`. CAVEAT: the broadcast byte-sequence is unit-verified
but the end-to-end submit behavior against the live claude TUI needs a
manual smoke test (interactive submit can't be unit-tested).

**2026-06-22 — model catalog refresh + opus-4.8 default (#27)** — Branch
`feat/model-catalog-refresh`. (1) Corrected the `opus-4.8` catalog entry
in `tui/lib/models.js`: `maxCtx` 200000 → **1000000** and `maxOut: 64000`,
VERIFIED via `claude -p --model opus --output-format json` →
`modelUsage[claude-opus-4-8].contextWindow`. (2) Made `opus-4.8` the
default model (`settings.js` `defaultModel` + added to the picker
options) and pointed the 3 `opus-4.7` templates at `opus-4.8`. (3) New
`tui/lib/modelProbe.js` — the programmatic "pull available models" path:
`probeAll()` runs the JSON probe for opus/sonnet/haiku concurrently
(each a real ~$0.10 billed turn), `applyCacheToCatalog()` overlays the
real context windows onto the static catalog and discovers newly-shipped
models, cached to `~/.config/claude-mc/models-cache.json`. New command
`:model refresh` triggers the live probe; **boot reads the cache offline
and never probes** (`main.jsx` applies it before render). `:model` now
lists models live (`Object.keys(MODELS)`) so discovered models are
selectable. Tests: `tests/modelProbe.test.mjs` (9 — parser vs real
output, cache round-trip, catalog update + discovery). NOTE: pricing for
opus-4.8 is still mirrored from 4.7 (probe reports total cost only, not
per-MTok) — TODO in models.js. Filed broadcast bugs #24/#25 + tokens-per-
min bug #26. (The `~/.claude/settings.json` `model` value was checked and
is clean `"opus"` — an earlier "corrupted" flag was a grep ANSI-bold
rendering artifact, not real corruption.)

**2026-06-22 — raise session cap above 10 (#11)** — Branch
`feat/raise-session-cap`. New setting `maxSlots` (default 10, clamped
to [1, 64]) sets the fleet size at construction. `server/fleet.mjs`
now exports a configurable Fleet (constructor takes `{ slots }`);
`SLOTS` constant replaced with `DEFAULT_SLOTS=10`. `tui/main.jsx`
reads `settings.maxSlots` via `loadSettings()` at boot and passes it
to `new Fleet({ slots })`. Hot-changing the cap is intentionally not
supported (would orphan live agents); the Settings UI labels the
control as restart-required. App.jsx cap toast now reads
`snapshot.slots` so the message scales. New command `:goto <N>` /
`:jump <N>` focuses any slot 1..N — escape hatch for slots 11+ where
there's no single-digit hotkey. Card-grid scroll viewport engages
ONLY when `snapshot.slots > 10` AND the rendered grid would overflow
the terminal — at default cap, behavior is unchanged (no regression
for stable terminals). Viewport keeps the focused row centered with
`▲ N more rows above / ▼ N more rows below` indicators, mirroring
`RepoPicker`'s pattern but deriving scrollTop from focusedRowIdx (no
separate state — avoids the #14 race entirely). Tests:
`tests/fleet.maxSlots.test.mjs` (5 tests covering default, explicit
sizing, clamping, launch validation, snapshot shape).

**2026-06-22 — PTY 'waiting' state + narrative fleet-log default (#28)** —
Branch `fix/pty-waiting-state-and-narrative-default`. (1) The default
PTY pipeline never set `waiting` — `jsonlConnector` only produced
working/idle/error, so the needs-input state never showed on a card.
Extracted `detectPrompt` + helpers out of `agent.mjs` into
`server/detectPrompt.mjs` (breaks the
`jsonlConnector→agent→sessionFileTailer→jsonlConnector` cycle; agent.mjs
re-exports for back-compat, the 20-test detectPrompt suite still guards
it). `jsonlConnector.handleAssistant` now classifies the final
assistant text on `end_turn`: prompt-shaped → `waiting` (+ stores
`awaitingPrompt`), else `idle`. 4 new tests. Known gap: pure
permission-gate pauses (no assistant question) still aren't detected —
follow-up. (2) `settings.fleetLogMode` default flipped `all → narrative`
so the fleet log shows claude's "I did X / doing Y" narrative by
default (bash/tool/sys noise hidden; Shift+L still toggles; Zoom
unaffected). NOTE: an existing settings.json with `fleetLogMode:'all'`
persisted keeps 'all' — press Shift+L once to switch.

**2026-06-22 — per-session metrics (#12)** — Branch
`feat/per-session-metrics`. Four new per-agent fields surfaced on
`fleet.snapshot()`: `turnCount` (round trips with claude — incremented
on stream-json `result` events and PTY `system/turn_duration` events,
one per user query), `messageCount` (user prompts actually written —
incremented in `agent.#writeUserMessage` on the stream-json path and
in `jsonlConnector.handleUser` on the PTY path; tool_result events are
NOT counted), `stateSince` (refreshed by the status setter on every
real transition — pinned by the existing `prev===next` guard, so
no-op writes don't reset the clock), and `spawnedAt` (anchored once
in the constructor, NOT reset on respawn so per-agent session
lifetime stays continuous across `/compact-restart`). Zoom Ctrl+S
panel gains three lines under USAGE · SESSION: `turns N · M msg`,
`in <state> HH:MM:SS`, `session age HH:MM:SS` via the existing
`fmtDuration` helper. Tests: 4 new in `agent.reliability.test.mjs`
(init defaults, stateSince transition, toJSON shape) and 4 new in
`jsonlConnector.test.mjs` (messageCount on user, no count on
tool_result, turn_duration increments turnCount).

**2026-06-22 — state vocabulary reconcile (#13)** — Branch
`chore/state-vocab-reconcile`. Settings NOTES tab now labels the
`'waiting'` state as `'waiting · needs input'` so both the canonical
code name and the user-facing label surface in one place. The fleet
header (`Header.jsx`) now shows `paused` and `idle` counts alongside
`work / wait / err` for a true breakdown of the six-state enum
(`idle | working | waiting | paused | error | empty`). README gains a
"Session states" section under "What's actually running" documenting
the enum, clarifying that "stuck" is a derived metric (not a state),
and explicitly noting that `/compact` and `/compact-restart` are
user-invoked — no automatic stage-bound summary today. Decision on
auto-summary: deferred (no follow-up issue filed; not warranted
without a concrete user-visible need).

**2026-06-21 — fleet-log narrative mode (#19)** — Branch
`feat/fleet-log-narrative-mode`. New setting `fleetLogMode: 'all' |
'narrative'` (default `all`). In narrative mode, `deriveFleetLog`
(`tui/FleetLog.jsx`) keeps only `asst` / `err` / `bcast` kinds and
drops empty-text `asst` entries (tool-only turns) so users can skim
what claude is actually saying back without burying them in bash
invocations and system events. Hotkey: **Shift+L** cycles modes
live (lowercase `l` stays bound to vim-right). Mode chip renders
in the FleetLog header. Persisted to `~/.config/claude-mc/settings.json`.
Also filed issues #14 (RepoPicker viewport bug), #15 (Zoom tool
counter / TAIL_MAX), #16 (PTY-CI gating), #17 (render coalescing),
#18 (productize for v0.3) — see GitHub.

**2026-06-19 — alt-screen on boot** — `tui/main.jsx` now enters the
terminal alt-screen (`\x1b[?1049h`) before Ink renders and restores
the normal buffer on every exit path. Fixes the "wait, did mc
produce these `please` lines?" confusion that surfaced post-v0.2.0:
mc was rendering inline in the normal buffer, leaving its last frame
in scrollback after quit; the shell prompt appeared below it; the
user typed `yes please` thinking they were still in mc; `/usr/bin/yes
please` (a real Unix command) flooded the terminal. With alt-screen,
mc's render disappears cleanly on exit and the shell prompt returns
to where the user started. Preflight banner still prints to the
normal buffer (visible in scrollback after exit), per request #383.

**2026-06-19 — v0.2.0 cut** — PR #9 merged to main (zoom layout +
Ctrl+J newline + 15 recipe tests). Dropped the `-alpha.1` suffix:
tag `v0.2.0` pushed. Branches `fix/zoom-textbox-layout-and-newline`
and `fix/zoom-continuity-followup` deleted (PR #8 was superseded by
#9). All 282 tests pass on main.

**2026-06-18 (zoom textbox: layout + newline + automated coverage)** —
Branch `fix/zoom-textbox-layout-and-newline` (6 commits, off the
PR #8 continuity branch). Three things shipped:

**Layout bleed root cause (commit 3cae873):** the first attempt at
fixing the layout (correcting the fixedRows arithmetic) was
insufficient. Real root cause: Zoom.jsx read `stdout.rows` directly
as if it owned the whole terminal, but App.jsx wraps it in
paddingY=2 + FeedbackStrip + StatusBar (4 rows of overhead Zoom
didn't know about). So Zoom over-allocated the PTY body by 4 rows
and claude's bottom UI ("plan mode on", "Update ava") visually
landed past mc's footer. Fix: App.jsx passes `height={termRows-4}`;
Zoom uses that instead of stdout.rows. Regression test L2 catches
oversize directly (render <Zoom height=20>, assert line count <= 20).

1. **Layout overlap fixed** — `Zoom.jsx` fixedRows arithmetic was
   off by 2-3 rows because it forgot the marginTop=1 spacers
   between sections. Result: PtyPane allocated more rows than the
   bordered modal had room for, and claude's bottom-of-screen UI
   (input prompt, "auto mode on" banner) bled past mc's footer.
   Recompute base=10 (was 9), stats +7 (was +6), tools +2 (was +1),
   todos +1 marginTop. Plus `overflow="hidden"` on PtyPane as a
   belt against future miscounts.
2. **Ctrl+J inserts newline in zoom** (Shift+Enter too, where the
   terminal protocol distinguishes it). Detection is
   `input==='\n'` because Ink's parseKeypress passes the raw LF
   byte through without flipping `key.ctrl` (probe confirmed).
   Wrapped in bracketed paste when claude has the mode on, raw LF
   otherwise. Alt+Enter NOT bound — Mac terminals encode it as
   ESC+CR which collides with PtyPane's single-tap Esc-exits-zoom
   design. Footer hint advertises `⌃J newline`.
3. **15 automated recipes in
   `tests/recipes/zoom-text-input.recipes.test.jsx`** covering
   15 of 20 candidate text-box bugs (Enter, Backspace, Tab, arrows,
   Ctrl+letters, Ctrl+J newline, Esc-no-forward, bracketed-paste
   on/off, no-double-char, intercept hotkeys, resize, frame row
   count, footer position). User no longer has to manually
   reproduce these.

281/281 tests pass. Plan at `.claude/plans/zoom-textbox-fixes.md`.

Not yet on main — PR #8 still needs to merge first (this branch
is stacked on top of it).

**Skipped (follow-ups):**
- Latency-class bugs #6/#14/#16 (display lag, echo absent, echo
  delayed) — need event-loop timing instrumentation, not recipes.
- Real-PTY recipes #M/N/P (wrap-col, emoji-width, cursor-position)
  — need a `tests/lib/pty-fixtures/zoom-claude-stub.mjs`.

---

**2026-06-18 (zoom continuity — REAL root cause)** — The session
continuity changes from earlier today (PtyAgent owns the term,
markUserSubmitted, decay removal) were necessary but NOT sufficient.
The actual headline bug was `tui/App.jsx:378`:

```js
const zoomedAgent = zoomedId ? agents.find(...) : null;
```

`agents` is built from `fleet.snapshot()` — toJSON() plain objects
WITHOUT methods. So `agent.attachZoomView` was undefined, PtyPane
fell into the legacy `startZoomSession` fallback, which spawned a
SECOND `claude --resume <sid>` against the same JSONL file. The
two claudes raced, and on zoom exit the legacy kill+respawn dance
killed the original PtyAgent PTY — exactly the symptom "claude is
not thinking, no output exists" on re-zoom.

Fix: `zoomedAgent = fleet.agentById(zoomedId) || agents.find(...)`
so PtyPane receives the LIVE PtyAgent instance and takes the
attachZoomView path. Card rendering still uses the snapshot.

This subsumes / completes the earlier continuity work — that work
remains correct, but the App.jsx fix is what actually makes the
user's "ask → Esc → re-zoom with full state" story work end-to-end.

---

**2026-06-18 (zoom session continuity)** — Fixed the "leave zoom →
re-enter → empty terminal" bug and two related status-accuracy
issues. Three changes, one PR, focused exclusively on the
ask → exit → re-enter user story:

1. **PtyAgent owns the xterm-headless terminal for its lifetime.**
   Built in `start()`, fed by `pty.onData → term.write` continuously,
   disposed only in `kill()`. Zoom is a viewport into the persistent
   buffer, not the buffer's creator. Re-zoom shows every byte claude
   has written since the session began.
2. **`markUserSubmitted()` on PtyAgent.** PtyPane calls this when
   Enter (`\r`) is forwarded to the PTY — status flips to `'working'`
   synchronously instead of waiting 200-800ms for claude to commit
   the JSONL user event. Cards reflect intent the moment the user
   hits Enter.
3. **6-second idle decay removed from sessionFileTailer.** The
   safety-net timer was flipping status to `'idle'` mid-thinking on
   any prompt claude couldn't answer within 6s.
   `jsonlConnector.parseEvent` is canonical via
   `stop_reason='end_turn'` / `system/turn_duration`. Wedge detection
   (PTY alive but truly stuck) is still covered by `toJSON()`'s
   `stuckMin` — a 5-minute silence threshold renders a STUCK chip.

266/266 tests pass. Plan at `.claude/plans/zoom-session-continuity.md`.

**Verification protocol** (the only thing that proves it works):

1. `npm start`
2. NewSession on a real repo, ↵
3. Press the slot number, `z` to zoom
4. Type "list the top-level files and explain each in one line", Enter
5. Press Esc immediately (within 1s)
6. Fleet view: card shows `working`, activity preview updating,
   tokens climbing. Must NOT flicker to `idle`.
7. Wait for `idle` (turn complete)
8. Re-zoom — full conversation on screen, cursor at the next prompt.

---

**2026-06-17 (rewrite default on)** — Single-pipeline rewrite is
the default. `FLEET_USE_PTY=0` is the rollback knob; remove it
entirely after Phase E sweep. The dual-pipeline architecture
(stream-json sibling + JSONL-tailer-during-zoom) that drove every
zoom regression for the past week is replaced by ONE claude PTY per
slot, with JSONL as the single source of truth.

What landed:

1. **PtyAgent** (`server/ptyAgent.mjs`) — new class with the same
   public surface as Agent. Spawns claude in node-pty, derives ALL
   state (status, tokens, cost, tail, todos, resolvedModel,
   permissionMode) from `server/sessionFileTailer.mjs` +
   `server/jsonlConnector.mjs` (Phase A's work). 20 unit tests cover
   spawn args, send-queue drain, cost cap, pause/resume/kill,
   auto-restart with backoff, resize, attachZoomView. Injectable
   `spawn` per research R13 — no real claude required for unit tests.

2. **Fleet flag** (`server/fleet.mjs`) — `FLEET_USE_PTY=1` swaps
   PtyAgent for Agent at launch time. Default off so existing
   behavior is unchanged; flip after dogfood proves out.

3. **Zoom attach-not-spawn** (`tui/zoom/PtyPane.jsx` +
   `PtyAgent.attachZoomView`) — when the agent has
   `attachZoomView`, the zoom view binds to the agent's existing
   PTY (resize only, no second claude process). The legacy Agent
   path still uses `startZoomSession` (spawn sibling + SIGSTOP
   dance). The bug class "exit zoom kills the session," "claude
   minted a different sid," "fleet log silent during zoom," and
   "everything shows idle" cannot occur in the new path by
   construction.

4. **R9 process reaping** (`tui/main.jsx`) — added
   `process.on('exit', fleet.killAll)` as a synchronous safety net.
   Catches uncaught exceptions / abnormal termination that
   SIGINT/SIGTERM handlers miss. Prevents orphan claude PTYs.

5. **NewSession ↑/↓ regression** (`tui/modals/NewSession.jsx`) —
   `9a57934` correctly fixed the ←/→ cursor double-fire bug but
   regressed the universal "down arrow = next suggestion" gesture.
   Now ↑/↓ auto-switch focus to the list (they have no conflict
   with single-line TextField cursor); ←/→ stay list-only so the
   cursor-isolation fix sticks.

263 tests pass · 0 fail with flag off. PtyAgent path tested
end-to-end against stubbed spawn; smoke-test with real claude
pending the user's dogfood run.

Old context retained below.

---

**2026-06-17 (later)** — Two big architectural rethinks of the
zoom data path (`<this commit>`):

1. **Don't kill the sibling on zoom entry.** The "leave zoom kills
   the session" complaint was the kill+respawn destroying the
   original even when zoom did no work — e.g. enter zoom, see
   claude, exit. Now: SIGSTOP on entry. On exit, dispose waits for
   the PTY to be quiet for 1500ms (max 30s) — letting any in-flight
   "thinking" response commit to the session JSONL — then scans the
   dir. If the PTY wrote nothing → SIGCONT the original (intact).
   If the PTY wrote turns → SIGKILL + respawn with `--resume
   <detected-sid>`. The "mid-thinking exit loses state" bug is gone
   because we wait for the turn to flush before tearing down.
2. **Tailer drives status / activity / tokens / context.** The
   stream-json sibling normally sets these from its event stream,
   but it's frozen during zoom (and post-zoom it only sees events
   the user types via fleet view — direct PTY interaction was
   invisible). `server/sessionFileTailer.mjs` now reads
   `message.usage` on assistant events and accumulates
   tokensIn/Out/context, sets status='working' on any event with a
   4s decay back to 'idle', and threads the latest message into
   `agent.activity` so the card preview stays alive. Cost is still
   stream-json-only (JSONL has no `total_cost_usd`).

Other improvements in this turn: tailer ownership moved from
PtyPane (component-scoped) to zoomSession (PTY-scoped) so it
outlives the React unmount and keeps forwarding during the
quiet-wait. `Shift+Tab` inside zoom is no longer intercepted —
forwarded to claude (which binds it for its own permission-mode
cycle); mc's fleet-view Shift+Tab still works because the App-level
handler is gated by `if (modal) return`. HOTKEYS.md updated.

**2026-06-17 (late)** — Three persistent zoom-flow bugs fixed
(`d39adc1`, `9a57934`):

1. **SessionId divergence** (`d39adc1`) was the shared root cause of
   "fleet log silent during zoom" and "session killed on zoom exit."
   Claude doesn't strictly honor `--session-id` in interactive PTY
   mode — it sometimes mints its own. `server/zoomSession.mjs` now
   snapshots `claudeProjectDir(cwd)` before spawn and, 1200ms after,
   diffs to find any file claude actually wrote. If its sid differs
   from ours, `agent.sessionId` is updated and `'change'` emitted.
   `tui/zoom/PtyPane.jsx` re-attaches the file tailer when
   `agent.sessionId` rotates. `agent.start()`'s existing existsSync
   guard then picks the right file for `--resume` on zoom exit, so
   the prior conversation comes back.
2. **NewSession arrow keys** now isolated by a `focus: 'path' | 'list'`
   state machine — Tab toggles. In path focus the TextField owns
   ←/→ for cursor movement; in list focus the modal owns ↑/↓ (list
   nav) and ←/→ (model cycle). Tests updated; 9/9 NewSession +
   41/41 total pass.

**2026-06-17** — PTY-embedded Zoom landed (`bb28b7c`). The zoom body
is now a real `claude --resume <sid>` running in node-pty, blitted into
Ink via `@xterm/headless`. Header + Ctrl+T/Ctrl+S overlays + OPEN TASKS
panel stay as Ink chrome around the PTY pane. The stream-json sibling
is SIGSTOP'd during zoom; `server/sessionFileTailer.mjs` keeps todos +
tool counts live by tailing claude's on-disk JSONL. Three smoke-test
fixes folded in: zoom + auto-restart both stat the session file and
fall back to `--session-id` when claude hasn't flushed a turn yet
(eliminates "No conversation found …" loops); single Esc closes zoom
(matches every other modal — Ctrl+C still forwards to claude for
interrupts); Shift+N no longer shadows `n` (free for future
overload). Six follow-ups parked in `.claude/plans/zoom-followups.md`.

**2026-06-10** — Systematic audit + priority-ordered execution pass.
Catalog now includes Opus 4.8 (`claude-opus-4-8`) — Opus 4.7 retained
as a pin option; Opus 4.8 pricing TODO until Anthropic page is checked.
Agent.resolvedModel captures claude's init-event model; `:model <id>`
swaps mid-session via kill+resume; Option/Ctrl+arrow word jumps now
work in every TextField (5 unit tests). Comprehensive
docs/audit/KEYBINDINGS.md inventory + 4 Zoom shift+arrow tests PROVE
the scroll binding works. `:debug-keys [on|off|status|clear|path]`
verb toggles key-event recording at runtime — `● REC keys` chip in
StatusBar shows when on. `/compact` (summary prompt) + `/clear`
(kill+relaunch same slot, fresh sessionId) now in slash catalog.
Memory layers (L1/L2/L3) shipped end-to-end:
`/compact-restart` polls for summary then auto-relaunches (L1),
`:remember`+`:memory` write/read `<cwd>/.mc/MEMORY.md` and
auto-inject on launch (L2), `:mcp` lists MCP servers from
`~/.claude/.mcp.json` + `<cwd>/.mcp.json` (L3). All gated by
PLUGINS settings tab generated from `tui/lib/plugins.js`. 254
tests · 0 fail.
Wrote `docs/audit/{ARCHITECTURE,COMPONENTS,IMPROVEMENTS}.md` (615 tasks
across 13 buckets, with mermaid ERD + sequence diagrams + per-component
purpose matrix). Then executed top of the priority list against a
build→hypothesis→PTY-test→analysis loop: q-quit redesigned as an
explicit modal, TextField cursor positioning, App.jsx re-render loop,
MC_CONFIG_DIR sandbox for safe dev-on-mc, boot banner + :version verb,
slash-command wiring verified, Agent.send respawn race fixed (queue +
flag), sessionStore + costStore + settings all got atomic write +
.bak rollback, Help modal now documents :cap/:budget/:cost/:template/
:version, TextField multi-line ↑/↓ nav coordinated with Zoom history
recall, 15 App-level hotkey tests added. User feedback batch addressed:
:transcript / :where verbs surface where state lives, narrow-terminal
card overlap fixed (grid auto-reduces column count), 12 new structural
asks logged in IMPROVEMENTS.md bucket 14, :tasks verb pulls GitHub
Issues for the focused session's repo via gh CLI, Zoom composer moved
to TOP of modal (cursor at first line) so editing never requires
scrolling to the bottom. 216 tests · 0 fail.

## What shipped recently

- **Single-pipeline rewrite (Phases B–D + R9)** — `PtyAgent`,
  `FLEET_USE_PTY` flag, zoom attach-not-spawn, PTY reaping safety
  net, NewSession arrow regression fix. On
  `feature/single-pipeline-rewrite`; PR pending. See Current state
  above for the architectural change.
- **PTY-embedded Zoom** (`bb28b7c`) — interactive `claude --resume <sid>`
  runs inside Zoom, rendered through `@xterm/headless` → Ink cells.
  Markdown, cursor, scroll, slash UI, syntax highlighting all native.
  SIGSTOP/SIGCONT on the stream-json sibling avoids two writers on the
  same session file. Live JSONL tail keeps OPEN TASKS + Ctrl+T counts
  current during zoom. 7 stale composer-era Zoom tests removed.
- **Smoke-test fixes** (`bb28b7c`) — `claude --resume` is gated on the
  on-disk session file existing (otherwise falls back to `--session-id`),
  preventing the "No conversation found with session ID …" loop both at
  zoom entry and in the auto-restart path. Single Esc closes zoom.
  Shift+N is no longer aliased to `n`.
- **TextField horizontal scroll** — caret-bearing line uses
  `wrap="truncate-start"`; long input keeps the cursor on screen. Multi-line
  values render with earlier lines above the caret. Fixes "typing blind"
  (GH issue #1) and "Ctrl+J inserts above" (GH issue #4).
- **Ctrl+J reliability** — TextField now accepts three LF encodings
  (`key.ctrl+j`, raw `\n`, `key.return+\n`) so newline insert works across
  iTerm2 / Terminal.app / Ghostty. Cross-terminal regression.
- **Zoom composer visibility** — `fixedRows` chrome budget bumped 11→13.
  Composer is now visible without needing to expand the stats panel
  (Ctrl+S). User report: "ctrl+s was the only way to see the text."
- **Shift+↑/↓ scroll** — replaces Ctrl+↑/↓ which macOS swallows for
  Mission Control / App Exposé. README + Help modal updated.
  GH issue #5.
- **Session resume** — three distinct verbs:
  `:resume <slot> [slot ...]` (selective, multi-arg new), `:resume-all`
  (all recent-active from `bySlot`), `:history [n]` (view-only LITE
  memory). Boot toast surfaces saved sessions. GH issue #3.
- **LITE session history** — `sessions.json` schema v1→v2 with a rolling
  `history[]` array (configurable via `settings.sessionHistoryLimit`,
  default 20). View-only by design — never bulk-restored.
- **Settings additions** — `autoResumeOnStart` (boolean, default off),
  `sessionHistoryLimit` (number, default 20).
- **Forge dogfood** — 120 tasks in `tasks/open/`, 8-wave DAG at
  `tasks/_plan.md`, plan at `.claude/plans/harden-mission-control-daily-driver.md`.
  Five mc issues filed at `xxyjoel/ba-mission-control` (#1-#5); two forge
  issues at `bluearchio/forge` (#1 install gap, #2 GH-as-SoR feature).
- 3baf8ac feat: simplify NewSession, line-based Zoom scroll, hide empty cards

## Open TODOs

- **Dogfood `FLEET_USE_PTY=1`** — set the env var, launch a session,
  send prompts, zoom in mid-stream, exit, re-zoom. Verify the four
  recurring symptoms are gone (status accurate, cost ticks up, no
  mid-thought loss, fleet log updates during zoom). When happy,
  flip the default in `server/fleet.mjs` and start deleting the old
  `Agent` class (Phase E in `.claude/plans/single-pipeline-rewrite.md`).
- **Phase E (sweep) not yet started** — delete `Agent.#handle()` /
  stream-json plumbing, update `/compact` and `/clear` handlers
  (R5 still pending), retire `MockAgent.replay.test.mjs` per
  DECISION-3, update CLAUDE.md "Conventions" section ("stream-json
  on both sides" claim will be false post-flip).
- **GH issue #2 (`bluearchio/forge`)** — make GH Issues the system of
  record for forge tasks. Architectural ask; needs forge-side work.
- **Issue #2 (`xxyjoel/ba-mission-control`)** — inbound localhost webhook
  for watcher-style sessions. Marked `human_checkpoint:true` (touches
  no-HTTP-server non-goal — explicit gate before implementing).
- **Recipe tests hang** — `tests/recipes/*.test.jsx` use node-pty and
  appear to hang in headless harnesses. `npm test` currently times out
  on these; targeted runs (`npx tsx --test tests/X.test.jsx`) work.
  Worth a separate task to isolate or skip-by-default.
- **Zoom follow-ups A–E** — `.claude/plans/zoom-followups.md`: bracketed
  paste, resize verification, event-driven render perf, live-tail edge
  cases, capability audit (OSC 8 / OSC 52 / alt-screen / mouse). Plan
  exists; tasks not yet broken out.
- Run `forge-logging-architect` against this TUI to define happy/sad
  heuristics — needed before `/forge-improve` produces useful output.

## Known gotchas

- `~/.claude/forge/install.sh` does NOT auto-merge JSON settings —
  intentional, to avoid clobbering user settings. JSON merges by hand.
- Forge's `pre-commit` hook enforces 5 files / 200 LOC max. Override with
  `FORGE_SKIP=1 git commit` (logged to `tasks/archive/_overrides.log`).
- Forge's `pre-push` hook runs the project test command — `npm test` for
  this repo. Tests must pass.
- TUI requires real TTY; `npm test` does not exercise the TUI surface.
  Forge's testing agent will recognize this and use `tests/` (fleet/agent
  mock replay) as the verification path.
- The forge-energy-profiler needs macOS `powermetrics` (sudo) for true
  millijoule reads; falls back to derived estimates without elevated
  privileges.

## Next session

Pick one:
1. `/forge-goal "harden mission-control for daily-driver use"` to exercise
   the full pipeline on this repo
2. `/forge-status` to inspect the registry (currently empty)
3. `/forge-port <dest>` to bundle forge for another machine
