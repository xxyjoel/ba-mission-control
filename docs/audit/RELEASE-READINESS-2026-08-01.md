# Release Readiness — ba-mission-control (2026-08-01)

**Verdict: still NO-GO, but the code blockers are cleared.** A full vhs-driven
feature sweep (5 parallel groups, isolated config dirs, real app under `MC_MOCK`)
plus the 2026-07-30 audits surfaced 1 HIGH destructive bug, 1 HIGH usability bug,
and a not-live install path. **B1, B2, M2, M3 are now FIXED + vhs-verified
(2026-08-01)** — see below. What still blocks GO: **B3 (npm not published — needs
maintainer creds)**, the **live-`claude` re-zoom/status check** (mock can't cover
it), and the remaining MED items (M1 header clip, M4 bypassPerm indicator, M5
shell-0353, M6 security) + cosmetics.

## FIXED + verified 2026-08-01 (branch: forge/stabilization/release-blockers)
- **B1** — `:kill` out-of-range now REJECTED (pure `tui/lib/killTarget.js`,
  8 unit tests); `:kill !99` no longer kills the focused session. vhs-confirmed:
  toast "slot out of range", session survives.
- **M3** — `:kill!` verb form now works as a force-kill (same helper). vhs: "killed slot 1".
- **M2** — aggregate spark uses real `lastTokRate` (0 at idle) + seeds `0`; idle
  fleet now shows blank spark, not a full block. vhs: boot shows "fleet 0 t/min"
  with no block. (Per-card 0.5 decorative floor left as-is — intentional + tested.)
- **B2** — Help modal now renders a fixed-height, `overflow:hidden`, scrollable
  window (↑↓/PgUp·PgDn/g·G + position indicator). vhs-confirmed clean at 760px
  AND 520px (no overlap; scroll reveals all 79 lines). 68/68 tests pass.

Method: `vhs` 0.11 drove the real TUI; every state was screenshotted and read.
Screenshots under `scratchpad/vhs-g{1..5}/`. Command toasts were cross-checked
against `tui/App.jsx runCommand`.

---

## BLOCKERS (must fix before prod / before pointing install links at it)

### B1 — `:kill` destroys the WRONG (focused) session on an out-of-range slot; `:kill !<n>` does it with NO confirm — HIGH, destructive, CODE-CONFIRMED
- `tui/App.jsx:856`: `const target = (n >= 1 && n <= 10) ? agents.find(a => a.slot === n) : focusedAgent;`
  — any out-of-range slot number silently falls back to the **focused** session.
- `:kill 99` → arms a kill on the focused live session (not slot 99). Contrast:
  `:goto 99` correctly rejects with "slot out of range".
- `:kill !99` → `force = arg.startsWith('!')` is true, so the confirm gate is
  bypassed → **instantly kills the focused session** ("killed slot 1", slot
  emptied). A typo'd/out-of-range number + bang irreversibly destroys the wrong
  session with no confirmation.
- Impact: silent wrong-target destruction of a live session. (Sessions are
  resumable, but the force path also omits the "saved · :forget" hint, so the
  user isn't told it's recoverable — see L-series.)
- Fix: reject out-of-range `n` explicitly (mirror `:goto`), before the
  focused-agent fallback. ~1 line.
- Evidence: `vhs-g4/D-kill99.png`, `vhs-g4/F-killbang99.png`.

### B2 — Help modal (`?`) garbles/overlaps at normal terminal heights — HIGH (usability)
- The ~65-row keymap overflows the viewport with no height cap or scroll
  (`tui/modals/Help.jsx`). At ~34 rows (a common size) whole sections drop and
  remaining rows render two strings overlaid (`session actionsnerm`,
  `check signed-in accountclear → defaults`, …). Stable, not a transient paint.
- A/B confirmed: renders cleanly only at ~65+ rows. Most real terminals are
  24–50 rows → the primary discoverability surface is unreadable for most users.
- Fix: height cap + scroll/pagination in Help.jsx.
- Evidence: `vhs-g3/help-01-open.png` (garbled) vs `help-tall-open.png` (clean).

### B3 — Install path is not live — BLOCKS "update install links/README/website"
- `@bluearch/mission-control` is **not published to npm** (E404) → `npx
  @bluearch/mission-control` 404s for every new user (task 0351, human-gated:
  needs maintainer `npm publish`). Homebrew formula has a placeholder sha256
  pinned to the wrong version. Updating install links now points users at 404s.
- Also: **Linux triggers a node-gyp source compile** (node-pty ships no Linux
  prebuild) — a supported platform with an undocumented C++-toolchain need.
- (From docs/audit/AUDIT-2026-07-30.md §3.)

---

## SHOULD-FIX before release (MED)

- **M1 — Header/aggregate/status-bar clip required segments.** At ~154 cols the
  session timer + UTC clock are pushed off-screen, the aggregate spark clips, and
  the bottom bar wraps (`SANDBOXED`→`SANDBOXE`). Worse at 80–120 cols. The header
  has more `flexShrink:0` segments than fit. (`vhs-g1/g1-boot.png`.)
- **M2 — Spark shows a solid full-height block at ZERO throughput** (idle fleet
  looks maxed). `App.jsx:109` seeds `aggSpark=Array(22).fill(1)` + `:204` floors
  at `Math.max(1,rate)`, defeating `sparkLine`'s all-zero guard
  (`tui/lib/format.js:57-64`). Affects the aggregate bar AND per-card tok/min
  bars. (`vhs-g1/g1-clock-a.png`.)
- **M3 — `:kill!<n>` (bang on the verb) is unrecognized** → `unknown command:
  kill!`; only `:kill !n` works. AND the arm-toast (`App.jsx:874`) tells the user
  to type `:kill! <slot>` — a form that errors. Self-inconsistent. (`vhs-g2/f6-killbang.png`.)
- **M4 — `bypassPermissions` has no persistent card indicator.** Switching a
  session to no-guardrails mode shows only a transient toast; the card carries no
  permanent perm-mode chip. Safety-UX gap for a security-sensitive mode.
- **M5 — Shell overlay blank on open AND after `clear` (task 0353).** Viewport is
  blank until first interaction, and `clear`/Ctrl+L re-blanks it (Ink incremental
  render desync; root-caused, fix is non-trivial — see 0353). (`vhs-g5/shell-1-open.png`, `shellclear-1-afterclear.png`.)
- **M6 — Security (from AUDIT-2026-07-30 §1):** OSC-52 clipboard escape forwarded
  from *background* agents (can overwrite the user's clipboard); `.mc/MEMORY.md`
  prompt injection is default-ON. Both MED.

## LOW / cosmetic (batch)
- `matrix` theme: fleet-log + feedback/toast panels render near-black-on-black
  (a toast you can't read). (`vhs-g4/C-theme-matrix.png`.)
- Bare model aliases rejected (`:model default opus` → "unknown model"); only
  fully-qualified ids accepted.
- `:mcp` reads only `~/.claude/.mcp.json` + `<cwd>/.mcp.json` → misleading "no MCP
  servers" when servers are configured elsewhere.
- NewSession modal: no permission selector (header comment falsely claims a
  "permission picker"); typing `~` shows "0 matches" (repo-picker lists no home
  children); force-kill omits the "saved · :forget" hint that K-confirm shows.
- Plan-window `◐` glyph jams against its numbers; Help long labels jam against key
  values; StatusBar text collides at ~107 cols; FLEET LOG header rule overlaps at
  ~20 rows; no uninstall docs (AUDIT §6).

## NEEDS A LIVE-`claude` PASS (mock cannot cover)
- **Re-zoom double-spawn (task 0337).** Re-zoom rendered clean, BUT only because
  `MockAgent` lacks `attachZoomView` (PtyPane took the `startZoomSession`
  fallback). The real single-pipeline path was NOT exercised — validate against a
  live `claude` before the gate closes.
- **resume→status-restore.** `:resume` flipped an idle/paused session to WORKING
  under mock; can't tell mock-replay-restart from a real status bug.
- Clean-machine first-run, real-session token/cost/status behavior.

---

## VERIFIED WORKING (no defects)
Boot/empty-state; populated grid + live header counters; digit/arrow/`:goto` nav
with correct highlight + no idle drift; filter dim/clear; clock/timer advance;
NewSession render + launch; all 4 mock fixtures incl. approval `AWAITING`; kill
arm+confirm with focus-slide; pause; restart/clear; model-default + perm change;
Settings/Dashboard/Broadcast/QuitConfirm render + close clean (Slack webhook
masked); zoom open/close (no ghost); shell commands + Ctrl+Q close; all 7 themes
apply coherently (except matrix log/toast contrast); ~30 `:` commands produce
correct toasts; guards reject correctly (`:cols 9`, `:goto 99`, `:model bogus`,
unknown `:xyzzy` → warn, never silent).

## Suggested fix order (fastest blockers first)
1. B1 `:kill` out-of-range guard (~1 line) — destructive, cheapest.
2. M3 `:kill!` verb parse + toast hint (small).
3. M2 spark zero-throughput (small; stop flooring at 1 / don't seed 1s).
4. B2 Help scroll/pagination (moderate).
5. M1 header overflow (moderate — segment prioritization/truncation).
6. B3 npm publish (maintainer, human-gated) + Linux prebuild/doc.
7. M4/M5/M6 + cosmetics as capacity allows.
